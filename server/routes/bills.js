import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { computeTotals, round2 } from "../../shared/totals.js";
import { CustomerIn, upsertCustomer, udharStatusFor } from "./customers.js";
import { accessEndsAt } from "../subscription.js";
import { dayRange } from "./analytics.js";
import { markOrdersBilled } from "./orders.js";
import { takeStock, putBackStock } from "../stock.js";
import { bump, hitsOf } from "../limits.js";
import bcrypt from "bcryptjs";

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

// ---------- Changing saved bills ----------
// Nothing disappears silently: every edit, delete and restore is kept on the bill and in a
// permanent one-line audit log, bill numbers are never reused, and the owner sees it the same day.
import { BIN_DAYS, FREE_CHANGE_DAYS, DELETE_REASONS, EDIT_REASONS, isOldBill } from "../../shared/billChanges.js";
export { BIN_DAYS, DELETE_REASONS, EDIT_REASONS };
const DAY = 864e5;
const Pin = z.string().regex(/^\d{4}$/).optional();

// The owner PIN (Settings › Bill safety), when set, guards every change; bills older than a week always need it.
async function checkOwnerPin(db, shop, bill, pin) {
  const old = isOldBill(bill);
  if (!shop.billPinHash && !old) return;
  if (!shop.billPinHash) throw new HttpError(403, `Bills older than ${FREE_CHANGE_DAYS} days need the owner PIN. Set one in Settings › Bill safety.`, { code: "OWNER_PIN_SETUP" });
  const key = `billpin:${shop._id}`;
  if ((await hitsOf(db, key)) >= 5) throw new HttpError(429, "Too many wrong PINs. Try again in an hour.");
  if (!pin) throw new HttpError(401, "Enter the owner PIN to change this bill.", { code: "OWNER_PIN" });
  if (!(await bcrypt.compare(pin, shop.billPinHash))) {
    await bump(db, key);
    throw new HttpError(401, "Wrong owner PIN.", { code: "OWNER_PIN" });
  }
  await db.collection("rateLimits").deleteOne({ _id: key });
}

const snapshot = (b) => ({
  items: b.items, subtotal: b.subtotal, discount: b.discount, gst: b.gst, total: b.total,
  paymentMode: b.paymentMode, paidNow: b.paidNow, creditAmount: b.creditAmount, customer: b.customer || null,
});

async function audit(db, shop, b, entry) {
  await db.collection("billAudit").insertOne({ shopId: shop._id, billId: b._id, clientId: b.clientId, billNo: b.billNo, billDate: b.createdAt, paymentMode: b.paymentMode, at: new Date(), ...entry });
}

// Per dish and size: how many more (take) and fewer (back) than before.
function itemDiff(before, after) {
  const key = (i) => `${i.itemId || i.name}|${i.variant || ""}`;
  const m = new Map();
  for (const i of before) m.set(key(i), { ...i, qty: -(i.qty || 0) + (m.get(key(i))?.qty || 0) });
  for (const i of after) m.set(key(i), { ...i, qty: (m.get(key(i))?.qty || 0) + (i.qty || 0) });
  const take = [];
  const back = [];
  for (const i of m.values()) {
    if (i.qty > 0) take.push(i);
    else if (i.qty < 0) back.push({ ...i, qty: -i.qty });
  }
  return { take, back };
}

async function findBill(db, shop, id, statuses) {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Bill not found.");
  const b = await db.collection("bills").findOne({ _id: new ObjectId(id), shopId: shop._id });
  if (!b) throw new HttpError(404, "Bill not found.");
  if (!statuses.includes(b.status)) throw new HttpError(409, b.status === "deleted" ? "This bill is in the Deleted bin. Restore it first." : "This bill was already changed. Refresh and try again.");
  return b;
}

