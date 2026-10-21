// Payment QR printed on bills: either a UPI QR made from the shop's UPI ID with the
// bill's exact amount, or the shop's own uploaded QR picture.
import QRCode from "qrcode";

// What the customer still has to pay on this bill (udhar: the unpaid part).
export const qrAmount = (bill) => Math.round((bill.paymentMode === "credit" ? bill.creditAmount ?? bill.total - (bill.paidNow || 0) : bill.total) * 100) / 100;

// Which QR (if any) this bill gets.
export function billQr(shop, bill) {
  const mode = shop.qrMode || "off";
  if (mode === "off" || bill.status === "void") return null;
  if (shop.qrOn === "credit" && bill.paymentMode !== "credit") return null;
  const amount = qrAmount(bill);
  if (mode === "upi") {
    if (!shop.upiId || !(amount > 0)) return null;
    const p = new URLSearchParams({ pa: shop.upiId, pn: (shop.name || "Shop").slice(0, 40), am: amount.toFixed(2), cu: "INR", tn: `Bill ${bill.billNo}` });
    return { kind: "upi", amount, payload: "upi://pay?" + p.toString().replace(/\+/g, "%20") };
  }
  if (mode === "image" && shop.qrImage) return { kind: "image", amount, image: shop.qrImage };
  return null;
}

// QR modules as rows of booleans (true = dark), quiet zone not included.
export function qrMatrix(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const rows = [];
  for (let r = 0; r < modules.size; r++) {
    const row = [];
    for (let c = 0; c < modules.size; c++) row.push(!!modules.get(r, c));
    rows.push(row);
  }
  return rows;
}

// 1-bit raster for ESC/POS "GS v 0", centred-friendly width (multiple of 8 dots).
export function qrRaster(text, maxDots) {
  const m = qrMatrix(text);
  const quiet = 2;
  const cells = m.length + quiet * 2;
  const scale = Math.max(2, Math.floor(maxDots / cells));
  const w = Math.ceil((cells * scale) / 8) * 8;
  const h = cells * scale;
  const bytesPerRow = w / 8;
  const data = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / scale) - quiet;
    if (r < 0 || r >= m.length) continue;
    for (let x = 0; x < cells * scale; x++) {
      const c = Math.floor(x / scale) - quiet;
      if (c >= 0 && c < m.length && m[r][c]) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bytesPerRow, height: h, data };
}

// Crisp SVG for screens and the browser print dialog.
export function qrSvg(text, sizePx = 180) {
  const m = qrMatrix(text);
  const n = m.length + 4;
  let path = "";
  m.forEach((row, r) => row.forEach((dark, c) => dark && (path += `M${c + 2} ${r + 2}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
