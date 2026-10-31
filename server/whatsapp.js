// Automatic WhatsApp messages through Meta's WhatsApp Cloud API (one business number for the app).
// Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID; only shops listed in WHATSAPP_SHOPS (ids,
// comma-separated) may send. Webhook calls are checked with WHATSAPP_APP_SECRET, and Meta's
// set-up check uses WHATSAPP_VERIFY_TOKEN. Messages started by the shop must use templates Meta
// has approved: their names and text are below (docs/whatsapp-setup.md has the set-up steps).
// In local development, WHATSAPP_FAKE=1 keeps messages in `fakeOutbox` instead of sending them.
import crypto from "node:crypto";

const GRAPH = "https://graph.facebook.com/v21.0";
const env = (k) => String(process.env[k] || "").trim();

// The four templates, with the body text exactly as it's set up in Meta ({{1}}… are filled in).
export const TEMPLATES = {
  offer: {
    name: "offer_reminder",
    body: "Hi {{1}}! 🎁 {{2}} has an offer for you: {{3}}. {{4}} Order here: {{5}} See you soon!",
  },
  dishes: {
    name: "new_dishes",
    body: "Hi {{1}}! 🍽️ New on the menu at {{2}}: {{3}}. Try them on your next visit: {{4}} Enjoy!",
  },
  news: {
    name: "shop_news",
    body: "Hi {{1}}! 📣 News from {{2}}: {{3}} See the menu: {{4}} Thank you!",
  },
  miss: {
    name: "we_miss_you",
    body: "Hi {{1}}, we miss you at {{2}}! 😊 {{3}} Order here: {{4}} Hope to see you soon.",
  },
};
export const FOOTER = "Reply STOP to stop these messages";

// Template parameters can't have new lines, tabs or long runs of spaces.
export const cleanParam = (t) => String(t ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 900) || "-";

// The message as the customer will read it (for previews and the run log).
export const renderTemplate = (kind, params) => TEMPLATES[kind].body.replace(/\{\{(\d+)\}\}/g, (_, n) => cleanParam(params[n - 1]));

const fakeMode = () => env("WHATSAPP_FAKE") === "1" && !process.env.VERCEL && process.env.NODE_ENV !== "production";
export const fakeOutbox = [];

const envReady = () => fakeMode() || !!(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID"));
const allowedShops = () => env("WHATSAPP_SHOPS").split(",").map((s) => s.trim()).filter(Boolean);

// "ready", "env" (the app has no WhatsApp keys yet) or "shop" (this shop isn't switched on).
export function waStatus(shop) {
  if (!envReady()) return "env";
  if (!fakeMode() && !allowedShops().includes(String(shop._id))) return "shop";
  return "ready";
}
export const waReady = (shop) => waStatus(shop) === "ready";

async function graphPost(payload) {
  if (fakeMode()) {
    fakeOutbox.push(payload);
    console.log(`[whatsapp fake] ${payload.type} ${payload.template?.name || ""} → ••••${String(payload.to).slice(-4)}`);
    return `fake-${fakeOutbox.length}`;
  }
  const r = await fetch(`${GRAPH}/${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.error_data?.details || j.error?.message || `WhatsApp error ${r.status}`);
  return j.messages?.[0]?.id || "";
}

// A template message to a 10-digit Indian mobile. Returns Meta's message id.
export function sendTemplate(phone, kind, params, lang = "en") {
  const t = TEMPLATES[kind];
  return graphPost({
    to: `91${phone}`,
    type: "template",
    template: { name: t.name, language: { code: lang }, components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: cleanParam(p) })) }] },
  });
}

// A plain reply, allowed within 24 hours of the customer's own message (the STOP confirmation).
export const sendText = (phone, text) => graphPost({ to: `91${phone}`, type: "text", text: { body: text } });

// Meta signs each webhook call: "sha256=" + HMAC of the raw body with the app secret.
export function signatureOk(raw, header) {
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret || !header) return false;
  const want = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw || "").digest("hex"));
  const got = Buffer.from(String(header));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const verifyTokenOk = (t) => !!env("WHATSAPP_VERIFY_TOKEN") && String(t || "") === env("WHATSAPP_VERIFY_TOKEN");
