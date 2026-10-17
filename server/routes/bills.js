import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { computeTotals } from "../../shared/totals.js";
import { accessEndsAt } from "../subscription.js";
import { dayRange } from "./analytics.js";

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
  paymentMode: z.enum(["cash", "upi", "card"]).default("cash"),
});

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

        // Bills made before the plan ran out (e.g. saved offline) are still accepted.
        if (!status.active && createdAt > accessEnd) {
          results.push({ clientId: b.clientId, ok: false, code: 402, error: "Your plan has ended. Renew to keep billing." });
          continue;
        }

        const t = computeTotals(b.items, b.discount, b.gstPercent);
        const doc = {
          shopId: shop._id,
          clientId: b.clientId,
          billNo: b.billNo,
          deviceCode: b.deviceCode,
          createdAt,
          syncedAt: new Date(),
          items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount }) => ({ itemId, name, variant, category, qty, rate, amount })),
          itemCount: t.itemCount,
          subtotal: t.subtotal,
          discount: t.discount,
          gst: t.gst,
          total: t.total,
          paymentMode: b.paymentMode,
          status: "paid",
        };
        try {
          await db.collection("bills").insertOne(doc);
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
      const limit = Math.min(Number(query.limit) || 50, 5000);
      const skip = Math.max(Number(query.skip) || 0, 0);
      const bills = await db.collection("bills").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      return { bills: bills.map(publicBill), hasMore: bills.length === limit };
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
