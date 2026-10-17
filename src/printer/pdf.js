// Bill as a PDF at the printer's paper width, for sharing on WhatsApp etc.
import { receiptRows } from "./receipt.js";

const PT_PER_MM = 72 / 25.4;

export async function billPdf(shop, bill) {
  const { jsPDF } = await import("jspdf"); // loaded on first use
  const paper = Number(shop.printer?.paperSize) || 58;
  const layout = receiptRows({ ...shop, printer: { ...shop.printer, largeText: false } }, bill);
  const margin = 4;
  const usable = paper - margin * 2;
  // Courier glyphs are 0.6 em wide: size the font so one row fills the width.
  const fontPt = (usable * PT_PER_MM) / (layout.cols * 0.6);
  const lineMm = (fontPt * 1.3) / PT_PER_MM;

  // The PDF always shows the logo: unlike thermal printing it costs no battery.
  let logo = null;
  if (shop.logo) {
    try {
      const props = new jsPDF().getImageProperties(shop.logo);
      const w = Math.min(usable * 0.45, 30);
      logo = { w, h: (props.height / props.width) * w };
    } catch {
      logo = null; // unsupported image format: skip the logo
    }
  }

  const height = margin * 2 + (logo ? logo.h + 2 : 0) + layout.rows.length * lineMm + 2;
  const doc = new jsPDF({ unit: "mm", format: [paper, Math.max(height, 40)], orientation: "portrait" });
  doc.setProperties({ title: `Bill ${bill.billNo}` });

  let y = margin;
  if (logo) {
    const fmt = /^data:image\/(\w+)/.exec(shop.logo)?.[1]?.toUpperCase() || "PNG";
    doc.addImage(shop.logo, fmt === "JPG" ? "JPEG" : fmt, (paper - logo.w) / 2, y, logo.w, logo.h);
    y += logo.h + 2;
  }
  for (const row of layout.rows) {
    y += lineMm;
    doc.setFont("courier", row.bold ? "bold" : "normal");
    doc.setFontSize(fontPt);
    if (row.align === "center") doc.text(row.text, paper / 2, y - lineMm * 0.25, { align: "center" });
    else doc.text(row.text, margin, y - lineMm * 0.25);
  }
  return doc;
}

// Opens the share sheet (WhatsApp, etc.) where supported, otherwise downloads.
export async function shareBillPdf(shop, bill) {
  const blob = (await billPdf(shop, bill)).output("blob");
  const name = `Bill-${bill.billNo}.pdf`;
  const file = new File([blob], name, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${shop.name} – Bill ${bill.billNo}` });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}
