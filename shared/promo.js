// Promo code rules, shared by the server (which decides) and the screens (which explain).
// A promo: { code, description, type: "percent"|"flat", value, maxDiscount, minOrder,
//   validFrom, validTo ("YYYY-MM-DD" or ""), active, days: [0..6] (empty = every day),
//   timeFrom, timeTo ("HH:MM" or ""), maxUses (0 = no limit), onePerPhone,
//   where: "both"|"qr"|"billing", showOnMenu, uses }.
// Dates, days and times are India time. The discount comes off before GST.
import { round2 } from "./totals.js";

const IST = 5.5 * 3600e3;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const cleanCode = (c) => String(c || "").trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9]{3,20}$/;

const rs = (n, cur = "₹") => `${cur}${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const dateText = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export function timeText(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}
// Week from Monday (Sunday last), with runs joined: "Mon–Fri", "Sat, Sun".
function daysText(days) {
  const d = [...days].map((x) => (x === 0 ? 7 : x)).sort((a, b) => a - b);
  const name = (x) => DAY_NAMES[x % 7];
  const runs = [];
  for (const x of d) {
    const last = runs[runs.length - 1];
    if (last && x === last[1] + 1) last[1] = x;
    else runs.push([x, x]);
  }
  return runs.map(([a, b]) => (a === b ? name(a) : b === a + 1 ? `${name(a)}, ${name(b)}` : `${name(a)}–${name(b)}`)).join(", ");
}
const hasDays = (p) => Array.isArray(p.days) && p.days.length > 0 && p.days.length < 7;
const hasTime = (p) => !!(p.timeFrom && p.timeTo && p.timeFrom !== p.timeTo);

// "10% off up to ₹100 · min ₹300 · Mon–Fri · 3 pm–6 pm"
export function promoSummary(p, cur = "₹") {
  const parts = [p.type === "flat" ? `${rs(p.value, cur)} off` : `${p.value}% off${p.maxDiscount > 0 ? ` up to ${rs(p.maxDiscount, cur)}` : ""}`];
  if (p.minOrder > 0) parts.push(`min ${rs(p.minOrder, cur)}`);
  if (hasDays(p)) parts.push(daysText(p.days));
  if (hasTime(p)) parts.push(`${timeText(p.timeFrom)}–${timeText(p.timeTo)}`);
  if (p.onePerPhone) parts.push("once per mobile");
  return parts.join(" · ");
}

// What the code takes off this subtotal, or why it can't be used.
// where: "qr" (customer's phone) or "billing" (staff). usedByPhone: this mobile already used it.
export function checkPromo(p, { subtotal = 0, where = "billing", at = new Date(), usedByPhone = false, cur = "₹" } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!p || p.archived) return no("That isn't a valid code.");
  if (!p.active) return no("This code is paused right now.");
  if (p.where === "qr" && where !== "qr") return no("This code is only for table QR orders.");
  if (p.where === "billing" && where !== "billing") return no("This code is only for the counter. Please ask the staff.");
  const local = new Date(at.getTime() + IST);
  const today = local.toISOString().slice(0, 10);
  if (p.validFrom && today < p.validFrom) return no(`This code starts on ${dateText(p.validFrom)}.`);
  if (p.validTo && today > p.validTo) return no("This code has expired.");
  if (hasDays(p) && !p.days.includes(local.getUTCDay())) return no(`This code works on ${daysText(p.days)} only.`);
  if (hasTime(p)) {
    const now = local.toISOString().slice(11, 16);
    // A window like 22:00–02:00 runs past midnight.
    const inside = p.timeFrom < p.timeTo ? now >= p.timeFrom && now < p.timeTo : now >= p.timeFrom || now < p.timeTo;
    if (!inside) return no(`This code works ${timeText(p.timeFrom)}–${timeText(p.timeTo)} only.`);
  }
  if (p.maxUses > 0 && (p.uses || 0) >= p.maxUses) return no("This code has been fully used.");
  if (usedByPhone) return no("This code was already used on this mobile number.");
  if (p.minOrder > 0 && subtotal < p.minOrder) return no(`This code is valid on orders of ${rs(p.minOrder, cur)} or more.`);
  let amount = p.type === "flat" ? p.value : (subtotal * p.value) / 100;
  if (p.type !== "flat" && p.maxDiscount > 0) amount = Math.min(amount, p.maxDiscount);
  amount = round2(Math.min(amount, subtotal));
  if (!(amount > 0)) return no("Add items to use this code.");
  return { ok: true, amount };
}

// Shown as "Promo WELCOME10" on bills instead of plain "Discount".
export const promoLabel = (bill) => (bill?.promo?.code ? `Promo ${bill.promo.code}` : "Discount");
