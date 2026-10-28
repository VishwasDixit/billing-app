// Shared bits of the customer QR page.
import { addonKey } from "../../../shared/addons.js";

export const STEPS = [
  ["new", "Sent", "Waiting for the staff to confirm", "📨"],
  ["accepted", "In the kitchen", "The kitchen has your order", "👨‍🍳"],
  ["preparing", "Cooking", "Your food is being cooked", "🍳"],
  ["ready", "Ready", "Your food is ready and on its way", "🛎️"],
  ["served", "Served", "Enjoy your meal!", "😋"],
];
export const stepIndex = (s) => Math.max(0, STEPS.findIndex(([k]) => k === s));
// One cart line per dish, size and set of add-ons.
export const lineKey = (id, v, addonIds) => (addonIds?.length ? `${id}|${v}|${addonKey(addonIds)}` : `${id}|${v}`);
// Dishes with sizes or add-ons open the customise sheet instead of adding straight away.
export const needsChoice = (m) => m.variants.length > 1 || (m.addons || []).length > 0;

export function loadMine(token) {
  try {
    return JSON.parse(localStorage.getItem(`myOrders:${token}`) || "[]");
  } catch {
    return [];
  }
}
export function saveMine(token, list) {
  try {
    localStorage.setItem(`myOrders:${token}`, JSON.stringify(list.slice(-10)));
  } catch {
    /* ignore */
  }
}

// A random id for this phone, so it can see its own help requests (and no one else's).
export function deviceKey() {
  try {
    let k = localStorage.getItem("coDevice");
    if (!k) {
      const b = new Uint8Array(15);
      crypto.getRandomValues(b);
      k = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      localStorage.setItem("coDevice", k);
    }
    return k;
  } catch {
    return "nostorage" + Math.random().toString(36).slice(2, 14);
  }
}

// The menu offer closest to being unlocked by this cart: { offer, short } (rupees still needed),
// or { offer, unlocked: true }. Only codes this table can use, with a minimum order.
export function couponNudge(offers, total) {
  const withMin = offers.filter((o) => o.minOrder > 0).sort((a, b) => a.minOrder - b.minOrder);
  const next = withMin.find((o) => total < o.minOrder);
  const reached = [...withMin].reverse().find((o) => total >= o.minOrder);
  if (next && total > 0) return { offer: next, short: next.minOrder - total, progress: Math.min(1, total / next.minOrder), unlockedBefore: reached || null };
  if (reached) return { offer: reached, unlocked: true };
  return null;
}

// Why an order was turned down, in words for the customer. Staff-only reasons (a deleted bill,
// a two-letter test) are hidden.
export function customerReason(reason) {
  const r = String(reason || "").trim();
  if (r.length < 3 || /^Bill .* deleted$/i.test(r)) return "";
  if (/^Not paid in \d+ minutes$/i.test(r)) return "Payment wasn't received in time.";
  return /[.!?]$/.test(r) ? r : `${r}.`;
}
