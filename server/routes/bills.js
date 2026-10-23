import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { computeTotals, round2 } from "../../shared/totals.js";
import { CustomerIn, upsertCustomer, udharStatusFor } from "./customers.js";
import { accessEndsAt } from "../subscription.js";
import { dayRange } from "./analytics.js";
import { markOrdersBilled } from "./orders.js";
import { takeStock } from "../stock.js";

const BillIn = z.object({
  clientId: z.string().uuid(),
  billNo: z.string().trim().min(1).max(20),
  deviceCode: z.string().trim().max(4).default(""),
  createdAt: z.coerce.date(),
  items: z
    .array(
      z.object({
        itemId: z.string().max(40).optional().default(""),
        name: z.string().trim().min(1).max(60),
        variant: z.string().trim().max(20).optional().default(""),
        category: z.string().trim().max(30).optional().default(""),
        qty: z.number().int().positive().max(10000),
        rate: z.number().min(0).max(1000000),
      })
    )
    .min(1)
    .max(300),
  discount: z.object({ type: z.enum(["percent", "flat"]), value: z.number().min(0) }).default({ type: "percent", value: 0 }),
  gstPercent: z.number().min(0).max(100).default(0),
  paymentMode: z.enum(["cash", "upi", "card", "credit"]).default("cash"),
  // Udhar: who owes it, and how much was paid at the counter.
  customer: CustomerIn.optional(),
  paidNow: z.number().min(0).optional(),
  // A bill entered later for a past day (e.g. forgot to bill yesterday).
  backdated: z.boolean().optional(),
  // Billing a table: which table, and the orders this bill pays for.
  table: z.string().trim().max(30).optional(),
  orderIds: z.array(z.string().uuid()).max(100).optional(),
});

export const MAX_BACKDATE_DAYS = 90;

export function publicBill({ _id, shopId, ...b }) {
  return { ...b, id: String(_id) };
}

