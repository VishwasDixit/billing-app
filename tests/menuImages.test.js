import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { defaultImageKey, IMAGE_KEYS } from "../shared/menuImages.js";
import { defaultMenu } from "../server/seed/grillhive-menu.js";

describe("default menu pictures", () => {
  it("has an illustration file for every picture key", () => {
    for (const k of IMAGE_KEYS) expect(fs.existsSync(new URL(`../public/menu/${k}.svg`, import.meta.url)), k).toBe(true);
  });

  it("matches dishes to the right picture", () => {
    expect(defaultImageKey("Paneer Pakoda", "Chef Specials")).toBe("pakoda");
    expect(defaultImageKey("Chilli Paneer", "Chinese")).toBe("chilli");
    expect(defaultImageKey("Mix Veg Paratha", "Roti & Paratha")).toBe("paratha");
    expect(defaultImageKey("Sweet Corn Soup", "Soup")).toBe("soup");
    expect(defaultImageKey("Palak Paneer", "Main Course")).toBe("palak");
    expect(defaultImageKey("Something New", "Main Course")).toBe("curry");
    expect(defaultImageKey("Mystery", "")).toBe("plate");
  });

  it("never falls back to the generic plate for the GrillHive menu", () => {
    const plain = defaultMenu("x").filter((m) => defaultImageKey(m.name, m.category) === "plate");
    expect(plain.map((m) => m.name)).toEqual([]);
  });
});
