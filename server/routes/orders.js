// Table orders and kitchen tickets (KOT).
// - Customers scan a table's QR code and order from the public menu (paid plans only);
//   those orders wait for staff to accept them.
// - Staff can also take an order for a table; it goes straight to the kitchen. Staff orders
//   are created on the device first (works offline) and uploaded with a client id.
// - A table's orders are paid together: the bill lists their client ids, and when it
//   uploads the orders are marked billed.
import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http.js";
import { round2 } from "../../shared/totals.js";
import { isAdminEmail } from "../auth.js";
import { subscriptionStatus, hasPaidFeatures } from "../subscription.js";
import { rateLimit, clientIp } from "../limits.js";
import { refreshDailyStock, takeStock, checkAvailable } from "../stock.js";

export const STATUSES = ["new", "accepted", "preparing", "ready", "served", "billed", "rejected"];
export const OPEN = ["new", "accepted", "preparing", "ready", "served"];
const MAX_LINES = 60;

const TZ_OFFSET = 5.5 * 3600e3;
const ymd = (d = new Date()) => new Date(d.getTime() + TZ_OFFSET).toISOString().slice(0, 10);

const LineIn = z.object({
  itemId: z.string().max(40),
  variant: z.string().trim().max(20).optional().default(""),
  qty: z.number().int().min(1).max(99),
  note: z.string().trim().max(80).optional().default(""),
});

// Staff order (created on a device, possibly offline). Prices come from the device's menu.
const StaffOrderIn = z.object({
  clientId: z.string().uuid(),
  orderNo: z.string().trim().min(1).max(12),
  table: z.string().trim().min(1).max(20),
  tableName: z.string().trim().max(30).optional().default(""),
  note: z.string().trim().max(160).optional().default(""),
  createdAt: z.coerce.date(),
  status: z.enum(["accepted", "preparing", "ready", "served"]).default("accepted"),
  items: z
    .array(
      z.object({
        itemId: z.string().max(40).optional().default(""),
        name: z.string().trim().min(1).max(60),
        variant: z.string().trim().max(20).optional().default(""),
        category: z.string().trim().max(30).optional().default(""),
        qty: z.number().int().min(1).max(99),
        rate: z.number().min(0).max(1000000),
        note: z.string().trim().max(80).optional().default(""),
      })
    )
    .min(1)
    .max(MAX_LINES),
});

export function publicOrder({ _id, shopId, customerKey, ...o }) {
  return { ...o, id: String(_id) };
}

const tablesOf = (shop) => (Array.isArray(shop.tables) ? shop.tables : []);
const tableById = (shop, id) => tablesOf(shop).find((t) => t.id === id);

async function shopByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token || "")) throw new HttpError(404, "This QR code isn't valid any more. Please ask the staff.");
  const shop = await db.collection("shops").findOne({ orderToken: token }, { projection: { qrImage: 0 } });
  if (!shop) throw new HttpError(404, "This QR code isn't valid any more. Please ask the staff.");
  return shop;
}

// Whether customers can order from this shop right now.
async function orderingState(db, shop) {
  if (shop.blocked) return { open: false, reason: "Ordering is closed right now. Please ask the staff." };
  if (!shop.qrOrdering) return { open: false, reason: "QR ordering is turned off. Please order with the staff." };
  const owner = await db.collection("users").findOne({ shopId: shop._id }, { projection: { email: 1 } });
  const status = subscriptionStatus(shop, { isAdmin: !!owner && isAdminEmail(owner.email) });
  if (!hasPaidFeatures(status)) return { open: false, reason: "Ordering from the table isn't available yet. Please order with the staff." };
  return { open: true };
}

// Q1, Q2, … per shop per day (India time).
async function nextQrNumber(db, shopId) {
  const day = ymd();
  const r = await db.collection("counters").findOneAndUpdate(
    { _id: `orders:${shopId}:${day}` },
    { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 3 * 864e5) } },
    { upsert: true, returnDocument: "after" }
  );
  return `Q${r.n}`;
}

