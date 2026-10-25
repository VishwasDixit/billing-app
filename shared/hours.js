// Opening hours for QR orders (Settings › Tables & QR ordering), in India time.
// hours: { enabled, open: "10:00", close: "21:00", closedDays: [0..6], message }
// A window like 18:00–02:00 runs past midnight; it belongs to the day it opens.
import { timeText } from "./promo.js";

const IST = 5.5 * 3600e3;
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DEFAULT_CLOSED_MESSAGE = "We're closed right now 😴 We open at {open}. See you soon! 🙏";
export const istDay = (at = new Date()) => new Date(at.getTime() + IST).toISOString().slice(0, 10);
const addDay = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const shortDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// The shop closed by hand (Settings › Opening hours): closure = { until: "YYYY-MM-DD" (last closed
// day) | "manual" (until opened again), message }.
export const closureActive = (closure, at = new Date()) => !!closure?.until && (closure.until === "manual" || istDay(at) <= closure.until);
export function closureMessage(closure, at = new Date()) {
  const manual = closure.until === "manual";
  const today = closure.until === istDay(at);
  const back = manual ? "soon" : today ? "tomorrow" : shortDate(addDay(closure.until, 1));
  const fallback = manual
    ? "We're closed right now 😴 Please check back soon! 🙏"
    : today
      ? "We're closed today 🙏 See you tomorrow!"
      : "We're closed for a few days 🙏 We'll be back on {open}.";
  return (closure.message?.trim() || fallback).replaceAll("{open}", back);
}

// Open for QR orders now? Closed by hand first, then the opening hours.
export function storeOpen(hours, at = new Date(), closure = null) {
  if (closureActive(closure, at)) return { open: false, closedByHand: true, message: closureMessage(closure, at) };
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
