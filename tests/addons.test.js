// Add-ons (Extra cheese, sauces) on dishes, and instructions the customer adds after the order is accepted.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { addonGroupsFor, checkAddons, addonRule, lineLabel, addonKey } from "../shared/addons.js";

const sauces = { id: "sauce", name: "Sauces", min: 0, max: 2, options: [{ id: "mayo", name: "Mayo", price: 10 }, { id: "peri", name: "Peri peri", price: 15 }, { id: "bbq", name: "BBQ", price: 15, off: true }], items: [], categories: ["Burgers"] };
const bread = { id: "bread", name: "Bread", min: 1, max: 1, options: [{ id: "white", name: "White", price: 0 }, { id: "brown", name: "Brown", price: 5 }], items: ["abc"], categories: [] };

describe("add-on rules", () => {
  it("finds a dish's groups by the dish or its category", () => {
    expect(addonGroupsFor([sauces, bread], { id: "x", category: "Burgers" })).toEqual([sauces]);
    expect(addonGroupsFor([sauces, bread], { _id: "abc", category: "Sandwich" })).toEqual([bread]);
    expect(addonGroupsFor([sauces, bread], { id: "x", category: "" })).toEqual([]);
  });

  it("checks what was picked: required, most allowed, off today, unknown", () => {
    expect(checkAddons([sauces, bread], ["peri", "mayo", "brown"])).toEqual({ addons: [{ name: "Mayo", price: 10 }, { name: "Peri peri", price: 15 }, { name: "Brown", price: 5 }], error: "" });
    expect(checkAddons([bread], []).error).toMatch(/pick one for Bread/);
    expect(checkAddons([bread], ["white", "brown"]).error).toMatch(/up to 1/);
    expect(checkAddons([sauces], ["bbq"]).error).toMatch(/BBQ is not available/);
    expect(checkAddons([sauces], ["nope"]).error).toMatch(/changed/);
    expect(checkAddons([], []).error).toBe("");
  });

  it("labels and keys", () => {
    expect(addonRule(sauces)).toBe("Pick up to 2");
    expect(addonRule(bread)).toBe("Pick 1");
    expect(lineLabel({ name: "Burger", variant: "Large", addons: [{ name: "Mayo" }, { name: "Cheese" }] })).toBe("Burger (Large) + Mayo, Cheese");
    expect(addonKey(["b", "a"])).toBe(addonKey(["a", "b"]));
  });

  it("the kitchen ticket prints add-ons and the customer's instructions", async () => {
    const { kotRows } = await import("../src/printer/kot.js");
    const order = { orderNo: "Q1", tableName: "Table 1", source: "qr", createdAt: new Date().toISOString(), items: [{ name: "Burger", qty: 1, rate: 135, addons: [{ name: "Extra cheese", price: 20 }] }], instructions: { cooking: "No onion", delivery: "" } };
    const text = kotRows({ printer: { paperSize: 58, charsPerLine: 32 } }, order).rows.map((r) => r.text).join("\n");
    expect(text).toContain("+ Extra cheese");
    expect(text).toContain("Cooking: No onion");
    expect(text).not.toContain("Delivery:");
  });
});

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "addons-test";
  process.env.JWT_SECRET = "addons-test-secret-addons-test-secret";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  server?.close();
  await closeDb?.();
  await mongod?.stop();
});

