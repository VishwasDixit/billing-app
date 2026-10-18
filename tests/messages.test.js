import { describe, it, expect } from "vitest";
import { LANGUAGE_CODES, reminderText, receiptText, languageFor } from "../shared/messages.js";

const shop = { name: "GrillHive", upiId: "grillhive@okaxis", reminderLanguage: "hindi" };
const ramesh = { name: "Ramesh", due: 1250.5 };

describe("udhar messages", () => {
  it("writes reminders and receipts in every language", () => {
    for (const lang of LANGUAGE_CODES.filter((l) => l !== "custom")) {
      const s = { ...shop, reminderLanguage: lang };
      const r = reminderText(ramesh, s);
      expect(r, lang).toContain("Ramesh");
      expect(r, lang).toContain("₹1,250.5");
      expect(r, lang).toContain("GrillHive");
      expect(r, lang).toContain("UPI: grillhive@okaxis");
      const part = receiptText(ramesh, s, 500, 750.5);
      expect(part, lang).toContain("₹500");
      expect(part, lang).toContain("₹750.5");
      expect(receiptText(ramesh, s, 1250.5, 0), lang).toContain("✅");
    }
  });

  it("uses the customer's language over the shop's", () => {
    expect(languageFor({ language: "tamil" }, shop)).toBe("tamil");
    expect(languageFor({ language: "" }, shop)).toBe("hindi");
    expect(languageFor({}, {})).toBe("hinglish");
    expect(reminderText({ ...ramesh, language: "english" }, shop)).toMatch(/^Hello Ramesh/);
    expect(reminderText(ramesh, shop)).toMatch(/^नमस्ते Ramesh जी/);
  });

  it("fills a custom template and drops an empty UPI line", () => {
    const s = { name: "GrillHive", reminderLanguage: "custom", reminderTemplate: "Hi {name}, please pay {amount} at {shop}. UPI: {upi}" };
    expect(reminderText(ramesh, s)).toBe("Hi Ramesh, please pay ₹1,250.5 at GrillHive.");
    expect(reminderText(ramesh, { ...s, upiId: "x@y" })).toBe("Hi Ramesh, please pay ₹1,250.5 at GrillHive. UPI: x@y");
    expect(receiptText(ramesh, s, 100, 0)).toMatch(/^Hello Ramesh/); // receipts fall back to English
  });
});
