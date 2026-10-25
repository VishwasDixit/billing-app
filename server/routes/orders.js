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
import { round2, computeTotals } from "../../shared/totals.js";
import { cleanMobile, upsertCustomerByPhone } from "./customers.js";
import { deleteBill } from "./bills.js";
import { isAdminEmail } from "../auth.js";
import { subscriptionStatus, hasPaidFeatures } from "../subscription.js";
import { rateLimit, clientIp } from "../limits.js";
import { refreshDailyStock, takeStock, checkAvailable } from "../stock.js";
import { promoDiscount, reservePromo, releasePromo, menuOffers } from "./promos.js";

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
// What the customer pays for one order on its own: items plus the shop's GST.
// A promo code the customer used comes off before GST, like any discount.
const promoOff = (promo) => (promo?.amount > 0 ? { type: "flat", value: promo.amount } : { type: "percent", value: 0 });
const payableTotal = (shop, items, promo) => computeTotals(items, promoOff(promo), shop.gstPercent || 0).total;
const orderPayable = (shop, o) => payableTotal(shop, o.items, o.promo);

// A paid QR order becomes a saved bill right away (P-1, P-2, … per shop), so the books are complete
// even before the table is closed. The order already took stock when it went to the kitchen.
async function createOrderBill(db, shop, o, user) {
  if (o.billClientId) return db.collection("bills").findOne({ shopId: shop._id, clientId: o.billClientId });
  // Claim the order first, so two phones confirming at once can't make two bills.
  const clientId = crypto.randomUUID();
  const claim = await db.collection("orders").updateOne({ _id: o._id, billClientId: { $exists: false } }, { $set: { billClientId: clientId } });
  if (!claim.modifiedCount) {
    const cur = await db.collection("orders").findOne({ _id: o._id }, { projection: { billClientId: 1 } });
    return db.collection("bills").findOne({ shopId: shop._id, clientId: cur.billClientId });
  }
  const r = await db.collection("counters").findOneAndUpdate({ _id: `bills:${shop._id}:P` }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after" });
  const t = computeTotals(o.items, promoOff(o.promo), shop.gstPercent || 0);
  const now = new Date();
  const mode = o.pay?.method === "upi" ? "upi" : "cash";
  const bill = {
    shopId: shop._id,
    clientId,
    billNo: `P-${r.n}`,
    deviceCode: "P",
    createdAt: now,
    syncedAt: now,
    source: "qr",
    orderNo: o.orderNo,
    table: o.tableName || o.table,
    orderIds: [o.clientId],
    items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount }) => ({ itemId, name, variant, category, qty, rate, amount })),
    itemCount: t.itemCount,
    subtotal: t.subtotal,
    discount: t.discount,
    gst: t.gst,
    total: t.total,
    paymentMode: mode,
    paidNow: t.total,
    creditAmount: 0,
    ...(o.customer && { customer: { clientId: o.customer.clientId, name: o.customer.name, phone: o.customer.phone || "" } }),
    status: "paid",
    paymentConfirmedAt: now,
    paymentConfirmedBy: user.name,
    ...(o.promo && { promo: { code: o.promo.code, source: "qr" } }),
  };
  try {
    await db.collection("bills").insertOne(bill);
  } catch (err) {
    await db.collection("orders").updateOne({ _id: o._id, billClientId: clientId }, { $unset: { billClientId: "" } });
    throw err;
  }
  await db.collection("orders").updateOne({ _id: o._id }, { $set: { billNo: bill.billNo } });
  return bill;
}

