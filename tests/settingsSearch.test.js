// Settings search: finds a row by its name, description or keywords.
import { describe, it, expect } from "vitest";
import { matchSetting } from "../src/lib/settingsSearch.js";

const printer = { title: "Printer", desc: "Paper size, Bluetooth, test print", keywords: ["58mm", "rawbt"] };
const bill = { title: "Bill defaults", desc: "GST, discount, customer details", keywords: ["tax"] };

describe("settings search", () => {
  it("matches name, description and keywords, any case", () => {
    expect(matchSetting(printer, "PRINT")).toBe(true);
    expect(matchSetting(printer, "bluetooth")).toBe(true);
    expect(matchSetting(printer, "58mm")).toBe(true);
    expect(matchSetting(printer, "58 mm")).toBe(true);
    expect(matchSetting(bill, "gst")).toBe(true);
    expect(matchSetting(bill, "tax")).toBe(true);
  });

  it("needs every word, and an empty search shows everything", () => {
    expect(matchSetting(bill, "gst discount")).toBe(true);
    expect(matchSetting(bill, "gst printer")).toBe(false);
    expect(matchSetting(printer, "xyz")).toBe(false);
    expect(matchSetting(printer, "  ")).toBe(true);
  });
});
