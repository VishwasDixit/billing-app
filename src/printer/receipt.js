// One receipt layout shared by thermal printing (ESC/POS), PDF and the browser
// print dialog. Rows are plain ASCII already laid out to the printer's width.
import { billQr } from "../../shared/billQr.js";

export const PAPER = {
  58: { dots: 384, cols: 32 },
  80: { dots: 576, cols: 48 },
  110: { dots: 832, cols: 64 },
};

const CURRENCY_ASCII = { "₹": "Rs.", "€": "EUR ", "£": "GBP ", "¥": "JPY ", "৳": "Tk ", "₨": "Rs." };

// Thermal printers only understand ASCII; anything else prints as garbage.
export function ascii(s) {
  return String(s ?? "")
    .replace(/[₹€£¥৳₨]/g, (c) => CURRENCY_ASCII[c])
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e\n]/g, "");
}

export function wrap(text, width) {
  const out = [];
  for (const para of ascii(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) out.push(line);
  }
  return out;
}

const n2 = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const pad2 = (n) => String(n).padStart(2, "0");

export function colsFor(printer) {
  return Number(printer?.charsPerLine) || PAPER[printer?.paperSize]?.cols || 32;
}

/**
 * @returns {{ logo: boolean, qr: object|null, rows: Array<{text: string, align: 'left'|'center', bold?: boolean, size?: 1|2, tall?: boolean, qr?: boolean}> }}
 *   size 2 = double width + height (shop name); tall = double height only (TOTAL); qr = the payment QR goes here.
 */
export function receiptRows(shop, bill) {
  const p = shop.printer || {};
  const cols = colsFor(p);
  const large = !!p.largeText;
  const rows = [];
  const line = (text, opts = {}) => rows.push({ text, align: "left", ...opts });
  const center = (text, opts = {}) => wrap(text, opts.size === 2 ? Math.floor(cols / 2) : cols).forEach((l) => line(l, { ...opts, align: "center" }));
  const sep = () => line("-".repeat(cols));
  const pair = (left, right, opts) => {
    left = ascii(left);
    right = ascii(right);
    const room = cols - right.length - 1;
    if (left.length > room) {
      const lines = wrap(left, cols);
      const last = lines.pop();
      lines.forEach((l) => line(l, opts));
      if (last.length > room) {
        line(last, opts);
        left = "";
      } else left = last;
    }
    line(left + " ".repeat(Math.max(1, cols - left.length - right.length)) + right, opts);
  };

  if (shop.name) center(shop.name, large ? { size: 2, bold: true } : { bold: true });
  if (shop.gstin) center("GSTIN: " + shop.gstin, { bold: true });
  if (shop.address) center(shop.address);
  if (shop.phone) center("Ph: " + shop.phone);
  sep();

  const d = new Date(bill.createdAt);
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  pair(`Bill: ${bill.billNo}`, `${date} ${time}`);
  if (bill.table) line(`Table: ${ascii(bill.table)}`);
  if (bill.status === "void" || bill.status === "deleted") center("*** CANCELLED ***", { bold: true });
  if (bill.editedAt && bill.status === "paid") {
    const e = new Date(bill.editedAt);
    center(`*** REVISED ${pad2(e.getDate())}/${pad2(e.getMonth() + 1)} ${pad2(e.getHours())}:${pad2(e.getMinutes())} ***`, { bold: true });
  }
  if (bill.customer?.name) {
    wrap("Customer: " + bill.customer.name, cols).forEach((l) => line(l));
    if (bill.customer.phone) line("Ph: " + bill.customer.phone);
  }
  sep();

  for (const it of bill.items) {
    wrap(it.variant ? `${it.name} (${it.variant})` : it.name, cols).forEach((l) => line(l));
    pair(`  ${it.qty} x ${n2(it.rate)}`, n2(it.amount ?? it.qty * it.rate));
  }
  sep();

  const count = bill.itemCount ?? bill.items.reduce((s, i) => s + i.qty, 0);
  pair(`Items: ${count}`, "");
  pair("Subtotal", n2(bill.subtotal));
  if (bill.discount?.amount > 0) {
    pair(bill.discount.type === "percent" ? `Discount ${bill.discount.value}%` : "Discount", "-" + n2(bill.discount.amount));
  }
  if (bill.gst?.percent > 0) {
    const half = Math.round((bill.gst.amount / 2) * 100) / 100;
    const pct = Math.round((bill.gst.percent / 2) * 100) / 100;
    pair(`CGST ${pct}%`, n2(half));
    pair(`SGST ${pct}%`, n2(bill.gst.amount - half));
  }
  sep();
  pair("TOTAL", ascii(shop.currency || "₹") + n2(bill.total), large ? { bold: true, tall: true } : { bold: true });
  if (bill.paymentMode === "credit") {
    // Udhar: what was paid now, what is owed, and the customer's total due if known.
    pair("Paid by", "UDHAR");
    pair("Paid now", n2(bill.paidNow || 0));
    pair("Udhar (this bill)", n2(bill.creditAmount ?? bill.total - (bill.paidNow || 0)));
    if (typeof bill.dueAfter === "number") pair("Total due", ascii(shop.currency || "₹") + n2(bill.dueAfter), { bold: true });
  } else if (bill.paymentMode) pair("Paid by", bill.paymentMode.toUpperCase());
  sep();
  const qr = billQr(shop, bill);
  if (qr) {
    center(`Scan & pay ${ascii(shop.currency || "₹")}${n2(qr.amount)}`, { bold: true });
    rows.push({ text: "", align: "center", qr: true });
    if (qr.kind === "upi") center("GPay / PhonePe / Paytm / any UPI app");
    sep();
  }
  if (shop.footer) center(shop.footer);

  return { logo: !!(p.printLogo && shop.logo), qr, rows, cols };
}

export function testRows(shop) {
  const cols = colsFor(shop.printer);
  let ruler = "";
  for (let i = 1; i <= cols; i++) ruler += i % 10;
  // A Rs.1 sample of the bill QR, to check the printer prints it scannable.
  const qr = billQr(shop, { billNo: "TEST", total: 1, paymentMode: "credit", creditAmount: 1 });
  return {
    logo: !!(shop.printer?.printLogo && shop.logo),
    cols,
    qr,
    rows: [
      { text: "TEST PRINT", align: "center" },
      { text: "printer OK", align: "center" },
      { text: "-".repeat(cols), align: "left" },
      { text: ruler, align: "left" },
      { text: "If the ruler fits on one line,", align: "left" },
      { text: `${cols} chars/line is right.`, align: "left" },
      ...(qr ? [{ text: "-".repeat(cols), align: "left" }, { text: "Sample QR (Rs.1):", align: "center" }, { text: "", align: "center", qr: true }] : []),
    ],
  };
}