const EditIn = z.object({
  items: BillIn.shape.items,
  discount: BillIn.shape.discount,
  gstPercent: BillIn.shape.gstPercent,
  paymentMode: BillIn.shape.paymentMode,
  customer: CustomerIn.optional(),
  paidNow: z.number().min(0).optional(),
  reason: z.enum(Object.keys(EDIT_REASONS)),
  note: z.string().trim().max(120).optional().default(""),
  pin: Pin,
});

export async function deleteBill(db, shop, user, b, { reason, note, foodMade, cancelOrders }) {
  const at = new Date();
  await db.collection("bills").updateOne(
    { _id: b._id },
    {
      $set: {
        status: "deleted", deletedAt: at, deletedBy: user.name, deleteReason: reason, deleteNote: note, foodMade,
        purgeAt: new Date(at.getTime() + BIN_DAYS * DAY), ...(!foodMade && { stockReturned: true }),
      },
    }
  );
  if (!foodMade) await putBackStock(db, shop._id, b.items, { billId: b.clientId, reason: "bill deleted" });
  if (b.orderIds?.length) {
    await db.collection("orders").updateMany(
      { shopId: shop._id, clientId: { $in: b.orderIds }, status: "billed" },
      cancelOrders
        ? { $set: { status: "rejected", rejectReason: `Bill ${b.billNo} deleted`, updatedAt: at } }
        : { $set: { status: "served", updatedAt: at }, $unset: { billedAt: "", billClientId: "" } }
    );
  }
  await audit(db, shop, b, { action: "delete", total: b.total, reason, reasonLabel: DELETE_REASONS[reason]?.label || reason, note, by: user.name, foodMade, lateCash: b.paymentMode === "cash" && at - new Date(b.createdAt) > 2 * 3600e3 });
}

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
        // Table orders the customers already paid for (confirmed by staff) come off what's left to collect.
        let prepaid = null;
        if (b.orderIds?.length) {
          const paidOrders = await db
            .collection("orders")
            .find({ shopId: shop._id, clientId: { $in: b.orderIds }, "pay.state": "paid", billClientId: { $exists: false } }, { projection: { orderNo: 1, "pay.amount": 1 } })
            .toArray();
          const amount = round2(paidOrders.reduce((sum, o) => sum + (o.pay.amount || 0), 0));
          if (amount > 0) prepaid = { amount: Math.min(amount, t.total), orderNos: paidOrders.map((o) => o.orderNo) };
        }
        const fullyPrepaid = prepaid && prepaid.amount >= t.total - 0.009;
        if (fullyPrepaid) b.paymentMode = "upi";
        const credit = b.paymentMode === "credit";
        const paidNow = credit ? round2(Math.min(Math.max(b.paidNow || 0, 0), t.total - (prepaid?.amount || 0))) : t.total;
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
          creditAmount: credit ? round2(t.total - (prepaid?.amount || 0) - paidNow) : 0,
          ...(prepaid && { prepaid }),
          ...(fullyPrepaid && { paymentConfirmedAt: new Date(), paymentConfirmedBy: "Paid with order" }),
          ...(b.customer ? { customer: { clientId: b.customer.clientId, name: b.customer.name, phone: b.customer.phone } } : {}),
          status: "paid",
        };
        if (b.customer) await upsertCustomer(db, shop._id, b.customer);
        try {
          await db.collection("bills").insertOne(doc);
          await markOrdersBilled(db, shop._id, b.orderIds, b.clientId);
          // Counter bills take stock now; table bills already did when their orders went to the kitchen.
          if (!b.orderIds?.length && b.status !== "void") await takeStock(db, shop._id, b.items, { billId: b.clientId });
          results.push({ clientId: b.clientId, ok: true });
        } catch (err) {
          if (err.code === 11000) results.push({ clientId: b.clientId, ok: true, duplicate: true });
          else throw err;
        }
      }
      return { results };
    },
    { manager: true },
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
      if (query.bin === "1") filter.status = { $in: ["deleted", "void"] };
      else filter.status = query.status || "paid";
      if (query.mode) filter.paymentMode = query.mode;
      const limit = Math.min(Number(query.limit) || 50, 5000);
      const skip = Math.max(Number(query.skip) || 0, 0);
      const bills = await db.collection("bills").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      // Udhar status (open / part paid / cleared) for credit bills.
      const ids = [...new Set(bills.filter((b) => b.paymentMode === "credit" && b.customer).map((b) => b.customer.clientId))];
      const udhar = await udharStatusFor(db, shop._id, ids);
      return { bills: bills.map((b) => ({ ...publicBill(b), udhar: udhar.get(String(b._id)) || undefined })), hasMore: bills.length === limit };
    },
    { manager: true },
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
    { manager: true },
  ],
  // Edit a saved bill: same number and date, the old version kept in its history.
  [
    "PUT",
    "/bills/:id",
    async ({ db, shop, params, body, user }) => {
      const e = EditIn.parse(body);
      const b = await findBill(db, shop, params.id, ["paid"]);
      await checkOwnerPin(db, shop, b, e.pin);
      if (e.paymentMode === "credit" && !e.customer) throw new HttpError(400, "An udhar bill needs a customer.");
      const t = computeTotals(e.items, e.discount, e.gstPercent);
      const credit = e.paymentMode === "credit";
      const paidNow = credit ? round2(Math.min(Math.max(e.paidNow || 0, 0), t.total)) : t.total;
      if (e.customer) await upsertCustomer(db, shop._id, e.customer);
      const at = new Date();
      const next = {
        items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount }) => ({ itemId, name, variant, category, qty, rate, amount })),
        itemCount: t.itemCount, subtotal: t.subtotal, discount: t.discount, gst: t.gst, total: t.total,
        paymentMode: e.paymentMode, paidNow, creditAmount: round2(t.total - paidNow),
        customer: e.customer ? { clientId: e.customer.clientId, name: e.customer.name, phone: e.customer.phone } : null,
        editedAt: at, editedBy: user.name,
      };
      const updated = await db.collection("bills").findOneAndUpdate(
        { _id: b._id, status: "paid" },
        { $set: next, $push: { revisions: { at, by: user.name, action: "edit", reason: e.reason, reasonLabel: EDIT_REASONS[e.reason], note: e.note, before: snapshot(b) } } },
        { returnDocument: "after" }
      );
      if (!updated) throw new HttpError(409, "This bill was already changed. Refresh and try again.");
      // Stock moves by the difference only.
      const { take, back } = itemDiff(b.items, next.items);
      if (take.length) await takeStock(db, shop._id, take, { billId: b.clientId, reason: "bill edited" });
      if (back.length) await putBackStock(db, shop._id, back, { billId: b.clientId, reason: "bill edited" });
      await audit(db, shop, b, { action: "edit", total: t.total, before: b.total, reason: e.reason, reasonLabel: EDIT_REASONS[e.reason], note: e.note, by: user.name });
      return publicBill(updated);
    },
    { manager: true },
  ],
  // Delete into the bin (kept 30 days, never counted in sales).
  [
    "POST",
    "/bills/:id/delete",
    async ({ db, shop, params, body, user }) => {
      const d = z
        .object({
          reason: z.enum(Object.keys(DELETE_REASONS)),
          note: z.string().trim().max(120).optional().default(""),
          foodMade: z.boolean().optional(),
          cancelOrders: z.boolean().optional().default(false),
          pin: Pin,
        })
        .parse(body || {});
      if (d.reason === "other" && d.note.length < 3) throw new HttpError(400, "Please write why this bill is deleted.");
      const b = await findBill(db, shop, params.id, ["paid"]);
      await checkOwnerPin(db, shop, b, d.pin);
      await deleteBill(db, shop, user, b, { ...d, foodMade: d.foodMade ?? DELETE_REASONS[d.reason].foodMade });
      return publicBill(await db.collection("bills").findOne({ _id: b._id }));
    },
    { manager: true },
  ],
  // Older app versions: "void" is a delete with the reason written in.
  [
    "POST",
    "/bills/:id/void",
    async ({ db, shop, params, body, user }) => {
      const { reason } = z.object({ reason: z.string().trim().min(2, "please give a reason").max(120) }).parse(body);
      const b = await findBill(db, shop, params.id, ["paid"]);
      await checkOwnerPin(db, shop, b, body?.pin);
      await deleteBill(db, shop, user, b, { reason: "other", note: reason, foodMade: true, cancelOrders: false });
      return publicBill(await db.collection("bills").findOne({ _id: b._id }));
    },
    { manager: true },
  ],
  // Back from the bin: counted again, marked restored, stock taken again if it was put back.
  [
    "POST",
    "/bills/:id/restore",
    async ({ db, shop, params, body, user }) => {
      const { pin } = z.object({ pin: Pin }).parse(body || {});
      const b = await findBill(db, shop, params.id, ["deleted", "void"]);
      await checkOwnerPin(db, shop, b, pin);
      const at = new Date();
      const was = b.status === "void" ? `voided: ${b.voidReason || ""}` : `${DELETE_REASONS[b.deleteReason]?.label || b.deleteReason}${b.deleteNote ? ` (${b.deleteNote})` : ""}`;
      await db.collection("bills").updateOne(
        { _id: b._id },
        {
          $set: { status: "paid", restoredAt: at, restoredBy: user.name, editedAt: at, editedBy: user.name },
          $unset: { purgeAt: "", stockReturned: "" },
          $push: { revisions: { at, by: user.name, action: "restore", reason: "restore", reasonLabel: "Restored from the Deleted bin", note: `Was deleted: ${was}`, before: snapshot(b) } },
        }
      );
      if (b.stockReturned) await takeStock(db, shop._id, b.items, { billId: b.clientId, reason: "bill restored" });
      if (b.orderIds?.length) {
        await db.collection("orders").updateMany(
          { shopId: shop._id, clientId: { $in: b.orderIds }, status: "served" },
          { $set: { status: "billed", billedAt: at, billClientId: b.clientId, updatedAt: at } }
        );
      }
      await audit(db, shop, b, { action: "restore", total: b.total, reason: "restore", reasonLabel: "Restored", note: was, by: user.name });
      return publicBill(await db.collection("bills").findOne({ _id: b._id }));
    },
    { manager: true },
  ],
  // Edits and deletes in a period, for the dashboard card, alerts and the morning email.
  [
    "GET",
    "/bills/changes",
    async ({ db, shop, query }) => {
      const { start, end } = dayRange(query.from, query.to);
      return billChanges(db, shop._id, start, end);
    },
  ],
];

export async function billChanges(db, shopId, start, end) {
  const list = await db.collection("billAudit").find({ shopId, at: { $gte: start, $lt: end } }).sort({ at: -1 }).limit(200).toArray();
  const deletes = list.filter((x) => x.action === "delete");
  const nopay = deletes.filter((x) => x.reason === "nopay").length;
  const flags = [
    ...deletes.filter((x) => x.lateCash).map((x) => `Cash bill ${x.billNo} (₹${x.total}) deleted more than 2 hours after it was made`),
    ...(nopay > 2 ? [`"Payment not received" used ${nopay} times`] : []),
  ];
  return {
    edited: list.filter((x) => x.action === "edit").length,
    deleted: deletes.length,
    deletedAmount: round2(deletes.reduce((s, x) => s + (x.total || 0), 0)),
    restored: list.filter((x) => x.action === "restore").length,
    flags,
    items: list.slice(0, 50).map(({ _id, shopId: _s, billId, ...x }) => ({ ...x, id: String(_id), billId: String(billId) })),
  };
}
