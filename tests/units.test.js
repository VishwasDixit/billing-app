// Unit tests for small shared pieces: bill maths, money format, units, salary edge cases.
import { describe, it, expect } from "vitest";
import { computeTotals, round2 } from "../shared/totals.js";
import { money } from "../src/lib/format.js";
import { convert, fmtQty, sameKind } from "../shared/kitchenUnits.js";
import { salaryFor, loanFor, autoStatus, wageFor, addMonths, monthsBetween } from "../shared/salary.js";
import { isOldBill, DELETE_REASONS, EDIT_REASONS } from "../shared/billChanges.js";

describe("bill totals", () => {
  const items = [
    { name: "Tea", qty: 3, rate: 15 },
    { name: "Samosa", qty: 2, rate: 12.5 },
  ];
  it("adds lines, applies percent discount before GST", () => {
    const t = computeTotals(items, { type: "percent", value: 10 }, 5);
    expect(t.subtotal).toBe(70);
    expect(t.discount.amount).toBe(7);
    expect(t.taxable).toBe(63);
    expect(t.gst.amount).toBe(3.15);
    expect(t.total).toBe(66.15);
    expect(t.itemCount).toBe(5);
  });
  it("never discounts more than the subtotal, and ignores negative or junk values", () => {
    expect(computeTotals(items, { type: "flat", value: 999 }).total).toBe(0);
    expect(computeTotals(items, { type: "percent", value: 250 }).total).toBe(0);
    expect(computeTotals(items, { type: "flat", value: -50 }).total).toBe(70);
    expect(computeTotals(items, { type: "weird", value: "abc" }, "x").total).toBe(70);
  });
  it("rounds to paise without floating-point drift", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(computeTotals([{ qty: 3, rate: 33.33 }], undefined, 18).total).toBe(117.99);
  });
});

describe("money format", () => {
  it("formats rupees Indian-style, minus before the sign", () => {
    expect(money(150000)).toBe("₹1,50,000");
    expect(money(12.5)).toBe("₹12.50");
    expect(money(-2838.71)).toBe("−₹2,838.71");
    expect(money(-0.001)).toBe("₹0");
    expect(money(5, "$")).toBe("$5");
  });
});

describe("kitchen units", () => {
  it("converts within a kind only", () => {
    expect(convert(1500, "g", "kg")).toBe(1.5);
    expect(convert(2, "L", "ml")).toBe(2000);
    expect(convert(1, "dozen", "pcs")).toBe(12);
    expect(convert(1, "kg", "pcs")).toBeNull();
    expect(sameKind("kg", "g")).toBe(true);
    expect(sameKind("L", "kg")).toBe(false);
  });
  it("prints small amounts in the smaller unit", () => {
    expect(fmtQty(0.25, "kg")).toBe("250 g");
    expect(fmtQty(1.5, "L")).toBe("1.5 L");
  });
});

describe("salary edge cases", () => {
  it("a worker who joined mid-month isn't paid for days before joining (auto days)", () => {
    const s = salaryFor({ wage: 30000, wageType: "monthly", joinedAt: "2026-03-16" }, "2026-03", [], [], [], [], {
      settings: { unmarked: "present" },
      today: "2026-03-31",
    });
    expect(s.auto.present).toBe(16);
    expect(s.earned).toBe(Math.round((30000 / 31) * 16));
  });
  it("days after leaving and future days are never auto-counted", () => {
    const w = { leftAt: "2026-03-10" };
    expect(autoStatus(w, "2026-03-11", { unmarked: "present" }, "2026-03-31")).toBeNull();
    expect(autoStatus({}, "2026-04-02", { unmarked: "present" }, "2026-04-01")).toBeNull();
  });
  it("a loan never cuts more than what's left, even with a big cut", () => {
    expect(loanFor({ amount: 1000, cut: 5000, startMonth: "2026-01" }, "2026-01").cut).toBe(1000);
    expect(loanFor({ amount: 1000, cut: 5000, startMonth: "2026-01" }, "2026-02").cut).toBe(0);
  });
  it("wage history picks the right wage at month boundaries", () => {
    const s = { wage: 20000, wageHistory: [{ from: "0000-00", wage: 15000 }, { from: "2026-04", wage: 20000 }] };
    expect(wageFor(s, "2026-03").wage).toBe(15000);
    expect(wageFor(s, "2026-04").wage).toBe(20000);
  });
  it("month helpers cross years", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
  it("payable is whole rupees and never −0", () => {
    const s = salaryFor({ wage: 100, wageType: "daily" }, "2026-03", [{ status: "present" }], [], [{ amount: 100.4 }]);
    expect(s.payable).toBe(0);
    expect(Object.is(s.payable, -0)).toBe(false);
  });
});

describe("bill change rules", () => {
  it("bills older than a week need the owner PIN", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(isOldBill({ createdAt: "2026-10-20T12:00:00Z" }, now)).toBe(false);
    expect(isOldBill({ createdAt: "2026-10-16T12:00:00Z" }, now)).toBe(true);
  });
  it("every delete and edit reason has a label", () => {
    for (const r of Object.values(DELETE_REASONS)) expect(r.label).toBeTruthy();
    for (const r of Object.values(EDIT_REASONS)) expect(r).toBeTruthy();
  });
});

import { checkPromo, promoSummary } from "../shared/promo.js";

describe("promo code rules", () => {
  const p = (x) => ({ active: true, type: "percent", value: 10, ...x });
  // Friday 23 Oct 2026, 4:30 pm India time.
  const fri430 = new Date("2026-10-23T11:00:00Z");
  it("percent with a cap, flat never more than the bill", () => {
    expect(checkPromo(p({ value: 50, maxDiscount: 100 }), { subtotal: 1000 }).amount).toBe(100);
    expect(checkPromo(p({ type: "flat", value: 500 }), { subtotal: 120 }).amount).toBe(120);
    expect(checkPromo(p({}), { subtotal: 0 }).ok).toBe(false);
  });
  it("days and times are India time, and a window can run past midnight", () => {
    expect(checkPromo(p({ days: [1, 2, 3, 4, 5], timeFrom: "15:00", timeTo: "18:00" }), { subtotal: 100, at: fri430 }).ok).toBe(true);
    expect(checkPromo(p({ days: [0, 6] }), { subtotal: 100, at: fri430 }).reason).toMatch(/Sat, Sun only/);
    expect(checkPromo(p({ timeFrom: "17:00", timeTo: "19:00" }), { subtotal: 100, at: fri430 }).reason).toMatch(/5 pm–7 pm/);
    const late = new Date("2026-10-23T19:00:00Z"); // 00:30 Saturday in India
    expect(checkPromo(p({ timeFrom: "22:00", timeTo: "02:00" }), { subtotal: 100, at: late }).ok).toBe(true);
    expect(checkPromo(p({ validTo: "2026-10-23" }), { subtotal: 100, at: late }).reason).toMatch(/expired/); // already the 24th in India
  });
  it("where it works, uses, and a one-line summary", () => {
    expect(checkPromo(p({ where: "billing" }), { subtotal: 100, where: "qr" }).ok).toBe(false);
    expect(checkPromo(p({ maxUses: 5, uses: 5 }), { subtotal: 100 }).reason).toMatch(/fully used/);
    expect(promoSummary(p({ maxDiscount: 100, minOrder: 300, days: [1, 2, 3, 4, 5], timeFrom: "15:00", timeTo: "18:00" }))).toBe("10% off up to ₹100 · min ₹300 · Mon–Fri · 3 pm–6 pm");
  });
});
