// Printable table QR cards (A4 PDF, 4 postcard-size cards per page): customers scan with the phone
// camera or Google Lens to see the menu and order. The QR link never changes with the design, so
// cards already on the tables keep working.
export const orderUrl = (shop, tableId, origin = window.location.origin) => `${origin}/order/${shop.orderToken}?t=${encodeURIComponent(tableId)}`;

const ORANGE = [232, 73, 43];
const DEEP = [184, 50, 24];
const SOFT = [253, 237, 232];
const INK = [31, 31, 31];
const GREY = [110, 110, 110];

// "1-10, 15" → those tables' ids, by the number in the table's id (T5) or name (Garden 5).
export function parseTableNumbers(text, tables) {
  const want = new Set();
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Math.min(Number(m[2] ?? m[1]), a + 999);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) want.add(n);
  }
  const num = (s) => Number(/(\d+)\D*$/.exec(String(s))?.[1] ?? NaN);
  return tables.filter((t) => want.has(num(t.id)) || want.has(num(t.name))).map((t) => t.id);
}

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

// The shop logo as a round PNG (jsPDF can't read WebP, and a circle looks best on the band).
export async function roundLogo(src) {
  if (!src) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const s = 300;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, s, s);
    // Whole logo inside the circle, not stretched.
    const k = Math.min((s * 0.78) / img.width, (s * 0.78) / img.height);
    ctx.drawImage(img, (s - img.width * k) / 2, (s - img.height * k) / 2, img.width * k, img.height * k);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

// Biggest font size (down to min) at which the text fits the width.
function fit(doc, text, maxW, size, min) {
  let s = size;
  doc.setFontSize(s);
  while (s > min && doc.getTextWidth(text) > maxW) doc.setFontSize((s -= 0.5));
  return s;
}

function card(doc, shop, t, x, y, { logo, origin, qrMatrix }) {
  const w = 95, h = 138.5, cx = x + w / 2;
  // Card and the orange band (rounded at the top only).
  doc.setDrawColor(230);
  doc.setLineWidth(0.3);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, w, h, 4, 4, "FD");
  doc.setFillColor(...ORANGE);
  doc.roundedRect(x, y, w, 26, 4, 4, "F");
  doc.rect(x, y + 20, w, 6, "F");

  // Logo (or the shop's initials) in a white circle, shop name under it.
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, y + 10.5, 7.8, "F");
  if (logo) doc.addImage(logo, "PNG", cx - 7.4, y + 3.1, 14.8, 14.8, "shoplogo", "FAST");
  else {
    doc.setTextColor(...ORANGE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(initials(shop.name), cx, y + 12.8, { align: "center" });
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  fit(doc, String(shop.name), w - 12, 12, 7);
  doc.text(String(shop.name), cx, y + 23.3, { align: "center" });

  // Headline.
  doc.setTextColor(...INK);
  doc.setFontSize(17);
  doc.text("Hungry? Scan to order!", cx, y + 34.5, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...GREY);
  doc.text("Menu  ·  Photos  ·  Order from your table", cx, y + 40, { align: "center" });

  // Table pill.
  const label = String(t.name).toUpperCase();
  doc.setFont("helvetica", "bold");
  fit(doc, label, w - 24, 11, 7);
  const pw = Math.min(w - 14, doc.getTextWidth(label) + 12);
  doc.setFillColor(...ORANGE);
  doc.roundedRect(cx - pw / 2, y + 43, pw, 8, 4, 4, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(label, cx, y + 48.6, { align: "center" });

  // QR in a white box with orange corner brackets ("scan here"). Drawn as squares: sharp at any size.
  const box = 50, bx = cx - box / 2, by = y + 54.5;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(235);
  doc.roundedRect(bx, by, box, box, 3, 3, "FD");
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(1.1);
  const L = 7, o = 1.2;
  [[bx - o, by - o, 1, 1], [bx + box + o, by - o, -1, 1], [bx - o, by + box + o, 1, -1], [bx + box + o, by + box + o, -1, -1]].forEach(([px, py, dx, dy]) => {
    doc.line(px, py, px + dx * L, py);
    doc.line(px, py, px, py + dy * L);
  });
  const m = qrMatrix(orderUrl(shop, t.id, origin));
  const size = 44;
  const cell = size / m.length;
  const qx = cx - size / 2, qy = by + (box - size) / 2;
  doc.setFillColor(0, 0, 0);
  m.forEach((row, r) => row.forEach((dark, c) => dark && doc.rect(qx + c * cell, qy + r * cell, cell + 0.02, cell + 0.02, "F")));

  // How to scan: three numbered steps.
  const steps = ["Open your phone camera or Google Lens", "Point it at the QR code above", "See the food menu & order from your table"];
  steps.forEach((s, i) => {
    const sy = y + 111 + i * 6;
    doc.setFillColor(...ORANGE);
    doc.circle(x + 9, sy - 1.1, 2.3, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.text(String(i + 1), x + 9, sy + 0.1, { align: "center" });
    doc.setTextColor(...INK);
    doc.setFont("helvetica", i === 0 ? "bold" : "normal");
    fit(doc, s, w - 18, 8.5, 6.5);
    doc.text(s, x + 13.5, sy);
  });

  // How to pay, then a footer strip.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...DEEP);
  doc.text(shop.qrPayment === "first" ? "Pay when you order" : shop.qrPayment === "choose" ? "Pay now or after your meal" : "Pay at the counter after your meal", cx, y + 129, { align: "center" });
  doc.setFillColor(...SOFT);
  doc.roundedRect(x, y + h - 6.5, w, 6.5, 4, 4, "F");
  doc.rect(x, y + h - 6.5, w, 3, "F");
  doc.setTextColor(...DEEP);
  doc.setFontSize(7);
  doc.text("No app needed  ·  Prices always up to date", cx, y + h - 2.3, { align: "center" });
}

// The PDF itself (no browser needed, so it can be tested).
export function buildTableQrPdf(jsPDF, qrMatrix, shop, tables, { logo = null, origin } = {}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const cw = 105, ch = 148.5;
  for (let i = 0; i < tables.length; i++) {
    const slot = i % 4;
    if (i > 0 && slot === 0) doc.addPage();
    if (slot === 0) {
      // Cut lines between the four cards.
      doc.setDrawColor(200);
      doc.setLineWidth(0.2);
      doc.setLineDashPattern([2, 2], 0);
      doc.line(cw, 0, cw, 297);
      doc.line(0, ch, 210, ch);
      doc.setLineDashPattern([], 0);
    }
    card(doc, shop, tables[i], (slot % 2) * cw + 5, Math.floor(slot / 2) * ch + 5, { logo, origin, qrMatrix });
  }
  return doc;
}

export async function downloadTableQrs(shop, tables, { part = 0 } = {}) {
  const [{ jsPDF }, { qrMatrix }, logo] = await Promise.all([import("jspdf"), import("../../shared/billQr.js"), roundLogo(shop.logo)]);
  const doc = buildTableQrPdf(jsPDF, qrMatrix, shop, tables, { logo, origin: window.location.origin });
  doc.save(`${String(shop.name).replace(/[^\w-]+/g, "-")}-table-QR-codes${part ? `-part-${part}` : ""}.pdf`);
}
