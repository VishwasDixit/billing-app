// Cashfree Payment Gateway (PG API 2023-08-01), with each shop's own keys.
// Docs: https://docs.cashfree.com/reference/pg-new-apis-endpoint
import crypto from "node:crypto";
import { HttpError } from "../http.js";
import { decryptSecret } from "./keys.js";

export const API_VERSION = "2023-08-01";
// CASHFREE_API_BASE replaces both (tests use a fake Cashfree).
const apiBase = (mode) => process.env.CASHFREE_API_BASE || (mode === "live" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
export const sdkMode = (mode) => (mode === "live" ? "production" : "sandbox");

// A shop's connected gateway with its secret decrypted, or null.
export function shopGateway(shop) {
  const g = shop?.gateway;
  if (g?.name !== "cashfree" || !g.secretBox) return null;
  return { mode: g.mode, appId: g.appId, secret: decryptSecret(g.secretBox) };
}

export async function cfFetch(gw, path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(apiBase(gw.mode) + path, {
      method,
      headers: { "x-client-id": gw.appId, "x-client-secret": gw.secret, "x-api-version": API_VERSION, "content-type": "application/json", accept: "application/json" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Cashfree. Please try again.");
  }
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// The keys work if Cashfree answers "order not found" (not "authentication failed").
export async function keysWork(gw) {
  const { status } = await cfFetch(gw, `/orders/keycheck_${crypto.randomBytes(6).toString("hex")}`);
  return status === 404;
}

export async function createOrder(gw, body) {
  const { status, data } = await cfFetch(gw, "/orders", { method: "POST", body });
  if (status >= 300 || !data.payment_session_id) throw new HttpError(502, `Cashfree couldn't start the payment${data.message ? `: ${data.message}` : "."}`);
  return data;
}

// { paid, amount, payment } — the order's state and its latest payment, straight from Cashfree.
export async function orderResult(gw, cfOrderId) {
  const id = encodeURIComponent(cfOrderId);
  const [o, p] = await Promise.all([cfFetch(gw, `/orders/${id}`), cfFetch(gw, `/orders/${id}/payments`)]);
  if (o.status >= 300) throw new HttpError(502, "Couldn't check the payment with Cashfree.");
  const payments = Array.isArray(p.data) ? p.data : [];
  const success = payments.find((x) => x.payment_status === "SUCCESS");
  return { paid: o.data.order_status === "PAID", amount: Number(o.data.order_amount), payment: success || payments[0] || null };
}

export async function refund(gw, cfOrderId, { amount, refundId, note }) {
  const { status, data } = await cfFetch(gw, `/orders/${encodeURIComponent(cfOrderId)}/refunds`, { method: "POST", body: { refund_amount: amount, refund_id: refundId, refund_note: note } });
  if (status >= 300) throw new HttpError(502, `Cashfree didn't accept the refund${data.message ? `: ${data.message}` : "."}`);
  return data;
}

// Webhook signature: base64(HMAC-SHA256(timestamp + raw body, secret)).
export function webhookOk(raw, timestamp, signature, secret) {
  if (!timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(String(timestamp) + raw).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Bills: UPI stays UPI; cards, netbanking, wallets and the rest count as card.
export const billMode = (group) => (/upi/i.test(group || "") ? "upi" : "card");