const priceLines = (menuById, lines) =>
  lines.map((l) => {
    const item = menuById.get(l.itemId);
    if (!item || item.active === false) throw new HttpError(400, "Some items are no longer on the menu. Please refresh the menu.");
    const v = item.variants.find((x) => (x.label || "") === (l.variant || "")) || (item.variants.length === 1 ? item.variants[0] : null);
    if (!v) throw new HttpError(400, `Please choose a size for ${item.name}.`);
    return { itemId: String(item._id), name: item.name, variant: v.label || "", category: item.category || "", qty: l.qty, rate: v.price, note: l.note || "" };
  });

// The customer's own order, checked with the key their phone got when ordering.
async function customerOrder(db, shop, id, key) {
  const o = await db.collection("orders").findOne({ shopId: shop._id, clientId: String(id || "") });
  if (!o || !key || key !== o.customerKey) throw new HttpError(404, "Order not found.");
  return o;
}

export const orderTotal = (items) => round2(items.reduce((s, i) => s + i.qty * i.rate, 0));

export default [
  // ---------- Public: the customer's phone after scanning a table QR ----------
  [
    "GET",
    "/public/shop/:token",
    async ({ db, params }) => {
      const shop = await shopByToken(db, params.token);
      const state = await orderingState(db, shop);
      await refreshDailyStock(db, shop._id);
      // Sold-out dishes are not shown to customers.
      const menu = await db.collection("menuItems").find({ shopId: shop._id, active: { $ne: false }, soldOut: { $ne: true } }).sort({ sort: 1 }).toArray();
      return {
        shop: { name: shop.name, logo: shop.logo || "", currency: shop.currency || "₹", address: shop.address || "" },
        tables: tablesOf(shop).map(({ id, name }) => ({ id, name })),
        ordering: state,
        menu: menu.map((m) => ({
          id: String(m._id),
          name: m.name,
          category: m.category || "Other",
          note: m.note || "",
          variants: m.variants,
          image: m.image || "",
          ...(typeof m.stock === "number" && m.stock <= 10 && { left: m.stock }),
        })),
      };
    },
    { auth: false },
  ],
  [
    "POST",
    "/public/shop/:token/orders",
    async ({ db, params, body, req }) => {
      const shop = await shopByToken(db, params.token);
      const input = z
        .object({
          table: z.string().max(20),
          items: z.array(LineIn).min(1, "add at least one item").max(MAX_LINES),
          note: z.string().trim().max(160).optional().default(""),
          name: z.string().trim().max(40).optional().default(""),
        })
        .parse(body);
      const state = await orderingState(db, shop);
      if (!state.open) throw new HttpError(403, state.reason);
      const table = tableById(shop, input.table);
      if (!table) throw new HttpError(400, "This table isn't set up. Please ask the staff.");
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `qr-order:ip:${ip}`, 30, "Too many orders from this phone. Please ask the staff.");
      await rateLimit(db, `qr-order:table:${shop._id}:${table.id}`, 25, "This table has sent many orders. Please ask the staff.");

      await refreshDailyStock(db, shop._id);
      const menu = await db.collection("menuItems").find({ shopId: shop._id }).toArray();
      const menuById = new Map(menu.map((m) => [String(m._id), m]));
      const items = priceLines(menuById, input.items);
      const stockProblem = checkAvailable(menuById, items);
      if (stockProblem) throw new HttpError(409, stockProblem, { code: "STOCK" });
      const now = new Date();
      const doc = {
        shopId: shop._id,
        clientId: crypto.randomUUID(),
        orderNo: await nextQrNumber(db, shop._id),
        source: "qr",
        table: table.id,
        tableName: table.name,
        customerName: input.name,
        note: input.note,
        items,
        total: orderTotal(items),
        status: "new",
        customerKey: crypto.randomBytes(12).toString("base64url"),
        createdAt: now,
        updatedAt: now,
      };
      doc._id = (await db.collection("orders").insertOne(doc)).insertedId;
      return { orderId: doc.clientId, key: doc.customerKey, orderNo: doc.orderNo, total: doc.total, status: doc.status };
    },
    { auth: false },
  ],
  // The customer's order status (needs the key returned when ordering).
  [
    "GET",
    "/public/shop/:token/orders/:id",
    async ({ db, params, query }) => {
      const shop = await shopByToken(db, params.token);
      const o = await customerOrder(db, shop, params.id, query.k);
      const bill = o.billClientId ? await db.collection("bills").findOne({ shopId: shop._id, clientId: o.billClientId }) : null;
      return {
        orderNo: o.orderNo,
        tableName: o.tableName,
        status: o.status,
        reason: o.rejectReason || "",
        items: o.items,
        total: o.total,
        createdAt: o.createdAt,
        billRequest: o.billRequest || null,
        upi: shop.upiId ? { id: shop.upiId, name: shop.name } : null,
        bill: bill && {
          id: bill.clientId,
          billNo: bill.billNo,
          items: bill.items.map(({ name, variant, qty, rate, amount }) => ({ name, variant, qty, rate, amount })),
          subtotal: bill.subtotal,
          discount: bill.discount,
          gst: bill.gst,
          total: bill.total,
          paymentMode: bill.paymentMode,
          status: bill.status,
          customerPaid: !!bill.customerPaid,
          paymentConfirmed: !!bill.paymentConfirmedAt,
          createdAt: bill.createdAt,
        },
      };
    },
    { auth: false },
  ],

  // The customer asks for the bill and says how they'll pay.
  [
    "POST",
    "/public/shop/:token/bill-request",
    async ({ db, params, body }) => {
      const shop = await shopByToken(db, params.token);
      const { orderId, key, method } = z.object({ orderId: z.string(), key: z.string(), method: z.enum(["upi", "counter"]) }).parse(body);
      const o = await customerOrder(db, shop, orderId, key);
      if (method === "upi" && !shop.upiId) throw new HttpError(400, "Online payment isn't set up here. Please pay at the counter.");
      const billRequest = { method, at: new Date() };
      const { modifiedCount } = await db
        .collection("orders")
        .updateMany({ shopId: shop._id, table: o.table, status: { $in: OPEN.filter((s) => s !== "new") } }, { $set: { billRequest, updatedAt: new Date() } });
      if (!modifiedCount) throw new HttpError(400, "There's nothing to bill yet. Please wait until your order is in the kitchen.");
      return { ok: true, billRequest };
    },
    { auth: false },
  ],
  // The customer says they've paid the bill by UPI; staff confirm it.
  [
    "POST",
    "/public/shop/:token/bills/:billId/paid",
    async ({ db, params, body }) => {
      const shop = await shopByToken(db, params.token);
      const { orderId, key, utr } = z
        .object({ orderId: z.string(), key: z.string(), utr: z.string().trim().max(30).optional().default("") })
        .parse(body);
      const o = await customerOrder(db, shop, orderId, key);
      if (o.billClientId !== params.billId) throw new HttpError(404, "Bill not found.");
      const r = await db
        .collection("bills")
        .updateOne({ shopId: shop._id, clientId: params.billId, paymentConfirmedAt: { $exists: false } }, { $set: { customerPaid: { at: new Date(), utr } } });
      if (!r.matchedCount) return { ok: true, alreadyConfirmed: true };
      return { ok: true };
    },
    { auth: false },
  ],

  // ---------- Staff ----------
  // Open orders (and those closed in the last 12 hours), newest last.
  [
    "GET",
    "/orders",
    async ({ db, shop }) => {
      const since = new Date(Date.now() - 12 * 3600e3);
      const list = await db
        .collection("orders")
        .find({ shopId: shop._id, $or: [{ status: { $in: OPEN } }, { updatedAt: { $gte: since } }] })
        .sort({ createdAt: 1 })
        .limit(400)
        .toArray();
      const claims = await db
        .collection("bills")
        .find({ shopId: shop._id, customerPaid: { $exists: true }, paymentConfirmedAt: { $exists: false }, createdAt: { $gte: new Date(Date.now() - 2 * 864e5) } })
        .project({ clientId: 1, billNo: 1, table: 1, total: 1, customerPaid: 1, paymentMode: 1 })
        .toArray();
      return {
        orders: list.map(publicOrder),
        paymentClaims: claims.map(({ _id, ...b }) => ({ ...b, id: String(_id) })),
        serverTime: new Date(),
      };
    },
    { kitchen: true },
  ],
  // Just the count of QR orders waiting, for the badge and sound on every screen.
  ["GET", "/orders/summary", async ({ db, shop }) => ({ waiting: await db.collection("orders").countDocuments({ shopId: shop._id, status: "new" }) }), { kitchen: true }],
  // Staff orders from the device queue (idempotent by clientId).
  [
    "POST",
    "/orders",
    async ({ db, shop, status, body }) => {
      if (!status.active) throw new HttpError(402, "Your plan has ended. Renew to keep taking orders.");
      const list = z.object({ orders: z.array(z.unknown()).min(1).max(50) }).parse(body).orders;
      const results = [];
      for (const raw of list) {
        const p = StaffOrderIn.safeParse(raw);
        if (!p.success) {
          results.push({ clientId: raw?.clientId, ok: false, error: p.error.issues[0]?.message || "Invalid order" });
          continue;
        }
        const o = p.data;
        const now = new Date();
        try {
          await db.collection("orders").insertOne({
            shopId: shop._id,
            ...o,
            createdAt: new Date(Math.min(o.createdAt.getTime(), now.getTime() + 5 * 60e3)),
            source: "staff",
            total: orderTotal(o.items),
            acceptedAt: o.createdAt,
            updatedAt: now,
          });
          await takeStock(db, shop._id, o.items, { orderId: o.clientId });
          results.push({ clientId: o.clientId, ok: true });
        } catch (err) {
          if (err.code === 11000) results.push({ clientId: o.clientId, ok: true, duplicate: true });
          else throw err;
        }
      }
      return { results };
    },
    { kitchen: true },
  ],
  [
    "POST",
    "/orders/:id/status",
    async ({ db, shop, params, body, user }) => {
      const { status, reason } = z
        .object({ status: z.enum(["accepted", "preparing", "ready", "served", "rejected"]), reason: z.string().trim().max(120).optional().default("") })
        .parse(body);
      const allowedFrom = {
        accepted: ["new"],
        rejected: ["new", "accepted"],
        preparing: ["accepted", "ready"],
        ready: ["accepted", "preparing", "served"],
        served: ["accepted", "preparing", "ready"],
      }[status];
      const now = new Date();
      const o = await db.collection("orders").findOneAndUpdate(
        { shopId: shop._id, clientId: params.id, status: { $in: allowedFrom } },
        { $set: { status, updatedAt: now, [`${status}At`]: now, [`${status}By`]: user.name, ...(status === "rejected" && { rejectReason: reason }) } },
        { returnDocument: "after" }
      );
      if (o && status === "accepted") await takeStock(db, shop._id, o.items, { orderId: o.clientId });
      if (!o) {
        const cur = await db.collection("orders").findOne({ shopId: shop._id, clientId: params.id }, { projection: { status: 1 } });
        if (!cur) throw new HttpError(404, "Order not found.");
        throw new HttpError(409, `This order is already ${cur.status}.`, { order: cur.status });
      }
      return publicOrder(o);
    },
    { kitchen: true },
  ],
];

// Called when a bill uploads: its table orders are now paid.
export async function markOrdersBilled(db, shopId, orderIds, billClientId) {
  if (!orderIds?.length) return;
  await db.collection("orders").updateMany(
    { shopId, clientId: { $in: orderIds }, status: { $in: OPEN } },
    { $set: { status: "billed", billedAt: new Date(), billClientId, updatedAt: new Date() } }
  );
}
