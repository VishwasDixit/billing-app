// WhatsApp messages for udhar reminders and payment receipts.

// Indian mobile numbers -> wa.me format (country code, digits only). null if unusable.
export function waNumber(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 13 ? d : null;
}

// Message text (in the chosen language) lives in shared/messages.js.
export { reminderText, receiptText } from "../../shared/messages.js";

export const waLink = (phone, text) => {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
};

// Was this reminded today (India time)?
export function remindedToday(at) {
  if (!at) return false;
  const day = (d) => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
  return day(at) === day(Date.now());
}

export function timeAgo(at) {
  if (!at) return "";
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
