import { describe, it, expect } from "vitest";
import { receiptRows, PAPER } from "../src/printer/receipt.js";
import { encode } from "../src/printer/escpos.js";
import { computeTotals } from "../shared/totals.js";

const t = computeTotals(
  [
    { name: "Paneer Butter Masala", variant: "Full", qty: 1, rate: 270 },
    { name: "Extra Long Item Name That Needs Wrapping On Small Paper", qty: 3, rate: 15 },
  ],
  { type: "percent", value: 10 },
  5
);
const bill = { billNo: "A-12", createdAt: "2026-10-17T13:05:00+05:30", items: t.lines, itemCount: t.itemCount, subtotal: t.subtotal, discount: t.discount, gst: t.gst, total: t.total, paymentMode: "upi" };
const shop = (paperSize, extra = {}) => ({
  name: "GrillHive",
  address: "Pahadpur Road, BKT, Lucknow",
  phone: "9336463647",
  currency: "₹",
  footer: "Thank you! Visit again.",
  printer: { paperSize, charsPerLine: PAPER[paperSize].cols, method: "bluetooth", ...extra },
});

describe("receipt layout", () => {
  for (const [size, cols] of [[58, 32], [80, 48], [110, 64]]) {
    it(`fits ${size} mm paper in ${cols} columns`, () => {
      const { rows } = receiptRows(shop(size), bill);
      expect(Math.max(...rows.map((r) => r.text.length))).toBeLessThanOrEqual(cols);
      expect(rows.some((r) => r.text.length === cols)).toBe(true);
      expect(rows.find((r) => r.text.startsWith("TOTAL")).text).toMatch(/Rs\.\d+\.\d\d$/);
    });
  }

  it("has printer dot widths for each paper size", () => {
    expect([PAPER[58].dots, PAPER[80].dots, PAPER[110].dots]).toEqual([384, 576, 832]);
  });

  it("encodes plain ASCII ESC/POS with no bold or double size unless large text is on", () => {
    const has = (b, x, y) => b.some((v, i) => v === x && b[i + 1] === y);
    const plain = encode(receiptRows(shop(58), bill), shop(58));
    expect([plain[0], plain[1]]).toEqual([0x1b, 0x40]);
    expect(has(plain, 0x1d, 0x21)).toBe(false); // GS ! (size)
    expect(plain.every((v) => v <= 0x7f)).toBe(true); // ASCII text, no stray UTF-8 (e.g. the rupee sign)
    const large = encode(receiptRows(shop(58, { largeText: true }), bill), shop(58, { largeText: true }));
    expect(has(large, 0x1d, 0x21)).toBe(true);
  });

  it("shows the customer and dues on udhar bills", () => {
    for (const size of [58, 80, 110]) {
      const { rows, cols } = receiptRows(shop(size), {
        ...bill,
        paymentMode: "credit",
        paidNow: 100,
        creditAmount: bill.total - 100,
        dueAfter: 1250.5,
        customer: { name: "Ramesh Kumar Yadav From Pahadpur Road Colony", phone: "9876501234" },
      });
      const text = rows.map((r) => r.text);
      expect(Math.max(...text.map((t) => t.length))).toBeLessThanOrEqual(cols);
      expect(text.some((t) => t.startsWith("Customer: Ramesh"))).toBe(true);
      expect(text).toContain("Ph: 9876501234");
      expect(text.find((t) => t.startsWith("Paid by"))).toMatch(/UDHAR$/);
      expect(text.find((t) => t.startsWith("Total due"))).toMatch(/Rs\.1250\.50$/);
    }
  });
});