// When QR customers pay (Settings › Tables & QR ordering):
// "end" = at the end with the bill · "choose" = pay now or at the end · "first" = pay before it's cooked.
// Order pay states: end · choose (not decided) · due (waiting for payment) · claimed (says paid by UPI)
// · paid · refundDue (paid, then the order was rejected) · refunded.
export const payRuleOf = (shop) => (["choose", "first"].includes(shop.qrPayment) ? shop.qrPayment : "end");
const initialPay = (rule, total) => ({ rule, state: rule === "first" ? "due" : rule === "choose" ? "choose" : "end", amount: total });
const publicPay = (o) => {
  const p = o.pay || { rule: "end", state: "end", amount: o.total };
  return { rule: p.rule, state: p.state, amount: p.amount ?? o.total, method: p.method || "", notReceived: !!p.notReceivedAt, confirmedAt: p.confirmedAt || null };
};

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
        payRule: payRuleOf(shop),
        upi: !!shop.upiId,
        offers: await menuOffers(db, shop),
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
          // Name and mobile are asked before ordering: fewer prank orders, and the shop can call back.
          name: z.string().trim().min(2, "Please enter your name.").max(40),
          phone: z.string().trim().max(16).transform((p, ctx) => cleanMobile(p) || (ctx.addIssue({ code: "custom", message: "Please enter a 10-digit mobile number." }), z.NEVER)),
          promo: z.string().trim().max(40).optional().default(""),
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
      const clientId = crypto.randomUUID();
      // A promo code: checked here with the server's prices, and one use taken for this order.
      let promo = null;
      if (input.promo) {
        const { promo: p, amount } = await promoDiscount(db, shop, input.promo, { subtotal: orderTotal(items), where: "qr", phone: input.phone });
        await reservePromo(db, p, { ref: clientId, phone: input.phone, amount });
        promo = { code: p.code, amount };
      }
      const now = new Date();
      const customer = await upsertCustomerByPhone(db, shop._id, { name: input.name, phone: input.phone });
      const doc = {
        shopId: shop._id,
        clientId,
        orderNo: await nextQrNumber(db, shop._id),
        source: "qr",
        table: table.id,
        tableName: table.name,
        customerName: input.name,
        customerPhone: input.phone,
        customer: { ...customer, name: input.name },
        note: input.note,
        items,
        total: orderTotal(items),
        status: "new",
        ...(promo && { promo }),
        pay: initialPay(payRuleOf(shop), payableTotal(shop, items, promo)),
        customerKey: crypto.randomBytes(12).toString("base64url"),
        createdAt: now,
        updatedAt: now,
      };
      try {
        doc._id = (await db.collection("orders").insertOne(doc)).insertedId;
      } catch (err) {
        if (promo) await releasePromo(db, shop._id, clientId);
        throw err;
      }
      return { orderId: doc.clientId, key: doc.customerKey, orderNo: doc.orderNo, total: doc.total, status: doc.status, pay: publicPay(doc), ...(promo && { promo }) };
    },
    { auth: false },
  ],
  // The customer checks a promo code before ordering (prices from the server's menu).
  [
    "POST",
    "/public/shop/:token/promo",
    async ({ db, params, body, req }) => {
      const shop = await shopByToken(db, params.token);
      const input = z.object({ code: z.string().trim().max(40), items: z.array(LineIn).min(1, "add at least one item").max(MAX_LINES), phone: z.string().max(16).optional().default("") }).parse(body);
      // Guessing codes: a few tries an hour per phone and per shop.
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `promo-try:ip:${ip}`, 30, "Too many tries. Please ask the staff.");
      await rateLimit(db, `promo-try:shop:${shop._id}`, 2000, "Too many tries. Please ask the staff.");
      const menu = await db.collection("menuItems").find({ shopId: shop._id }).toArray();
      const items = priceLines(new Map(menu.map((m) => [String(m._id), m])), input.items);
      const { promo, amount } = await promoDiscount(db, shop, input.code, { subtotal: orderTotal(items), where: "qr", phone: cleanMobile(input.phone) || "" });
      return { code: promo.code, amount, description: promo.description, payable: payableTotal(shop, items, { amount }) };
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
        promo: o.promo || null,
        createdAt: o.createdAt,
        billRequest: o.billRequest || null,
        pay: publicPay(o),
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
          prepaid: bill.prepaid?.amount || 0,
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
      const { orderId, key, method } = z.object({ orderId: z.string(), key: z.string(), method: z.enum(["upi", "counter", "paid"]) }).parse(body);
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

  // The customer pays an order now (UPI, says they've paid), will pay at the counter, or at the end.
  [
    "POST",
    "/public/shop/:token/orders/:id/pay",
    async ({ db, params, body }) => {
      const shop = await shopByToken(db, params.token);
      const { key, method, utr } = z
        .object({ key: z.string(), method: z.enum(["upi", "counter", "end"]), utr: z.string().trim().max(30).optional().default("") })
        .parse(body);
      const o = await customerOrder(db, shop, params.id, key);
      await rateLimit(db, `qr-pay:${o.clientId}`, 10, "Too many tries. Please ask the staff.");
      const pay = o.pay || initialPay("end", o.total);
      if (!OPEN.includes(o.status)) throw new HttpError(409, o.status === "rejected" ? "This order was cancelled." : "This order is already billed. Please pay the bill.");
      if (pay.rule === "end") throw new HttpError(400, "Please pay at the end with your bill.");
      if (!["choose", "due", "end"].includes(pay.state)) return { ok: true, pay: publicPay(o) };
      if (method === "upi" && !shop.upiId) throw new HttpError(400, "Online payment isn't set up here. Please pay at the counter.");
      if (method === "end" && pay.rule !== "choose") throw new HttpError(400, "Please pay before your food is cooked.");
      const next =
        method === "upi"
          ? { ...pay, state: "claimed", method: "upi", utr, claimedAt: new Date(), amount: orderPayable(shop, o) }
          : method === "counter"
            ? { ...pay, state: "due", method: "counter", amount: orderPayable(shop, o) }
            : { ...pay, state: "end", method: "" };
      const u = await db.collection("orders").findOneAndUpdate({ _id: o._id }, { $set: { pay: next, updatedAt: new Date() } }, { returnDocument: "after" });
      return { ok: true, pay: publicPay(u) };
    },
    { auth: false },
  ],

  // ---------- Staff ----------
  // Staff check a QR order's payment: received (pay-first orders then go to the kitchen),
  // not received, or a refund handed back for a paid order that was cancelled.
  [
    "POST",
    "/orders/:id/payment",
    async ({ db, shop, params, body, user }) => {
      const { action } = z.object({ action: z.enum(["confirm", "reject", "refunded"]) }).parse(body);
      const o = await db.collection("orders").findOne({ shopId: shop._id, clientId: params.id });
      if (!o) throw new HttpError(404, "Order not found.");
      const pay = o.pay || initialPay("end", o.total);
      const now = new Date();
      let $set;
      if (action === "confirm") {
        if (!["claimed", "due", "choose"].includes(pay.state)) throw new HttpError(409, pay.state === "paid" ? "Already marked paid." : "Nothing to confirm.");
        if (!OPEN.includes(o.status)) throw new HttpError(409, "This order is closed.");
        $set = { pay: { ...pay, state: "paid", method: pay.method || "counter", amount: orderPayable(shop, o), confirmedAt: now, confirmedBy: user.name }, updatedAt: now };
        // Pay first: the payment sends the order to the kitchen.
        if (pay.rule === "first" && o.status === "new") Object.assign($set, { status: "accepted", acceptedAt: now, acceptedBy: user.name });
      } else if (action === "reject") {
        if (pay.state !== "claimed") throw new HttpError(409, "Nothing to reject.");
        $set = { pay: { ...pay, state: pay.rule === "first" ? "due" : "choose", method: "", notReceivedAt: now }, updatedAt: now };
      } else {
        if (pay.state !== "refundDue") throw new HttpError(409, "No refund is due.");
        $set = { pay: { ...pay, state: "refunded", refundedAt: now, refundedBy: user.name }, updatedAt: now };
      }
      // Only if nobody changed it meanwhile (two staff phones tapping at once).
      let u = await db
        .collection("orders")
        .findOneAndUpdate({ _id: o._id, status: o.status, "pay.state": o.pay?.state ?? null }, { $set }, { returnDocument: "after" });
      if (!u) throw new HttpError(409, "Someone just updated this order. Please refresh.");
      if ($set.status === "accepted") await takeStock(db, shop._id, u.items, { orderId: u.clientId });
      let bill = null;
      if (action === "confirm") {
        bill = await createOrderBill(db, shop, u, user);
        u = await db.collection("orders").findOne({ _id: o._id });
      }
      return { ...publicOrder(u), ...(bill && { bill: { ...bill, _id: undefined, shopId: undefined, id: String(bill._id) } }) };
    },
    { manager: true },
  ],
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
  // Free a table whose orders were all paid (and billed) while ordering.
  [
    "POST",
    "/orders/close-table",
    async ({ db, shop, body }) => {
      const { table } = z.object({ table: z.string().max(20) }).parse(body);
      const unpaid = await db.collection("orders").countDocuments({ shopId: shop._id, table, status: { $in: OPEN }, billClientId: { $exists: false } });
      if (unpaid) throw new HttpError(409, "Some orders on this table aren't paid yet. Bill the table instead.");
      const r = await db.collection("orders").updateMany({ shopId: shop._id, table, status: { $in: OPEN } }, { $set: { status: "billed", billedAt: new Date(), updatedAt: new Date() } });
      return { ok: true, closed: r.modifiedCount };
    },
    { manager: true },
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
      const cur0 = await db.collection("orders").findOne({ shopId: shop._id, clientId: params.id }, { projection: { pay: 1, status: 1, billClientId: 1 } });
      if (status === "accepted" && cur0?.pay?.rule === "first" && cur0.pay.state !== "paid") {
        throw new HttpError(409, "This table pays first. Confirm the payment to send it to the kitchen.", { code: "PAY_FIRST" });
      }
      const refund = status === "rejected" && ["paid", "claimed"].includes(cur0?.pay?.state);
      const o = await db.collection("orders").findOneAndUpdate(
        { shopId: shop._id, clientId: params.id, status: { $in: allowedFrom } },
        {
          $set: {
            status, updatedAt: now, [`${status}At`]: now, [`${status}By`]: user.name,
            ...(status === "rejected" && { rejectReason: reason }),
            // Money taken for a cancelled order must go back.
            ...(refund && { "pay.state": "refundDue" }), // check the UPI app and hand the money back
          },
        },
        { returnDocument: "after" }
      );
      if (o && status === "accepted") await takeStock(db, shop._id, o.items, { orderId: o.clientId });
      // A cancelled order gives its promo code use back.
      if (o && status === "rejected" && o.promo) await releasePromo(db, shop._id, o.clientId);
      // A paid order that's cancelled: its bill goes to the Deleted bin (stock back if it was cooking).
      if (o && refund && cur0.billClientId) {
        const b = await db.collection("bills").findOne({ shopId: shop._id, clientId: cur0.billClientId, status: "paid" });
        if (b) await deleteBill(db, shop, user, b, { reason: "cancelled", note: `Order #${o.orderNo} cancelled · refund due`, foodMade: cur0.status !== "accepted", cancelOrders: false });
      }
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
    { shopId, clientId: { $in: orderIds }, status: { $in: OPEN }, billClientId: { $exists: false } },
    { $set: { status: "billed", billedAt: new Date(), billClientId, updatedAt: new Date() } }
  );
  // Orders already paid with their own bill are just closed with the table.
  await db.collection("orders").updateMany(
    { shopId, clientId: { $in: orderIds }, status: { $in: OPEN }, billClientId: { $exists: true } },
    { $set: { status: "billed", billedAt: new Date(), updatedAt: new Date() } }
  );
}
