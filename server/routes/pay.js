import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http.js";
import { PLANS, grantPlan } from "../subscription.js";

const PlanId = z.enum(["monthly", "yearly"]);

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

export default [
  [
    "GET",
    "/pay/config",
    async ({ status }) => ({
      plans: Object.values(PLANS),
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
    async ({ db, shop }) => ({
      payments: (await db.collection("payments").find({ shopId: shop._id, status: { $ne: "created" } }).sort({ createdAt: -1 }).limit(50).toArray()).map(publicPayment),
    }),
  ],

  [
    "POST",
    "/pay/razorpay/order",
    async ({ db, shop, user, body }) => {
      const keys = razorpayKeys();
      if (!keys) throw new HttpError(503, "Online payment isn't set up yet. Please pay by UPI.");
      const plan = PLANS[PlanId.parse(body.plan)];
      const receipt = `s${String(shop._id).slice(-8)}-${Date.now()}`;
      const r = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from(`${keys.id}:${keys.secret}`).toString("base64"),
        },
        body: JSON.stringify({ amount: plan.amount * 100, currency: "INR", receipt, notes: { shopId: String(shop._id), plan: plan.id } }),
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
      if (await db.collection("payments").findOne({ method, utr, status: { $in: ["pending", "approved"] } })) {
        throw new HttpError(409, "This payment reference has already been submitted.");
      }
      const plan = PLANS[input.plan];
      const doc = { shopId: shop._id, plan: plan.id, amount: plan.amount, method, utr, status: "pending", createdAt: new Date() };
      doc._id = (await db.collection("payments").insertOne(doc)).insertedId;
      return publicPayment(doc);
    },
  ],
];
