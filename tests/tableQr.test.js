// Table QR cards: picking tables by number, and the QR link staying the same as before.
import { describe, it, expect } from "vitest";
import { orderUrl, parseTableNumbers, buildTableQrPdf } from "../src/lib/tableQr.js";
import { qrMatrix } from "../shared/billQr.js";
import { jsPDF } from "jspdf";

const tables = [...Array(12)].map((_, i) => ({ id: `T${i + 1}`, name: `Table ${i + 1}` })).concat({ id: "T20", name: "Garden 7" });

describe("table QR cards", () => {
  it("picks tables from numbers and ranges", () => {
    expect(parseTableNumbers("1-3, 7", tables)).toEqual(["T1", "T2", "T3", "T7", "T20"]); // Garden 7 too
    expect(parseTableNumbers("12-11; abc, 99", tables)).toEqual(["T11", "T12"]);
    expect(parseTableNumbers("", tables)).toEqual([]);
    expect(parseTableNumbers("1-999999", tables).length).toBe(tables.length);
  });

  it("keeps the same QR link as the cards already printed", () => {
    expect(orderUrl({ orderToken: "Abc123Abc123Abc123" }, "T 5", "https://shop.example")).toBe("https://shop.example/order/Abc123Abc123Abc123?t=T%205");
  });

  it("makes 4 cards per page", () => {
    const doc = buildTableQrPdf(jsPDF, qrMatrix, { name: "GrillHive", orderToken: "Abc123Abc123Abc123" }, tables.slice(0, 6), { origin: "https://x" });
    expect(doc.getNumberOfPages()).toBe(2);
  });
});