export default [
  // Batch upload from the offline queue. Each bill is accepted or rejected on its own.
  [
    "POST",
    "/bills",
    async ({ db, shop, status, body }) => {
      const list = z.object({ bills: z.array(z.unknown()).min(1).max(100) }).parse(body).bills;
      const accessEnd = accessEndsAt(shop);
      const results = [];

      for (const raw of list) {
        const parsed = BillIn.safeParse(raw);
        if (!parsed.success) {
          results.push({ clientId: raw?.clientId, ok: false, code: 400, error: parsed.error.issues[0]?.message || "Invalid bill" });
          continue;
        }
        const b = parsed.data;
        // Don't trust device clocks that run ahead.
        const createdAt = new Date(Math.min(b.createdAt.getTime(), Date.now() + 5 * 60 * 1000));

        if (b.backdated && Date.now() - createdAt > (MAX_BACKDATE_DAYS + 1) * 864e5) {
          results.push({ clientId: b.clientId, ok: false, code: 400, error: `Bills can be added for up to ${MAX_BACKDATE_DAYS} days back.` });
          continue;
        }
        // Bills made before the plan ran out (e.g. saved offline) are still accepted,
        // but past-dated bills can't be added once it has ended.
        if (!status.active && (createdAt > accessEnd || b.backdated)) {
          results.push({ clientId: b.clientId, ok: false, code: 402, error: "Your plan has ended. Renew to keep billing." });
          continue;
        }

        if (b.paymentMode === "credit" && !b.customer) {
          results.push({ clientId: b.clientId, ok: false, code: 400, error: "An udhar bill needs a customer." });
          continue;
        }
        const t = computeTotals(b.items, b.discount, b.gstPercent);
        const credit = b.paymentMode === "credit";
        const paidNow = credit ? round2(Math.min(Math.max(b.paidNow || 0, 0), t.total)) : t.total;
        const doc = {
          shopId: shop._id,
          clientId: b.clientId,
          billNo: b.billNo,
          deviceCode: b.deviceCode,
          createdAt,
          syncedAt: new Date(),
          ...(b.backdated ? { backdated: true, enteredAt: new Date() } : {}),
          ...(b.table ? { table: b.table } : {}),
          ...(b.orderIds?.length ? { orderIds: b.orderIds } : {}),
          items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount }) => ({ itemId, name, variant, category, qty, rate, amount })),
          itemCount: t.itemCount,
          subtotal: t.subtotal,
          discount: t.discount,
          gst: t.gst,
          total: t.total,
          paymentMode: b.paymentMode,
          paidNow,
          creditAmount: round2(t.total - paidNow),
          ...(b.customer ? { customer: { clientId: b.customer.clientId, name: b.customer.name, phone: b.customer.phone } } : {}),
          status: "paid",
        };
        if (b.customer) await upsertCustomer(db, shop._id, b.customer);
        try {
          await db.collection("bills").insertOne(doc);
          await markOrdersBilled(db, shop._id, b.orderIds, b.clientId);
          // Counter bills take stock now; table bills already did when their orders went to the kitchen.
          if (!b.orderIds?.length && b.status !== "void") await takeStock(db, shop._id, b.items);
          results.push({ clientId: b.clientId, ok: true });
        } catch (err) {
          if (err.code === 11000) results.push({ clientId: b.clientId, ok: true, duplicate: true });
          else throw err;
        }
      }
      return { results };
    },
  ],
  [
    "GET",
    "/bills",
    async ({ db, shop, query }) => {
      const filter = { shopId: shop._id };
      if (query.from || query.to) {
        const { start, end } = dayRange(query.from, query.to);
        filter.createdAt = { $gte: start, $lt: end };
      }
      if (query.q) filter.billNo = { $regex: "^" + query.q.replace(/[^A-Za-z0-9-]/g, ""), $options: "i" };
      if (query.status) filter.status = query.status;
      if (query.mode) filter.paymentMode = query.mode;
      const limit = Math.min(Number(query.limit) || 50, 5000);
      const skip = Math.max(Number(query.skip) || 0, 0);
      const bills = await db.collection("bills").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      // Udhar status (open / part paid / cleared) for credit bills.
      const ids = [...new Set(bills.filter((b) => b.paymentMode === "credit" && b.customer).map((b) => b.customer.clientId))];
      const udhar = await udharStatusFor(db, shop._id, ids);
      return { bills: bills.map((b) => ({ ...publicBill(b), udhar: udhar.get(String(b._id)) || undefined })), hasMore: bills.length === limit };
    },
  ],
  // Staff confirm a customer's UPI payment (or record how a table paid). :id is the bill's client id.
  [
    "POST",
    "/bills/:id/confirm-payment",
    async ({ db, shop, params, body, user }) => {
      const { mode } = z.object({ mode: z.enum(["cash", "upi", "card"]).optional() }).parse(body || {});
      const b = await db.collection("bills").findOneAndUpdate(
        { shopId: shop._id, clientId: params.id },
        { $set: { paymentConfirmedAt: new Date(), paymentConfirmedBy: user.name, ...(mode && { paymentMode: mode }) } },
        { returnDocument: "after" }
      );
      if (!b) throw new HttpError(404, "Bill not found.");
      return publicBill(b);
    },
  ],
  [
    "POST",
    "/bills/:id/void",
    async ({ db, shop, params, body, user }) => {
      const { reason } = z.object({ reason: z.string().trim().min(2, "please give a reason").max(120) }).parse(body);
      if (!ObjectId.isValid(params.id)) throw new HttpError(404, "Bill not found.");
      const updated = await db
        .collection("bills")
        .findOneAndUpdate(
          { _id: new ObjectId(params.id), shopId: shop._id, status: "paid" },
          { $set: { status: "void", voidReason: reason, voidedAt: new Date(), voidedBy: user.name } },
          { returnDocument: "after" }
        );
      if (!updated) throw new HttpError(404, "Bill not found or already void.");
      return publicBill(updated);
    },
  ],
];
