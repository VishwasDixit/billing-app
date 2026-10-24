import crypto from "node:crypto";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { round2 } from "../../shared/totals.js";
import { LANGUAGE_CODES } from "../../shared/messages.js";

// Udhar (credit) accounts. A customer's due is never stored: it is
// Σ creditAmount of their non-void credit bills − Σ their payments.

export const CustomerIn = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, "enter the customer's name").max(60),
  phone: z
    .string()
    .trim()
    .max(15)
    .refine((p) => p === "" || /^[0-9+\- ]{10,15}$/.test(p), "enter a 10-digit phone number")
    .optional()
    .default(""),
  address: z.string().trim().max(160).optional().default(""),
  note: z.string().trim().max(160).optional().default(""),
  // "" = use the shop's reminder language
  language: z.enum(["", ...LANGUAGE_CODES]).optional().default(""),
});

const PaymentIn = z.object({
  amount: z.number().positive("amount must be more than 0").max(10000000),
  mode: z.enum(["cash", "upi", "card", "bank"]).default("cash"),
  note: z.string().trim().max(120).optional().default(""),
});

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Customer not found.");
  return new ObjectId(id);
};

// Indian mobile numbers: 10 digits starting 6–9 (a leading +91 / 0 / spaces are dropped).
export const cleanMobile = (p) => {
  const d = String(p || "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};

// The customer with this mobile number, or a new one (QR orders and order bills).
export async function upsertCustomerByPhone(db, shopId, { name, phone }) {
  const found = await db.collection("customers").findOne({ shopId, phone: { $in: [phone, `+91${phone}`, `+91 ${phone}`, `0${phone}`] } });
  if (found) return { clientId: found.clientId, name: found.name, phone: found.phone };
  // phoneKey is unique per shop, so two orders from one number at the same moment make one customer.
  const now = new Date();
  const c = { clientId: crypto.randomUUID(), name, phone };
  try {
    const r = await db.collection("customers").findOneAndUpdate(
      { shopId, phoneKey: phone },
      { $setOnInsert: { shopId, ...c, phoneKey: phone, address: "", note: "", language: "", createdAt: now } },
      { upsert: true, returnDocument: "after" }
    );
    return { clientId: r.clientId, name: r.name, phone: r.phone };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const r = await db.collection("customers").findOne({ shopId, phoneKey: phone });
    return { clientId: r.clientId, name: r.name, phone: r.phone };
  }
}

// Creates the customer the first time a device sends it (offline-safe), never overwriting later edits.
export async function upsertCustomer(db, shopId, c) {
  const now = new Date();
  await db.collection("customers").updateOne(
    { shopId, clientId: c.clientId },
    { $setOnInsert: { shopId, clientId: c.clientId, name: c.name, phone: c.phone || "", address: c.address || "", note: c.note || "", language: c.language || "", createdAt: now } },
    { upsert: true }
  );
}

// { clientId: { credit, lastBillAt } } and { clientId: { paid, lastPaymentAt } }
async function balances(db, shopId, clientIds) {
  const match = { shopId, paymentMode: "credit", status: "paid" };
  const pmatch = { shopId };
  if (clientIds) {
    match["customer.clientId"] = { $in: clientIds };
    pmatch.customerClientId = { $in: clientIds };
  }
  const [credit, paid] = await Promise.all([
    db.collection("bills").aggregate([{ $match: match }, { $group: { _id: "$customer.clientId", credit: { $sum: "$creditAmount" }, lastBillAt: { $max: "$createdAt" } } }]).toArray(),
    db.collection("customerPayments").aggregate([{ $match: pmatch }, { $group: { _id: "$customerClientId", paid: { $sum: "$amount" }, lastPaymentAt: { $max: "$createdAt" } } }]).toArray(),
  ]);
  return { credit: new Map(credit.map((c) => [c._id, c])), paid: new Map(paid.map((p) => [p._id, p])) };
}

function summary(c, b) {
  const cr = b.credit.get(c.clientId);
  const pd = b.paid.get(c.clientId);
  const due = round2((cr?.credit || 0) - (pd?.paid || 0));
  return {
    id: String(c._id),
    clientId: c.clientId,
    name: c.name,
    phone: c.phone,
    address: c.address,
    note: c.note,
    language: c.language || "",
    createdAt: c.createdAt,
    lastBillAt: cr?.lastBillAt || null,
    lastPaymentAt: pd?.lastPaymentAt || null,
    lastRemindedAt: c.lastRemindedAt || null,
    due,
    settled: due <= 0,
  };
}

export async function totalOutstanding(db, shopId) {
  const b = await balances(db, shopId);
  let total = 0;
  for (const [id, c] of b.credit) total += Math.max(0, c.credit - (b.paid.get(id)?.paid || 0));
  return round2(total);
}

/**
 * Applies payments to the oldest credit bills first.
 * @returns Map billId -> { left, state: "open" | "part" | "cleared" }
 */
export function allocate(bills, totalPaid) {
  let pool = totalPaid;
  const out = new Map();
  for (const b of [...bills].sort((a, z) => a.createdAt - z.createdAt)) {
    const used = Math.min(pool, b.creditAmount);
    pool = round2(pool - used);
    const left = round2(b.creditAmount - used);
    out.set(String(b._id), { left, state: left <= 0 ? "cleared" : used > 0 ? "part" : "open" });
  }
  return out;
}

// Udhar status for credit bills (used by the Bills list and the customer ledger).
export async function udharStatusFor(db, shopId, clientIds) {
  if (!clientIds.length) return new Map();
  const [bills, b] = await Promise.all([
    db
      .collection("bills")
      .find({ shopId, paymentMode: "credit", status: "paid", "customer.clientId": { $in: clientIds } }, { projection: { createdAt: 1, creditAmount: 1, "customer.clientId": 1 } })
      .toArray(),
    balances(db, shopId, clientIds),
  ]);
  const result = new Map();
  for (const id of clientIds) {
    const mine = bills.filter((x) => x.customer.clientId === id);
    for (const [billId, st] of allocate(mine, b.paid.get(id)?.paid || 0)) result.set(billId, st);
  }
  return result;
}

async function findCustomer(db, shop, id) {
  const c = await db.collection("customers").findOne({ _id: oid(id), shopId: shop._id });
  if (!c) throw new HttpError(404, "Customer not found.");
  return c;
}

async function customerSummary(db, shop, c) {
  return summary(c, await balances(db, shop._id, [c.clientId]));
}

export default [
  [
    "GET",
    "/customers",
    async ({ db, shop, query }) => {
      const filter = { shopId: shop._id };
      const q = (query.q || "").trim();
      if (q) {
        const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ name: { $regex: safe, $options: "i" } }, { phone: { $regex: safe.replace(/\D/g, "") || safe } }];
      }
      const [list, b] = await Promise.all([db.collection("customers").find(filter).limit(2000).toArray(), balances(db, shop._id)]);
      const customers = list.map((c) => summary(c, b)).sort((a, z) => z.due - a.due || a.name.localeCompare(z.name));
      const owing = customers.filter((c) => c.due > 0);
      return { customers, totalDue: round2(owing.reduce((s, c) => s + c.due, 0)), owingCount: owing.length };
    },
    { manager: true },
  ],
  [
    "POST",
    "/customers",
    async ({ db, shop, body }) => {
      const c = CustomerIn.parse(body);
      await upsertCustomer(db, shop._id, c);
      return customerSummary(db, shop, await db.collection("customers").findOne({ shopId: shop._id, clientId: c.clientId }));
    },
    { manager: true },
  ],
  [
    "PUT",
    "/customers/:id",
    async ({ db, shop, params, body }) => {
      const c = await findCustomer(db, shop, params.id);
      const patch = CustomerIn.omit({ clientId: true }).partial().parse(body);
      const updated = await db
        .collection("customers")
        .findOneAndUpdate(
          { _id: c._id },
          // A new number: the old one is free for a new QR customer.
          { $set: { ...patch, updatedAt: new Date() }, ...(patch.phone !== undefined && patch.phone !== c.phone && { $unset: { phoneKey: "" } }) },
          { returnDocument: "after" }
        );
      return customerSummary(db, shop, updated);
    },
  ],
  [
    "GET",
    "/customers/:id",
    async ({ db, shop, params }) => {
      const c = await findCustomer(db, shop, params.id);
      const [bills, payments] = await Promise.all([
        db.collection("bills").find({ shopId: shop._id, paymentMode: "credit", "customer.clientId": c.clientId }).sort({ createdAt: 1 }).toArray(),
        db.collection("customerPayments").find({ shopId: shop._id, customerClientId: c.clientId }).sort({ createdAt: 1 }).toArray(),
      ]);
      const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
      const status = allocate(bills.filter((b) => b.status === "paid"), paidTotal);

      // Ledger: credit bills add to the due, payments reduce it.
      const entries = [
        ...bills.map((b) => ({
          type: "bill",
          id: String(b._id),
          at: b.createdAt,
          billNo: b.billNo,
          total: b.total,
          paidNow: b.paidNow || 0,
          amount: b.status === "void" ? 0 : b.creditAmount,
          void: b.status === "void",
          udhar: status.get(String(b._id)) || null,
        })),
        ...payments.map((p) => ({ type: "payment", id: String(p._id), at: p.createdAt, amount: p.amount, mode: p.mode, note: p.note })),
      ].sort((a, z) => a.at - z.at);
      let balance = 0;
      for (const e of entries) {
        balance = round2(balance + (e.type === "bill" ? e.amount : -e.amount));
        e.balance = balance;
      }
      return { customer: await customerSummary(db, shop, c), ledger: entries.reverse() };
    },
    { manager: true },
  ],
  [
    "POST",
    "/customers/:id/payments",
    async ({ db, shop, params, body }) => {
      const c = await findCustomer(db, shop, params.id);
      const p = PaymentIn.parse(body);
      await db.collection("customerPayments").insertOne({ shopId: shop._id, customerClientId: c.clientId, amount: round2(p.amount), mode: p.mode, note: p.note, createdAt: new Date() });
      return customerSummary(db, shop, c);
    },
    { manager: true },
  ],
  [
    "DELETE",
    "/customers/:id/payments/:pid",
    async ({ db, shop, params }) => {
      const c = await findCustomer(db, shop, params.id);
      if (!ObjectId.isValid(params.pid)) throw new HttpError(404, "Payment not found.");
      const { deletedCount } = await db.collection("customerPayments").deleteOne({ _id: new ObjectId(params.pid), shopId: shop._id, customerClientId: c.clientId });
      if (!deletedCount) throw new HttpError(404, "Payment not found.");
      return customerSummary(db, shop, c);
    },
  ],
  [
    "POST",
    "/customers/:id/reminded",
    async ({ db, shop, params }) => {
      const c = await findCustomer(db, shop, params.id);
      await db.collection("customers").updateOne({ _id: c._id }, { $set: { lastRemindedAt: new Date() } });
      return { ok: true };
    },
    { manager: true },
  ],
];
