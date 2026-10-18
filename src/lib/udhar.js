// WhatsApp messages for udhar reminders and payment receipts.

// Indian mobile numbers -> wa.me format (country code, digits only). null if unusable.
export function waNumber(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 13 ? d : null;
}

const rs = (n) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");

export function reminderText(customer, shop) {
  return [
    `Namaste ${customer.name} ji 🙏`,
    `${shop.name} par aapka udhar ${rs(customer.due)} baaki hai.`,
    `Kripya jaldi bhugtan karein.`,
    shop.upiId ? `UPI: ${shop.upiId}` : "",
    `Dhanyavaad!`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function receiptText(customer, shop, amount, balance) {
  return [
    `Namaste ${customer.name} ji 🙏`,
    `${shop.name} ko aapka ${rs(amount)} mil gaya hai. Dhanyavaad!`,
    balance > 0 ? `Baaki udhar: ${rs(balance)}` : `Aapka pura udhar chuk gaya hai ✅`,
  ].join("\n");
}

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
