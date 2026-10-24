export const num2 = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);

export function money(n, currency = "₹") {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const a = Math.abs(v);
  // Minus before the ₹ sign: −₹250, not ₹-250.
  return (v < 0 ? "−" : "") + currency + a.toLocaleString("en-IN", { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

// Today's date in India as YYYY-MM-DD.
export function todayYmd(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
}

export function monthStartYmd() {
  return todayYmd().slice(0, 8) + "01";
}

export function fmtDateTime(d) {
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

export function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export const pad2 = (n) => String(n).padStart(2, "0");

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}
