// Printable table QR codes (A4 PDF, 6 per page): customers scan to see the menu and order.
export const orderUrl = (shop, tableId) => `${window.location.origin}/order/${shop.orderToken}?t=${encodeURIComponent(tableId)}`;

export async function downloadTableQrs(shop, tables, { part = 0 } = {}) {
  const [{ jsPDF }, { qrMatrix }] = await Promise.all([import("jspdf"), import("../../shared/billQr.js")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, H = 297, cols = 2, rows = 3, cw = W / cols, ch = H / rows;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (i > 0 && i % (cols * rows) === 0) doc.addPage();
    const slot = i % (cols * rows);
    const x = (slot % cols) * cw;
    const y = Math.floor(slot / cols) * ch;
    doc.setDrawColor(200);
    doc.setLineDashPattern([2, 2], 0);
    doc.rect(x + 4, y + 4, cw - 8, ch - 8);
    doc.setLineDashPattern([], 0);
    doc.setTextColor(30);
    doc.setFontSize(13);
    doc.text(String(shop.name).slice(0, 34), x + cw / 2, y + 16, { align: "center" });
    doc.setFontSize(22);
    doc.setFont(undefined, "bold");
    doc.text(t.name, x + cw / 2, y + 27, { align: "center" });
    doc.setFont(undefined, "normal");
    // Drawn as squares: sharp at any print size and only a few KB.
    const m = qrMatrix(orderUrl(shop, t.id));
    const size = 50;
    const cell = size / m.length;
    const qx = x + (cw - size) / 2;
    doc.setFillColor(0, 0, 0);
    m.forEach((row, r) => row.forEach((dark, c) => dark && doc.rect(qx + c * cell, y + 31 + r * cell, cell + 0.02, cell + 0.02, "F")));
    doc.setFontSize(11);
    doc.text("Scan to see the menu and order", x + cw / 2, y + 87, { align: "center" });
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(shop.qrPayment === "first" ? "Pay when you order" : shop.qrPayment === "choose" ? "Pay now or after your meal" : "Pay at the counter after your meal", x + cw / 2, y + 92, { align: "center" });
  }
  doc.save(`${String(shop.name).replace(/[^\w-]+/g, "-")}-table-QR-codes${part ? `-part-${part}` : ""}.pdf`);
}
