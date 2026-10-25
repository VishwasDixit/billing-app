// Opening hours for QR orders (Settings › Tables & QR ordering), in India time.
// hours: { enabled, open: "10:00", close: "21:00", closedDays: [0..6], message }
// A window like 18:00–02:00 runs past midnight; it belongs to the day it opens.
import { timeText } from "./promo.js";

const IST = 5.5 * 3600e3;
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DEFAULT_CLOSED_MESSAGE = "We're closed right now 😴 We open at {open}. See you soon! 🙏";

export function storeOpen(hours, at = new Date()) {
  if (!hours?.enabled || !hours.open || !hours.close || hours.open === hours.close) return { open: true };
  const local = new Date(at.getTime() + IST);
  const now = local.toISOString().slice(11, 16);
  const day = local.getUTCDay();
  const off = (d) => (hours.closedDays || []).includes(d);
  const overnight = hours.open > hours.close;
  // Which day's opening we're in (after midnight in an overnight window: yesterday's).
  const inside = overnight ? (now >= hours.open && !off(day)) || (now < hours.close && !off((day + 6) % 7)) : now >= hours.open && now < hours.close && !off(day);
  if (inside) return { open: true, closesAt: timeText(hours.close) };
  // When it opens next: later today, or the next day that isn't a day off.
  let k = !off(day) && now < hours.open ? 0 : 1;
  while (k < 8 && off((day + k) % 7)) k++;
  const when = k === 0 ? timeText(hours.open) : k === 1 ? `${timeText(hours.open)} tomorrow` : `${timeText(hours.open)} on ${DAY_LONG[(day + k) % 7]}`;
  const message = (hours.message?.trim() || DEFAULT_CLOSED_MESSAGE).replaceAll("{open}", when).replaceAll("{close}", timeText(hours.close));
  return { open: false, opensAt: when, message };
}

// "10 am – 9 pm · closed Mon" for Settings and the customer page.
export function hoursText(hours) {
  if (!hours?.enabled) return "";
  const off = (hours.closedDays || []).map((d) => DAY_LONG[d].slice(0, 3));
  return `${timeText(hours.open)} – ${timeText(hours.close)}${off.length ? ` · closed ${off.join(", ")}` : ""}`;
}
