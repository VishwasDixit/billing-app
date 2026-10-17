"use strict";

/* ESC/POS encoder for 58 mm thermal printers (plain ASCII, Font A). */
(function (root) {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

  const CURRENCY_ASCII = { "₹": "Rs.", "€": "EUR ", "£": "GBP ", "¥": "JPY ", "৳": "Tk ", "₨": "Rs." };

  // Printers only understand ASCII; anything else prints as garbage.
  function ascii(s) {
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

  function wrap(text, width) {
    const out = [];
    for (const para of ascii(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (!line) line = word;
        else if (line.length + 1 + word.length <= width) line += " " + word;
        else { out.push(line); line = word; }
        while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
      }
      if (line) out.push(line);
    }
    return out;
  }

  class Builder {
    constructor(cols = 32) {
      this.cols = cols;
      this.bytes = [ESC, 0x40]; // ESC @ : initialise
    }
    raw(...b) { this.bytes.push(...b); return this; }
    text(s) { for (const ch of ascii(s)) this.bytes.push(ch.charCodeAt(0)); return this; }
    line(s = "") { return this.text(s).raw(LF); }
    align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0); }
    bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
    size(w, h) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
    sep() { return this.line("-".repeat(this.cols)); }
    // Left text and right text on one line, right-aligned; wraps left text if needed.
    pair(left, right) {
      left = ascii(left); right = ascii(right);
      const room = this.cols - right.length - 1;
      if (left.length > room) {
        const lines = wrap(left, this.cols);
        const last = lines.pop();
        lines.forEach((l) => this.line(l));
        left = last.length > room ? (this.line(last), "") : last;
      }
      return this.line(left + " ".repeat(Math.max(1, this.cols - left.length - right.length)) + right);
    }
    centered(text, width = this.cols) { wrap(text, width).forEach((l) => this.line(l)); return this; }
    feed(n) { return this.raw(ESC, 0x64, n); }
    cut() { return this.raw(GS, 0x56, 0x01); }
    build() { return new Uint8Array(this.bytes); }
  }

  const n2 = (n) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  const pad2 = (n) => String(n).padStart(2, "0");

  /**
   * @param {object} s       settings (shopName, address, phone, gstin, currency, footer, charsPerLine, cutPaper)
   * @param {object} t       result of computeTotals()
   * @param {number} billNo
   * @param {Date}   date
   */
  function receipt(s, t, billNo, date = new Date()) {
    const cols = Number(s.charsPerLine) || 32;
    const b = new Builder(cols);
    const cur = ascii(s.currency);

    b.align("center");
    if (s.shopName) b.bold(true).size(2, 2).centered(s.shopName, Math.floor(cols / 2)).size(1, 1).bold(false);
    if (s.address) b.centered(s.address);
    if (s.phone) b.centered("Ph: " + s.phone);
    if (s.gstin) b.centered("GSTIN: " + s.gstin);
    b.align("left").sep();

    const d = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
    const tm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    b.pair(`Bill: ${billNo}`, `${d} ${tm}`).sep();

    for (const l of t.lines) {
      wrap(l.name, cols).forEach((ln) => b.line(ln));
      b.pair(`  ${l.qty} x ${n2(l.rate)}`, n2(l.amount));
    }
    b.sep();

    b.pair(`Items: ${t.lines.reduce((x, l) => x + l.qty, 0)}`, "");
    b.pair("Subtotal", n2(t.subtotal));
    if (t.discount > 0) b.pair(t.dType === "percent" ? `Discount ${t.dVal}%` : "Discount", "-" + n2(t.discount));
    if (t.gstPct > 0) {
      const half = Math.round((t.gst / 2) * 100) / 100;
      const pct = Math.round((t.gstPct / 2) * 100) / 100;
      b.pair(`CGST ${pct}%`, n2(half));
      b.pair(`SGST ${pct}%`, n2(t.gst - half));
    }
    b.sep();
    b.bold(true).size(1, 2).pair("TOTAL", cur + n2(t.total)).size(1, 1).bold(false);
    b.sep();

    if (s.footer) b.align("center").centered(s.footer).align("left");
    b.feed(4);
    if (s.cutPaper) b.cut();
    return b.build();
  }

  function testPage(s) {
    const cols = Number(s.charsPerLine) || 32;
    const b = new Builder(cols);
    b.align("center").bold(true).size(2, 2).line("TEST").size(1, 1).bold(false);
    b.line((s.shopName ? ascii(s.shopName) + " - " : "") + "printer OK").align("left").sep();
    let ruler = "";
    for (let i = 1; i <= cols; i++) ruler += i % 10;
    b.line(ruler);
    b.pair("Left", "Right").pair("Amount", ascii(s.currency) + "123.45").sep();
    b.line(`If the ruler above fits on one`).line(`line, ${cols} chars/line is right.`);
    b.feed(4);
    if (s.cutPaper) b.cut();
    return b.build();
  }

  const api = { receipt, testPage, ascii, wrap, Builder };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EscPos = api;
})(typeof window !== "undefined" ? window : globalThis);
