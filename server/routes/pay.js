import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http.js";
import { PLANS, plansFor, grantPlan, planSettings } from "../subscription.js";
import { findPromo, applyPromo, describePromo } from "../promo.js";

const PlanId = z.enum(["monthly", "yearly"]);
const PromoField = z.string().trim().max(30).optional();

// The shop's price for a plan, with a promo code applied when one is given.
async function priceFor(db, shop, planId, promoCode) {
  const plan = plansFor(shop)[planId];
  if (!promoCode) return plan;
  return applyPromo(plan, await findPromo(db, shop, promoCode, planId));
}
const promoFields = (plan) => (plan.promo ? { promoCode: plan.promo.code, promoOff: plan.promo.off, priceBeforePromo: plan.beforePromo } : {});

function razorpayKeys() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return id && secret ? { id, secret } : null;
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function razorpaySignatureOk(orderId, paymentId, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

export function webhookSignatureOk(rawBody, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

// Moves a Razorpay payment from "created" to "approved" exactly once, then extends the plan.
async function approveRazorpay(db, orderId, paymentId) {
  const payment = await db
    .collection("payments")
    .findOneAndUpdate(
      { razorpayOrderId: orderId, status: "created" },
      { $set: { status: "approved", razorpayPaymentId: paymentId, approvedAt: new Date() } },
      { returnDocument: "after" }
    );
  if (!payment) return null; // already approved (verify and webhook can race) or unknown
  const end = await grantPlan(db, payment.shopId, payment.plan);
  return { payment, end };
}

const publicPayment = ({ _id, shopId, ...p }) => ({ ...p, id: String(_id) });

const RZP_API = "https://api.razorpay.com/v1";
const MAX_PAYMENT_AGE_DAYS = 7;
const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;

async function razorpayError(r) {
  let msg = "";
  try {
    msg = (await r.json())?.error?.description || "";
  } catch {
    /* not JSON */
  }
  return `Razorpay HTTP ${r.status}${msg ? ": " + msg : ""}`;
}

// Health check: are the API keys accepted by Razorpay?
export async function razorpayKeyStatus() {
  if (!razorpayKeys()) return "not set";
  try {
    const r = await razorpayApi("/payments?count=1");
    return r.ok ? "ok" : await razorpayError(r);
  } catch (err) {
    return "network error: " + (err?.message || err);
  }
}

async function razorpayApi(path, init = {}) {
  const keys = razorpayKeys();
  return fetch(RZP_API + path, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${keys.id}:${keys.secret}`).toString("base64"),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

/**
 * Asks Razorpay whether a payment ID really paid for `plan`.
 * @returns {{ok: true} | {ok: false, reason: string} | {unreachable: true}}
 */
export async function checkRazorpayPayment(paymentId, plan, now = Date.now()) {
  let p;
  try {
    const r = await razorpayApi(`/payments/${encodeURIComponent(paymentId)}`);
    if (r.status === 400 || r.status === 404) return { ok: false, reason: "Razorpay has no payment with this ID. Please check it and try again." };
    if (!r.ok) return { unreachable: true, why: await razorpayError(r) };
    p = await r.json();
  } catch (err) {
    return { unreachable: true, why: "network: " + (err?.message || err) };
  }
  const need = plan.amount * 100;
  if (p.currency !== "INR") return { ok: false, reason: "This payment isn't in rupees." };
  if (p.amount < need) return { ok: false, reason: `This payment is ${rupees(p.amount)}, but the ${plan.name.toLowerCase()} plan is ${rupees(need)}.` };
  if (now - p.created_at * 1000 > MAX_PAYMENT_AGE_DAYS * 864e5) return { ok: false, reason: "This payment is too old to use for a new plan." };
  if (p.status === "authorized") {
    // Money is held but not collected yet: capture it.
    try {
      const c = await razorpayApi(`/payments/${encodeURIComponent(paymentId)}/capture`, {
        method: "POST",
        body: JSON.stringify({ amount: p.amount, currency: "INR" }),
      });
      if (!c.ok) return { unreachable: true, why: "capture: " + (await razorpayError(c)) };
      p = await c.json();
    } catch (err) {
      return { unreachable: true, why: "capture network: " + (err?.message || err) };
    }
  }
  if (p.status !== "captured") {
    return { ok: false, reason: p.status === "failed" ? "This payment failed. No money was taken." : "This payment isn't complete yet. Try again in a minute." };
  }
  return { ok: true };
}

// Approves a pending link payment after Razorpay confirms it. Returns true if the plan was extended.
async function autoApprove(db, payment, plan) {
  try {
    const done = await db.collection("payments").findOneAndUpdate(
      { _id: payment._id, status: "pending" },
      { $set: { status: "approved", razorpayPaymentId: payment.utr, approvedAt: new Date(), approvedBy: "razorpay-auto" }, $unset: { autoCheck: "" } },
      { returnDocument: "after" }
    );
    if (!done) return false;
  } catch (err) {
    if (err.code === 11000) return false; // this payment ID was already used for another plan
    throw err;
  }
  await grantPlan(db, payment.shopId, plan.id);
  return true;
}

// Re-checks pending payment-link entries with Razorpay (e.g. ones submitted before keys were set).
export async function recheckPendingLinks(db, filter = {}, limit = 20) {
  if (!razorpayKeys()) return 0;
  const pending = await db.collection("payments").find({ ...filter, method: "link", status: "pending" }).limit(limit).toArray();
  let approved = 0;
  for (const pay of pending) {
    const plan = { ...PLANS[pay.plan], amount: pay.amount }; // the price when it was submitted
    // Pending entries can be older than the 7-day window: measure age from when it was submitted.
    const res = await checkRazorpayPayment(pay.utr, plan, new Date(pay.createdAt).getTime());
    if (res.ok) approved += (await autoApprove(db, pay, plan)) ? 1 : 0;
    else {
      const note = res.reason || `Couldn't check with Razorpay yet (${res.why}).`;
      console.warn("Payment auto-check", pay.utr, note);
      await db.collection("payments").updateOne({ _id: pay._id }, { $set: { autoCheck: note, autoCheckedAt: new Date() } });
    }
  }
  return approved;
}

export default [
  [
    "GET",
    "/pay/config",
    async ({ status, shop }) => ({
      plans: Object.values(plansFor(shop)),
      yearlyBadge: planSettings().yearlyBadge,
      trialDays: planSettings().trialDays,
      razorpayKeyId: razorpayKeys()?.id || null,
      upi: process.env.UPI_ID ? { id: process.env.UPI_ID, name: process.env.UPI_NAME || "Billing App" } : null,
      // A Razorpay.me (or other) payment page; payments are confirmed by the admin.
      paymentLink: /^https:\/\/[^\s]+$/.test(process.env.PAYMENT_LINK || "") ? process.env.PAYMENT_LINK : null,
      status,
    }),
  ],
  [
    "GET",
    "/pay/history",
    async ({ db, shop }) => {
      const approved = await recheckPendingLinks(db, { shopId: shop._id }, 5);
      return {
        approved,
        payments: (await db.collection("payments").find({ shopId: shop._id, status: { $ne: "created" } }).sort({ createdAt: -1 }).limit(50).toArray()).map(publicPayment),
      };
    },
  ],

  // Checks a promo code and returns the plans with it applied.
  [
    "POST",
    "/pay/promo",
    async ({ db, shop, body }) => {
      const { code } = z.object({ code: z.string().max(30) }).parse(body);
      const promo = await findPromo(db, shop, code);
      return { code: promo._id, label: describePromo(promo), plans: Object.values(plansFor(shop)).map((p) => applyPromo(p, promo)) };
    },
  ],
  [
    "POST",
    "/pay/razorpay/order",
    async ({ db, shop, user, body }) => {
      const keys = razorpayKeys();
      if (!keys) throw new HttpError(503, "Online payment isn't set up yet. Please pay by UPI.");
      const plan = await priceFor(db, shop, PlanId.parse(body.plan), PromoField.parse(body.promo));
      const receipt = `s${String(shop._id).slice(-8)}-${Date.now()}`;
      const r = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from(`${keys.id}:${keys.secret}`).toString("base64"),
        },
        body: JSON.stringify({ amount: plan.amount * 100, currency: "INR", receipt, notes: { shopId: String(shop._id), plan: plan.id, ...(plan.promo && { promo: plan.promo.code }) } }),
      });
      const order = await r.json();
      if (!r.ok) {
        console.error("Razorpay order failed", order);
        throw new HttpError(502, "Couldn't start the payment. Please try again.");
      }
      await db.collection("payments").insertOne({
        shopId: shop._id,
        plan: plan.id,
        amount: plan.amount,
        ...promoFields(plan),
        method: "razorpay",
        razorpayOrderId: order.id,
        status: "created",
        createdAt: new Date(),
      });
      return {
        keyId: keys.id,
        orderId: order.id,
        amount: order.amount,
        currency: "INR",
        plan,
        prefill: { name: user.name, email: user.email, contact: user.phone },
        shopName: shop.name,
      };
    },
  ],
  [
    "POST",
    "/pay/razorpay/verify",
    async ({ db, shop, body }) => {
      const keys = razorpayKeys();
      if (!keys) throw new HttpError(503, "Online payment isn't set up.");
      const p = z
        .object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() })
        .parse(body);
      if (!razorpaySignatureOk(p.razorpay_order_id, p.razorpay_payment_id, p.razorpay_signature, keys.secret)) {
        throw new HttpError(400, "Payment could not be verified.");
      }
      const own = await db.collection("payments").findOne({ razorpayOrderId: p.razorpay_order_id, shopId: shop._id });
      if (!own) throw new HttpError(404, "Payment not found.");
      await approveRazorpay(db, p.razorpay_order_id, p.razorpay_payment_id);
      const updated = await db.collection("shops").findOne({ _id: shop._id });
      return { ok: true, currentPeriodEnd: updated.subscription?.currentPeriodEnd };
    },
  ],
  // Backstop if the browser closes before /verify runs. Set this URL in the Razorpay dashboard.
  [
    "POST",
    "/pay/razorpay/webhook",
    async ({ db, req, raw, body }) => {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) throw new HttpError(503, "Webhook not configured.");
      if (!webhookSignatureOk(raw, req.headers["x-razorpay-signature"] || "", secret)) {
        throw new HttpError(400, "Bad signature.");
      }
      if (body.event === "payment.captured" || body.event === "order.paid") {
        const entity = body.payload?.payment?.entity;
        if (entity?.order_id) await approveRazorpay(db, entity.order_id, entity.id);
      }
      return { ok: true };
    },
    { auth: false },
  ],

  // Manual payments, approved by the admin: UPI (reference / UTR) or a payment link (Razorpay payment ID).
  [
    "POST",
    "/pay/upi",
    async ({ db, shop, body }) => {
      const input = z
        .object({
          plan: PlanId,
          via: z.enum(["upi", "link"]).default("upi"),
          utr: z.string().trim().min(1, "enter the payment reference"),
          promo: PromoField,
        })
        .parse(body);
      let utr;
      if (input.via === "link") {
        if (!/^pay_[A-Za-z0-9]{8,30}$/.test(input.utr)) {
          throw new HttpError(400, "Enter the Razorpay payment ID from your receipt. It starts with pay_ (e.g. pay_N3abc12XYZ).");
        }
        utr = input.utr; // Razorpay IDs are case-sensitive
      } else {
        if (!/^[A-Za-z0-9]{6,30}$/.test(input.utr)) throw new HttpError(400, "Enter the UPI reference / UTR number from your payment app.");
        utr = input.utr.toUpperCase();
      }
      const method = input.via === "link" ? "link" : "upi";
      const plan = await priceFor(db, shop, input.plan, input.promo);
      const existing = await db.collection("payments").findOne({ method, utr, status: { $in: ["pending", "approved"] } });
      // With keys, resubmitting your own pending ID asks Razorpay again instead of failing.
      const retryOwnPending =
        existing && existing.status === "pending" && String(existing.shopId) === String(shop._id) && method === "link" && !!razorpayKeys();
      if (existing && !retryOwnPending) throw new HttpError(409, "This payment reference has already been submitted.");

      // With API keys, Razorpay itself confirms the payment and the plan starts immediately.
      let check = null;
      if (method === "link" && razorpayKeys()) {
        if (await db.collection("payments").findOne({ razorpayPaymentId: utr })) {
          throw new HttpError(409, "This payment has already been used for a plan.");
        }
        check = await checkRazorpayPayment(utr, plan);
        if (check.reason) throw new HttpError(400, check.reason);
      }

      const doc = retryOwnPending
        ? existing
        : { shopId: shop._id, plan: plan.id, amount: plan.amount, ...promoFields(plan), method, utr, status: "pending", createdAt: new Date() };
      if (!retryOwnPending) doc._id = (await db.collection("payments").insertOne(doc)).insertedId;
      if (check?.ok && (await autoApprove(db, doc, { ...PLANS[doc.plan], amount: doc.amount }))) {
        return { ...publicPayment(await db.collection("payments").findOne({ _id: doc._id })), autoApproved: true };
      }
      return publicPayment(doc);
    },
  ],
];
