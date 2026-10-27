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
import { storeOpen, hoursText } from "../../shared/hours.js";
import { helpSettings } from "../../shared/tableHelp.js";
import { pushToShop, MONEY_ROLES } from "../push.js";
import { groupOf, groupPrice, deliveryLine, deliveryRule } from "../../shared/tableGroups.js";
import { shopGateway, createOrder as cfCreateOrder, orderResult as cfOrderResult, refund as cfRefund, webhookOk as cfWebhookOk, billMode as cfBillMode, sdkMode } from "../payments/cashfree.js";

// "unpaid": the table left without paying (closed by staff; not a sale).
export const STATUSES = ["new", "accepted", "preparing", "ready", "served", "billed", "rejected", "unpaid"];
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
        charge: z.boolean().optional(), // the delivery charge line (far tables)
      })
    )
    .min(1)
    .max(MAX_LINES),
});

export function publicOrder({ _id, shopId, customerKey, ...o }) {
  return { ...o, id: String(_id) };
}

const tablesOf = (shop) => (Array.isArray(shop.tables) ? shop.tables : []);
export const tableById = (shop, id) => tablesOf(shop).find((t) => t.id === id);

export async function shopByToken(db, token) {
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
  // Opening hours (Settings): outside them, a friendly note instead of the order button.
  const h = storeOpen(shop.hours, new Date(), shop.closure);
  if (!h.open) return { open: false, closedForHours: true, reason: h.message, opensAt: h.opensAt };
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

// Server prices for the customer's lines (a table group's own prices when the table is in one).
const priceLines = (menuById, lines, group = null) =>
  lines.map((l) => {
    const item = menuById.get(l.itemId);
    if (!item || item.active === false) throw new HttpError(400, "Some items are no longer on the menu. Please refresh the menu.");
    const v = item.variants.find((x) => (x.label || "") === (l.variant || "")) || (item.variants.length === 1 ? item.variants[0] : null);
    if (!v) throw new HttpError(400, `Please choose a size for ${item.name}.`);
    return { itemId: String(item._id), name: item.name, variant: v.label || "", category: item.category || "", qty: l.qty, rate: groupPrice(group, String(item._id), v.label || "", v.price), note: l.note || "" };
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
  const online = o.pay?.method === "online";
  const mode = online ? cfBillMode(o.pay.paymentGroup) : o.pay?.method === "upi" ? "upi" : "cash";
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
    items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount, charge }) => ({ itemId, name, variant, category, qty, rate, amount, ...(charge && { charge }) })),
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
    ...(online && { paymentGateway: { name: "cashfree", orderId: o.pay.online?.cfOrderId, paymentId: o.pay.paymentId || "", group: o.pay.paymentGroup || "" } }),
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
const initialPay = (rule, total, payLater = true) => ({ rule, state: rule === "first" ? "due" : rule === "choose" ? "choose" : "end", amount: total, payLater });
const publicPay = (o) => {
  const p = o.pay || { rule: "end", state: "end", amount: o.total };
  return {
    rule: p.rule, state: p.state, amount: p.amount ?? o.total, method: p.method || "", notReceived: !!p.notReceivedAt, confirmedAt: p.confirmedAt || null,
    // May they pay later (at the table or counter)? And did their last online payment fail?
    payLater: p.payLater !== false,
    failed: !!p.failedAt && !["paid", "refundDue", "refunded"].includes(p.state),
  };
};

// Paying later (at the table or counter): the shop's rule, and this customer's block.
const payLaterOk = (shop, customer) => (shop.payLater === "none" ? false : shop.payLater === "all" ? true : !customer?.payLaterBlocked);
// After a failed online payment with the shop's "cancel" rule, paying later isn't offered any more.
const canPayLater = (shop, pay) => pay.payLater !== false && !(pay.failedAt && shop.payFail === "cancel");

