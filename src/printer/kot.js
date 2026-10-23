// Kitchen order ticket (KOT): big order and table numbers, items and notes, no prices.
import { ascii, wrap, colsFor } from "./receipt.js";

const pad2 = (n) => String(n).padStart(2, "0");

export function kotRows(shop, order, { reprint = false } = {}) {
  const cols = colsFor(shop.printer);
  const half = Math.floor(cols / 2);
  const rows = [];
  const line = (text, opts = {}) => rows.push({ text, align: "left", ...opts });
  const center = (text, opts = {}) => wrap(text, opts.size === 2 ? half : cols).forEach((l) => line(l, { ...opts, align: "center" }));
  const sep = (ch = "-") => line(ch.repeat(cols));

  center(reprint ? "KOT (REPRINT)" : "KOT", { bold: true });
  center(`#${order.orderNo}`, { size: 2, bold: true });
  center(order.tableName || order.table || "", { size: 2, bold: true });
  const d = new Date(order.createdAt);
  center(`${pad2(d.getHours())}:${pad2(d.getMinutes())}  ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}  ${order.source === "qr" ? "QR order" : "Staff"}`);
  if (order.customerName) center(`For: ${order.customerName}`);
  sep("=");
  for (const it of order.items) {
    const name = it.variant ? `${it.name} (${it.variant})` : it.name;
    const qty = `${it.qty} x `;
    // Tall = double height only, so the full paper width is available.
    wrap(qty + name, cols - 4).forEach((l, i) => line(i === 0 ? l : "    " + l, { bold: true, tall: true }));
    if (it.note) wrap(`  > ${it.note}`, cols).forEach((l) => line(l));
  }
  sep("=");
  const count = order.items.reduce((s, i) => s + i.qty, 0);
  line(`Items: ${count}`);
  if (order.note) {
    sep();
    wrap("Note: " + ascii(order.note), cols).forEach((l) => line(l, { bold: true }));
  }
  return { logo: false, qr: null, rows, cols };
}
