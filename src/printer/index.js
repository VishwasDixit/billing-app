import { receiptRows, testRows, PAPER } from "./receipt.js";
import { encode, prepareLogo } from "./escpos.js";
import { sendBytes } from "./transports.js";

export { receiptRows, PAPER };

// Prints a bill with the shop's saved printer settings.
// Must be called directly from a click: the Bluetooth chooser needs the user gesture.
export function printBill(shop, bill) {
  const method = shop.printer?.method || "bluetooth";
  if (method === "browser") return browserPrint(shop, receiptRows(shop, bill));
  const bytes = encode(receiptRows(shop, bill), shop);
  return sendBytes(method, bytes, { slowMode: shop.printer?.slowMode });
}

export function printTest(shop) {
  const method = shop.printer?.method || "bluetooth";
  if (method === "browser") return browserPrint(shop, testRows(shop));
  return sendBytes(method, encode(testRows(shop), shop), { slowMode: shop.printer?.slowMode });
}

// Warm the logo raster cache so print bytes can be built synchronously.
export function warmLogo(shop) {
  if (shop?.logo && shop.printer?.printLogo) prepareLogo(shop.logo, shop.printer.paperSize).catch(() => {});
}

// Fallback for printers installed in the OS: the browser's print dialog at the paper width.
function browserPrint(shop, layout) {
  const paper = Number(shop.printer?.paperSize) || 58;
  const widthMm = paper - 10;
  let el = document.getElementById("print-receipt");
  if (!el) {
    el = document.createElement("div");
    el.id = "print-receipt";
    document.body.appendChild(el);
  }
  let style = document.getElementById("print-page-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "print-page-style";
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${paper}mm auto; margin: 0; } #print-receipt { width: ${widthMm}mm; font-size: ${(widthMm * 2.83) / (layout.cols * 0.6)}pt; }`;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  el.innerHTML =
    (layout.logo ? `<div class="r-center"><img src="${shop.logo}" alt=""></div>` : "") +
    layout.rows
      .map((r) => `<div class="${r.align === "center" ? "r-center" : ""}${r.bold ? " r-bold" : ""}">${esc(r.text) || "&nbsp;"}</div>`)
      .join("");
  window.print();
}