let ipN = 0;
function client(ip = `10.8.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

describe("add-ons and instructions in the app", () => {
  let c, token, tea, dal, other;
  const order = (items, extra = {}) => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone: "9876500001", items, ...extra });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Addon Cafe", name: "Owner", phone: "9876543211", email: "addons@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    const menu = (await c("GET", "/menu")).body;
    tea = menu.find((m) => m.name === "Tea"); // ₹15
    dal = menu.find((m) => m.name === "Dal Tadka"); // ₹80 / ₹150
    other = menu.find((m) => m.category !== tea.category && m.category !== dal.category);
  });

  it("the owner saves add-on groups; bad rules are refused", async () => {
    const groups = [
      { ...sauces, items: [dal.id], categories: [] },
      { ...bread, items: [], categories: [tea.category] },
    ];
    const r = await c("PUT", "/shop", { addonGroups: groups });
    expect(r.status).toBe(200);
    expect(r.body.addonGroups).toHaveLength(2);
    const bad = await c("PUT", "/shop", { addonGroups: [{ ...bread, min: 3, max: 2 }] });
    expect(bad.status).toBe(400);
    expect((await c("PUT", "/shop", { addonGroups: [{ ...bread, options: [] }] })).status).toBe(400);
  });

  it("the QR menu sends each dish only its own groups", async () => {
    const pub = (await client()("GET", `/public/shop/${token}?t=T1`)).body;
    const of = (id) => pub.menu.find((m) => m.id === id).addons;
    expect(of(dal.id).map((g) => g.name)).toEqual(["Sauces"]);
    expect(of(dal.id)[0].options.find((o) => o.id === "bbq").off).toBe(true);
    expect(of(tea.id).map((g) => g.name)).toEqual(["Bread"]);
    expect(of(other.id)).toEqual([]);
  });

  it("orders: add-ons priced by the server, a required group must be picked, notes are ignored", async () => {
    const r = await order([{ itemId: dal.id, variant: dal.variants[1].label, qty: 2, addons: ["mayo", "peri"], note: "extra spicy" }, { itemId: tea.id, qty: 1, addons: ["brown"] }], { note: "hello" });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2 * (150 + 25) + 20);
    const saved = await (await getDb()).collection("orders").findOne({ clientId: r.body.orderId });
    expect(saved.items[0]).toMatchObject({ rate: 175, note: "", addons: [{ name: "Mayo", price: 10 }, { name: "Peri peri", price: 15 }] });
    expect(saved.note).toBe("");

    const missing = await order([{ itemId: tea.id, qty: 1 }]);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Tea: Please pick one for Bread/);
    expect((await order([{ itemId: dal.id, qty: 1, variant: dal.variants[0].label, addons: ["bbq"] }])).status).toBe(400);
    expect((await order([{ itemId: dal.id, qty: 1, variant: dal.variants[0].label, addons: ["white"] }])).status).toBe(400); // not this dish's
  });

  it("instructions: only after accepting; cooking until ready, delivery until served", async () => {
    const placed = (await order([{ itemId: dal.id, variant: dal.variants[0].label, qty: 1 }])).body;
    const send = (body, key = placed.key) => client()("POST", `/public/shop/${token}/orders/${placed.orderId}/instructions`, { key, ...body });
    const status = (s) => c("POST", `/orders/${placed.orderId}/status`, { status: s });

    expect((await send({ cooking: "No onion" }, "wrong")).status).toBe(404);
    expect((await send({ cooking: "No onion" })).status).toBe(409);
    await status("accepted");
    expect((await send({ cooking: "No onion" })).status).toBe(200);
    await status("preparing");
    const both = await send({ cooking: "No onion, less oil", delivery: "Gate 2" });
    expect(both.body.instructions).toMatchObject({ cooking: "No onion, less oil", delivery: "Gate 2" });
    await status("ready");
    expect((await send({ cooking: "Add chilli" })).status).toBe(409);
    expect((await send({ cooking: "No onion, less oil", delivery: "Gate 3" })).status).toBe(200); // cooking unchanged is fine
    const seen = (await client()("GET", `/public/shop/${token}/orders/${placed.orderId}?k=${placed.key}`)).body;
    expect(seen.instructions).toMatchObject({ cooking: "No onion, less oil", delivery: "Gate 3" });
    const staff = (await c("GET", "/orders")).body;
    expect(JSON.stringify(staff)).toContain("Gate 3");
    await status("served");
    expect((await send({ delivery: "Gate 4" })).status).toBe(409);
  });

  it("instructions: too many changes are stopped", async () => {
    const placed = (await order([{ itemId: dal.id, variant: dal.variants[0].label, qty: 1 }])).body;
    await c("POST", `/orders/${placed.orderId}/status`, { status: "accepted" });
    const send = (cooking) => client()("POST", `/public/shop/${token}/orders/${placed.orderId}/instructions`, { key: placed.key, cooking });
    for (let i = 0; i < 10; i++) expect((await send(`note ${i}`)).status).toBe(200);
    expect((await send("one more")).status).toBe(429);
  });

  it("bills keep the add-ons", async () => {
    const clientId = crypto.randomUUID();
    const items = [{ itemId: dal.id, name: "Dal Tadka", variant: "Full", qty: 1, rate: 175, addons: [{ name: "Mayo", price: 10 }, { name: "Peri peri", price: 15 }] }];
    expect((await c("POST", "/bills", { bills: [{ clientId, billNo: "A-9101", createdAt: new Date().toISOString(), items }] })).status).toBe(200);
    const bill = (await c("GET", "/bills")).body.bills.find((b) => b.clientId === clientId);
    expect(bill.items[0]).toMatchObject({ rate: 175, addons: [{ name: "Mayo", price: 10 }, { name: "Peri peri", price: 15 }] });
  });
});