const UNPAID_MINUTES = 15;
// "Must pay online" shops: pay-first orders still unpaid after 15 minutes are cancelled
// (checked whenever orders are loaded; no scheduled job needed).
async function expireUnpaid(db, shop) {
  if (shop.payFail !== "cancel" || !shop.gateway) return;
  const old = await db
    .collection("orders")
    .find({ shopId: shop._id, status: "new", "pay.rule": "first", "pay.state": "due", createdAt: { $lt: new Date(Date.now() - UNPAID_MINUTES * 60e3) } }, { projection: { clientId: 1, promo: 1 } })
    .toArray();
  for (const o of old) {
    const now = new Date();
    const r = await db
      .collection("orders")
      .updateOne({ _id: o._id, status: "new", "pay.state": "due" }, { $set: { status: "rejected", rejectReason: `Not paid in ${UNPAID_MINUTES} minutes`, rejectedAt: now, rejectedBy: "Auto", updatedAt: now } });
    if (r.modifiedCount && o.promo) await releasePromo(db, shop._id, o.clientId);
  }
}

// Cashfree says this payment went through: the order is paid (exactly once), its bill made, and a
// pay-first order goes to the kitchen. Wrong amounts are flagged, never accepted.
async function approveOnline(db, shop, cfOrderId, { amount, payment }) {
  const o = await db.collection("orders").findOne({ shopId: shop._id, "pay.online.cfOrderId": cfOrderId });
  if (!o || ["paid", "refundDue", "refunded"].includes(o.pay.state)) return o;
  const now = new Date();
  if (Math.abs(Number(amount) - o.pay.online.amount) > 0.009) {
    await db.collection("orders").updateOne({ _id: o._id }, { $set: { "pay.mismatch": { amount: Number(amount), at: now }, updatedAt: now } });
    return o;
  }
  const paid = {
    "pay.method": "online", "pay.amount": o.pay.online.amount, "pay.paymentId": String(payment?.cf_payment_id || ""), "pay.paymentGroup": payment?.payment_group || "",
    "pay.confirmedAt": now, "pay.confirmedBy": "Online (Cashfree)", updatedAt: now,
  };
  // Paid for an order that was cancelled meanwhile: the money must go back.
  const closed = !OPEN.includes(o.status);
  const $set = { ...paid, "pay.state": closed ? "refundDue" : "paid" };
  if (!closed && o.pay.rule === "first" && o.status === "new") Object.assign($set, { status: "accepted", acceptedAt: now, acceptedBy: "Online payment" });
  const u = await db.collection("orders").findOneAndUpdate({ _id: o._id, status: o.status, "pay.state": o.pay.state }, { $set, $unset: { "pay.failedAt": "" } }, { returnDocument: "after" });
  if (!u) return db.collection("orders").findOne({ _id: o._id }); // the other signal got there first
  if ($set.status === "accepted") await takeStock(db, shop._id, u.items, { orderId: u.clientId });
  if (!closed) await createOrderBill(db, shop, u, { name: "Online (Cashfree)" });
  return db.collection("orders").findOne({ _id: o._id });
}

async function markOnlineFailed(db, shop, cfOrderId) {
  await db
    .collection("orders")
    .updateOne({ shopId: shop._id, "pay.online.cfOrderId": cfOrderId, "pay.state": { $nin: ["paid", "refundDue", "refunded"] } }, { $set: { "pay.failedAt": new Date(), updatedAt: new Date() } });
}

// Bestsellers for the customer menu: most sold (paid bills, last 30 days), cached on the shop for
// 6 hours; a new shop gets its first dishes in menu order.
async function popularItems(db, shop, menu) {
  const c = shop.popularCache;
  if (c?.at && Date.now() - new Date(c.at) < 6 * 3600e3) return c.ids;
  const top = await db
    .collection("bills")
    .aggregate([
      { $match: { shopId: shop._id, status: "paid", createdAt: { $gte: new Date(Date.now() - 30 * 864e5) } } },
      { $unwind: "$items" },
      { $match: { "items.itemId": { $type: "string", $ne: "" } } },
      { $group: { _id: "$items.itemId", qty: { $sum: "$items.qty" } } },
      { $sort: { qty: -1 } },
      { $limit: 20 },
    ])
    .toArray();
  const shown = new Set(menu.map((m) => String(m._id)));
  let ids = top.map((t) => t._id).filter((id) => shown.has(id)).slice(0, 8);
  if (!ids.length) ids = menu.slice(0, 8).map((m) => String(m._id));
  await db.collection("shops").updateOne({ _id: shop._id }, { $set: { popularCache: { at: new Date(), ids } } });
  return ids;
}

// Where Cashfree sends the customer back, and its webhook: this app's own address.
const appOrigin = (req) => process.env.APP_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;

