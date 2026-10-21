// ESC/POS encoder for thermal printers (58 / 80 / 110 mm).
import { PAPER } from "./receipt.js";
import { qrRaster } from "../../shared/billQr.js";

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// Logo rasters are prepared ahead of time (image decoding is async) so that
// building print bytes stays synchronous: Chrome's Bluetooth chooser only opens
// inside the click that started printing.
const logoCache = new Map();

// An uploaded QR picture: bigger than a logo, and pure black/white (dithering would blur it).
const QR_IMAGE = { frac: 0.6, maxH: 0.6, dither: false };
export const prepareQrImage = (dataUrl, paperSize) => prepareLogo(dataUrl, paperSize, QR_IMAGE);
export const cachedQrImage = (dataUrl, paperSize) => (dataUrl ? logoCache.get(paperSize + "|qr|" + dataUrl) || null : null);

export async function prepareLogo(dataUrl, paperSize, opts = null) {
  if (!dataUrl) return null;
  const key = paperSize + (opts ? "|qr|" : "|") + dataUrl;
  if (logoCache.has(key)) return logoCache.get(key);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const dots = PAPER[paperSize]?.dots || 384;
  const maxH = opts ? Math.round(dots * opts.maxH) : 160;
  let w = Math.floor((dots * (opts?.frac ?? 0.5)) / 8) * 8;
  let h = Math.round((img.height / img.width) * w);
  if (h > maxH) {
    h = maxH;
    w = Math.max(8, Math.floor(((img.width / img.height) * h) / 8) * 8);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // Grayscale + Floyd–Steinberg dithering to 1-bit.
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const bytesPerRow = w / 8;
  const data = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const black = gray[i] < 128;
      const err = opts && !opts.dither ? 0 : gray[i] - (black ? 0 : 255);
      if (black) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      if (x + 1 < w) gray[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += (err * 3) / 16;
        gray[i + w] += (err * 5) / 16;
        if (x + 1 < w) gray[i + w + 1] += err / 16;
      }
    }
  }
  const raster = { bytesPerRow, height: h, data };
  logoCache.set(key, raster);
  return raster;
}

export function cachedLogo(dataUrl, paperSize) {
  return dataUrl ? logoCache.get(paperSize + "|" + dataUrl) || null : null;
}

/** @param {{logo: boolean, rows: Array}} layout  @param {object} shop */
export function encode(layout, shop) {
  const p = shop.printer || {};
  const out = [ESC, 0x40]; // initialise
  const push = (...b) => out.push(...b);
  const text = (s) => {
    for (const ch of s) push(ch.charCodeAt(0) & 0x7f);
  };

  if (layout.logo) {
    const r = cachedLogo(shop.logo, p.paperSize);
    if (r) {
      push(ESC, 0x61, 1); // center
      push(GS, 0x76, 0x30, 0, r.bytesPerRow & 0xff, r.bytesPerRow >> 8, r.height & 0xff, r.height >> 8);
      for (const b of r.data) push(b);
      push(LF);
    }
  }

  for (const row of layout.rows) {
    if (row.qr) {
      const dots = PAPER[p.paperSize]?.dots || 384;
      const r = layout.qr?.kind === "upi" ? qrRaster(layout.qr.payload, Math.round(dots * 0.6)) : cachedQrImage(layout.qr?.image, p.paperSize);
      if (r) {
        push(ESC, 0x61, 1);
        push(GS, 0x76, 0x30, 0, r.bytesPerRow & 0xff, r.bytesPerRow >> 8, r.height & 0xff, r.height >> 8);
        for (const b of r.data) push(b);
        push(LF);
      }
      continue;
    }
    push(ESC, 0x61, row.align === "center" ? 1 : 0);
    if (row.bold) push(ESC, 0x45, 1);
    if (row.size === 2) push(GS, 0x21, 0x11);
    else if (row.tall) push(GS, 0x21, 0x01);
    text(row.text);
    push(LF);
    if (row.size === 2 || row.tall) push(GS, 0x21, 0x00);
    if (row.bold) push(ESC, 0x45, 0);
  }
  push(ESC, 0x61, 0);
  push(ESC, 0x64, 4); // feed 4 lines
  if (p.cut) push(GS, 0x56, 0x01);
  return new Uint8Array(out);
}