export default [
  // ---------- Public: the customer's phone after scanning a table QR ----------
  [
    "GET",
    "/public/shop/:token",
    async ({ db, params, query }) => {
      const shop = await shopByToken(db, params.token);
      // The table's group (far tables): its prices and delivery charge, for this table only.
      const group = tableById(shop, query.t) ? groupOf(shop, query.t) : null;
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
        online: !!shop.gateway?.name,
        popular: await popularItems(db, shop, menu),
        help: helpSettings(shop),
        hours: hoursText(shop.hours),
        delivery: deliveryRule(group),
        menu: menu.map((m) => ({
          id: String(m._id),
          name: m.name,
          category: m.category || "Other",
          note: m.note || "",
          variants: group ? m.variants.map((v) => ({ ...v, price: groupPrice(group, String(m._id), v.label || "", v.price) })) : m.variants,
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
      const group = groupOf(shop, table.id);
      const items = priceLines(menuById, input.items, group);
      const stockProblem = checkAvailable(menuById, items);
      if (stockProblem) throw new HttpError(409, stockProblem, { code: "STOCK" });
      const clientId = crypto.randomUUID();
      // Free delivery and promo minimums go by the food, before any charge or discount.
      const food = orderTotal(items);
      // A promo code: checked here with the server's prices, and one use taken for this order.
      let promo = null;
      if (input.promo) {
        const { promo: p, amount } = await promoDiscount(db, shop, input.promo, { subtotal: food, where: "qr", phone: input.phone, table: table.id });
        await reservePromo(db, p, { ref: clientId, phone: input.phone, amount });
        promo = { code: p.code, amount };
      }
      const delivery = deliveryLine(group, food);
      if (delivery) items.push(delivery);
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
        // Not allowed to pay later (shop rule or blocked customer): pay before it's cooked.
        pay: payLaterOk(shop, customer) ? initialPay(payRuleOf(shop), payableTotal(shop, items, promo)) : initialPay("first", payableTotal(shop, items, promo), false),
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
      const count = items.reduce((n, i) => n + (i.charge ? 0 : i.qty), 0);
      await pushToShop(db, shop._id, { title: `🍽️ New order #${doc.orderNo} · ${table.name}`, body: `${count} item${count === 1 ? "" : "s"} · ${input.name}. Tap to open Orders.`, key: `order:${table.id}` });
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
      const input = z
        .object({ code: z.string().trim().max(40), items: z.array(LineIn).min(1, "add at least one item").max(MAX_LINES), phone: z.string().max(16).optional().default(""), table: z.string().max(20).optional().default("") })
        .parse(body);
      // Guessing codes: a few tries an hour per phone and per shop.
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `promo-try:ip:${ip}`, 30, "Too many tries. Please ask the staff.");
      await rateLimit(db, `promo-try:shop:${shop._id}`, 2000, "Too many tries. Please ask the staff.");
      const menu = await db.collection("menuItems").find({ shopId: shop._id }).toArray();
      const group = tableById(shop, input.table) ? groupOf(shop, input.table) : null;
      const items = priceLines(new Map(menu.map((m) => [String(m._id), m])), input.items, group);
      const food = orderTotal(items);
      const { promo, amount } = await promoDiscount(db, shop, input.code, { subtotal: food, where: "qr", phone: cleanMobile(input.phone) || "", table: input.table });
      const delivery = deliveryLine(group, food);
      return { code: promo.code, amount, description: promo.description, payable: payableTotal(shop, delivery ? [...items, delivery] : items, { amount }) };
    },
    { auth: false },
  ],
  // The customer's order status (needs the key returned when ordering).
  [
    "GET",
    "/public/shop/:token/orders/:id",
    async ({ db, params, query }) => {
      const shop = await shopByToken(db, params.token);
      await expireUnpaid(db, shop);
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
        online: !!shop.gateway?.name,
        laterOk: canPayLater(shop, o.pay || {}),
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
      const how = method === "paid" ? "has paid and is leaving" : `asks for the bill · will pay ${method === "upi" ? "by UPI" : "at the counter"}`;
      await pushToShop(db, shop._id, { title: `🧾 ${o.tableName || o.table} ${how}`, body: shop.name, roles: MONEY_ROLES, key: `bill:${o.table}` });
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
      await pushToShop(db, shop._id, { title: `💰 ${o.tableName || o.table} says they paid by UPI`, body: "Check the money came in, then confirm.", roles: MONEY_ROLES, key: `paid:${params.billId}` });
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
      if (method === "end" && !canPayLater(shop, pay)) throw new HttpError(400, "Please pay online for this order.");
      const next =
        method === "upi"
          ? { ...pay, state: "claimed", method: "upi", utr, claimedAt: new Date(), amount: orderPayable(shop, o) }
          : method === "counter"
            ? { ...pay, state: "due", method: "counter", amount: orderPayable(shop, o) }
            : { ...pay, state: "end", method: "" };
      const u = await db.collection("orders").findOneAndUpdate({ _id: o._id }, { $set: { pay: next, updatedAt: new Date() } }, { returnDocument: "after" });
      if (next.state === "claimed") await pushToShop(db, shop._id, { title: `💳 #${o.orderNo} · ${o.tableName || o.table} says paid by UPI`, body: "Check the money came in, then confirm.", roles: MONEY_ROLES, key: `paid:${o.clientId}` });
      return { ok: true, pay: publicPay(u) };
    },
    { auth: false },
  ],

  // Pay this order online through the shop's own Cashfree account. The amount is the server's.
  [
    "POST",
    "/public/shop/:token/orders/:id/pay-online",
    async ({ db, params, body, req }) => {
      const shop = await shopByToken(db, params.token);
      const { key } = z.object({ key: z.string() }).parse(body);
      const o = await customerOrder(db, shop, params.id, key);
      const gw = shopGateway(shop);
      if (!gw) throw new HttpError(400, "Online payment isn't set up here. Please pay at the counter.");
      await rateLimit(db, `qr-pay:${o.clientId}`, 10, "Too many tries. Please ask the staff.");
      if (!OPEN.includes(o.status)) throw new HttpError(409, o.status === "rejected" ? "This order was cancelled." : "This order is already billed. Please pay the bill.");
      const pay = o.pay || initialPay("end", o.total);
      if (["paid", "refundDue", "refunded"].includes(pay.state)) return { pay: publicPay(o) };
      const amount = round2(orderPayable(shop, o));
      const cfOrderId = `${o.orderNo}_${o.clientId.slice(0, 8)}_${Date.now().toString(36)}`.replace(/[^\w-]/g, "");
      const origin = appOrigin(req);
      const cfo = await cfCreateOrder(gw, {
        order_id: cfOrderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: { customer_id: `c_${o.customerPhone || o.clientId.slice(0, 12)}`, customer_phone: o.customerPhone || "9999999999", customer_name: (o.customerName || "Customer").slice(0, 40) },
        order_meta: {
          return_url: `${origin}/order/${params.token}?t=${encodeURIComponent(o.table)}&paid=${o.clientId}`,
          notify_url: `${origin}/api/public/pay/cashfree/${shop._id}`,
        },
        order_note: `Order #${o.orderNo} · ${o.tableName || o.table}`,
      });
      await db.collection("orders").updateOne({ _id: o._id }, { $set: { "pay.online": { gateway: "cashfree", cfOrderId, amount, createdAt: new Date() }, updatedAt: new Date() } });
      return { paymentSessionId: cfo.payment_session_id, cfOrderId, mode: sdkMode(gw.mode), amount };
    },
    { auth: false },
  ],
  // Back from Cashfree (or waiting): the server asks Cashfree itself, never trusting the phone.
  [
    "GET",
    "/public/shop/:token/orders/:id/pay-online",
    async ({ db, params, query }) => {
      const shop = await shopByToken(db, params.token);
      let o = await customerOrder(db, shop, params.id, query.k);
      const gw = shopGateway(shop);
      if (gw && o.pay?.online?.cfOrderId && !["paid", "refundDue", "refunded"].includes(o.pay.state)) {
        const r = await cfOrderResult(gw, o.pay.online.cfOrderId);
        if (r.paid) o = await approveOnline(db, shop, o.pay.online.cfOrderId, { amount: r.payment?.payment_amount ?? r.amount, payment: r.payment });
        else if (["FAILED", "USER_DROPPED", "CANCELLED"].includes(r.payment?.payment_status)) {
          await markOnlineFailed(db, shop, o.pay.online.cfOrderId);
          o = await db.collection("orders").findOne({ _id: o._id });
        }
      }
      return { status: o.status, pay: publicPay(o), billNo: o.billNo || null, laterOk: canPayLater(shop, o.pay || {}) };
    },
    { auth: false },
  ],
  // Cashfree's webhook for a shop's payments (signed with that shop's secret).
  [
    "POST",
    "/public/pay/cashfree/:shopId",
    async ({ db, params, req, raw, body }) => {
      if (!/^[a-f0-9]{24}$/.test(params.shopId)) throw new HttpError(404, "Not found.");
      const { ObjectId } = await import("mongodb");
      const shop = await db.collection("shops").findOne({ _id: new ObjectId(params.shopId) }, { projection: { logo: 0, qrImage: 0 } });
      const gw = shopGateway(shop);
      if (!gw) throw new HttpError(404, "Not found.");
      if (!cfWebhookOk(String(raw || ""), req.headers["x-webhook-timestamp"], req.headers["x-webhook-signature"], gw.secret)) throw new HttpError(400, "Bad signature.");
      const cfOrderId = body?.data?.order?.order_id;
      const payment = body?.data?.payment;
      if (cfOrderId && payment) {
        if (payment.payment_status === "SUCCESS") await approveOnline(db, shop, cfOrderId, { amount: payment.payment_amount, payment });
        else if (["FAILED", "USER_DROPPED", "CANCELLED"].includes(payment.payment_status)) await markOnlineFailed(db, shop, cfOrderId);
      }
      return { ok: true };
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
      const { action } = z.object({ action: z.enum(["confirm", "reject", "refunded", "refund-online"]) }).parse(body);
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
      } else if (action === "refund-online") {
        // Paid online, then cancelled: Cashfree sends the money back to the customer.
        if (pay.state !== "refundDue" || pay.method !== "online" || !pay.online) throw new HttpError(409, "No online refund is due.");
        const gw = shopGateway(shop);
        if (!gw) throw new HttpError(400, "Cashfree isn't connected any more. Refund from the Cashfree dashboard, then mark it refunded.");
        const r = await cfRefund(gw, pay.online.cfOrderId, { amount: pay.amount, refundId: `r_${pay.online.cfOrderId}`.slice(0, 40), note: `Order #${o.orderNo} cancelled` });
        $set = { pay: { ...pay, state: "refunded", refundedAt: now, refundedBy: user.name, refund: { id: r.refund_id, status: r.refund_status || "PENDING" } }, updatedAt: now };
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
      await expireUnpaid(db, shop);
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
        // Customers asking from their table (waiter, water, questions) that aren't done yet.
        helpRequests: (
          await db.collection("tableHelp").find({ shopId: shop._id, status: { $ne: "done" }, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(100).toArray()
        ).map(({ _id, shopId, deviceKey, ...r }) => ({ ...r, id: String(_id) })),
        serverTime: new Date(),
      };
    },
    { kitchen: true },
  ],
  // The table left without paying: its unpaid orders close as "unpaid" (not sales), and each
  // customer gets a mark; at the shop's limit they must pay online from then on.
  [
    "POST",
    "/orders/left-unpaid",
    async ({ db, shop, body, user }) => {
      const { table } = z.object({ table: z.string().max(20) }).parse(body);
      const list = await db.collection("orders").find({ shopId: shop._id, table, status: { $in: OPEN }, billClientId: { $exists: false } }).toArray();
      if (!list.length) throw new HttpError(409, "Nothing unpaid on this table.");
      const now = new Date();
      await db.collection("orders").updateMany({ _id: { $in: list.map((o) => o._id) } }, { $set: { status: "unpaid", unpaidAt: now, unpaidBy: user.name, updatedAt: now } });
      const ids = [...new Set(list.map((o) => o.customer?.clientId).filter(Boolean))];
      const customers = [];
      for (const clientId of ids) {
        let c = await db.collection("customers").findOneAndUpdate({ shopId: shop._id, clientId }, { $inc: { unpaidCount: 1 }, $set: { lastUnpaidAt: now } }, { returnDocument: "after" });
        if (!c) continue;
        if (shop.blockAfter > 0 && c.unpaidCount >= shop.blockAfter && !c.payLaterBlocked) {
          c = await db.collection("customers").findOneAndUpdate({ _id: c._id }, { $set: { payLaterBlocked: true } }, { returnDocument: "after" });
        }
        customers.push({ id: String(c._id), name: c.name, phone: c.phone, unpaidCount: c.unpaidCount, blocked: !!c.payLaterBlocked });
      }
      return { closed: list.length, customers };
    },
    { manager: true },
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
