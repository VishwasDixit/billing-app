// Table groups: far tables with their own prices and a delivery charge on smaller orders.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { groupOf, groupPrice, priceMenuFor, deliveryLine, freeDeliveryGap, foodTotal, deliveryText } from "../shared/tableGroups.js";

describe("table group rules", () => {
  const g = { id: "far", name: "Far", tables: ["T3"], pricePercent: 10, prices: { abc: { Full: 199 } }, delivery: { charge: 30, freeFrom: 300 } };

  it("prices: percent in whole rupees, own price wins, never below zero", () => {
    expect(groupPrice(g, "x", "", 150)).toBe(165);
    expect(groupPrice(g, "x", "", 15)).toBe(17); // 16.5 rounds up
    expect(groupPrice(g, "abc", "Full", 150)).toBe(199);
    expect(groupPrice(g, "abc", "Half", 80)).toBe(88); // own price only for Full
    expect(groupPrice({ pricePercent: -50 }, "x", "", 15)).toBe(8);
    expect(groupPrice(null, "x", "", 15)).toBe(15);
    expect(groupPrice({ pricePercent: 0 }, "x", "", 15)).toBe(15);
    expect(priceMenuFor(g, [{ id: "x", variants: [{ label: "", price: 100 }] }])[0].variants[0].price).toBe(110);
  });

  it("finds the table's group", () => {
    expect(groupOf({ tableGroups: [g] }, "T3")).toBe(g);
    expect(groupOf({ tableGroups: [g] }, "T1")).toBeNull();
    expect(groupOf({}, "T3")).toBeNull();
  });

  it("delivery: below the free amount only; free amount 0 = always; charge 0 = none", () => {
    expect(deliveryLine(g, 299)).toMatchObject({ name: "Delivery charge", rate: 30, qty: 1, charge: true, itemId: "" });
    expect(deliveryLine(g, 300)).toBeNull();
    expect(deliveryLine({ delivery: { charge: 20, freeFrom: 0 } }, 5000)).toMatchObject({ rate: 20 });
    expect(deliveryLine({ delivery: { charge: 0, freeFrom: 300 } }, 10)).toBeNull();
    expect(deliveryLine(null, 10)).toBeNull();
    expect(freeDeliveryGap(g, 230)).toBe(70);
    expect(freeDeliveryGap(g, 300)).toBe(0);
    expect(foodTotal([{ qty: 2, rate: 50 }, { qty: 1, rate: 30, charge: true }])).toBe(100);
    expect(deliveryText({ charge: 30, freeFrom: 300 })).toBe("🛵 Delivery ₹30 · free on orders of ₹300+");
  });

  it("the kitchen ticket leaves out the charge and says to pack it", async () => {
    const { kotRows } = await import("../src/printer/kot.js");
    const order = { orderNo: "Q1", tableName: "Table 3", source: "qr", createdAt: new Date().toISOString(), items: [{ name: "Tea", qty: 2, rate: 17 }, { name: "Delivery charge", qty: 1, rate: 30, charge: true }] };
    const text = kotRows({ printer: { paperSize: 58, charsPerLine: 32 } }, order).rows.map((r) => r.text).join("\n");
    expect(text).toContain("2 x Tea");
    expect(text).not.toContain("Delivery charge");
    expect(text).toContain("DELIVERY");
    expect(text).toContain("Items: 2");
  });
});

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "tablegroups-test";
  process.env.JWT_SECRET = "tablegroups-test-secret-tablegroups-test";
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
function client(ip = `10.7.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

describe("table groups in the app", () => {
  let c, token, tea, dal;
  const far = (extra = {}) => ({ id: "far", name: "Delivery 1–3 km", tables: ["T3", "T4"], pricePercent: 10, prices: {}, delivery: { charge: 30, freeFrom: 300 }, ...extra });
  const order = (table, items, extra = {}) => client()("POST", `/public/shop/${token}/orders`, { table, name: "Ravi", phone: "9876500001", items, ...extra });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Far Dhaba", name: "Owner", phone: "9876543210", email: "far@groups.test", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: ["T1", "T2", "T3", "T4", "T5"].map((id) => ({ id, name: `Table ${id.slice(1)}` })), qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    const menu = (await c("GET", "/menu")).body;
    tea = menu.find((m) => m.name === "Tea"); // ₹15
    dal = menu.find((m) => m.name === "Dal Tadka"); // ₹80 / ₹150
  });

  it("the owner saves groups; a table can be in one group only; removed tables leave groups", async () => {
    const r = await c("PUT", "/shop", { tableGroups: [far({ prices: { [dal.id]: { [dal.variants[1].label]: 199 } } })] });
    expect(r.status).toBe(200);
    expect(r.body.tableGroups[0]).toMatchObject({ name: "Delivery 1–3 km", tables: ["T3", "T4"], pricePercent: 10 });

    const clash = await c("PUT", "/shop", { tableGroups: [far(), { ...far(), id: "near", name: "Near", tables: ["T4", "T5"] }] });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toMatch(/Table T4 is in both/);
    expect((await c("PUT", "/shop", { tableGroups: [far({ pricePercent: 500 })] })).status).toBe(400);

    // Table 4 removed from the shop: it leaves the group too.
    await c("PUT", "/shop", { tables: ["T1", "T2", "T3", "T5"].map((id) => ({ id, name: `Table ${id.slice(1)}` })) });
    expect((await c("GET", "/shop")).body.tableGroups[0].tables).toEqual(["T3"]);
    await c("PUT", "/shop", { tables: ["T1", "T2", "T3", "T4", "T5"].map((id) => ({ id, name: `Table ${id.slice(1)}` })), tableGroups: [far({ prices: { [dal.id]: { [dal.variants[1].label]: 199 } } })] });
  });

  it("the QR menu shows the group's prices and delivery for that table only", async () => {
    const pub = (t) => client()("GET", `/public/shop/${token}${t ? `?t=${t}` : ""}`);
    const priceOf = (menu, id, i = 0) => menu.find((m) => m.id === id).variants[i].price;
    const near = (await pub("T1")).body;
    expect(priceOf(near.menu, tea.id)).toBe(15);
    expect(near.delivery).toBeNull();
    expect((await pub("")).body.delivery).toBeNull();
    const farMenu = (await pub("T3")).body;
    expect(priceOf(farMenu.menu, tea.id)).toBe(17);
    expect(priceOf(farMenu.menu, dal.id, 0)).toBe(88);
    expect(priceOf(farMenu.menu, dal.id, 1)).toBe(199); // own price
    expect(farMenu.delivery).toEqual({ charge: 30, freeFrom: 300 });
    // Nothing about other tables' prices or the markup is sent.
    expect(JSON.stringify(farMenu)).not.toMatch(/pricePercent|tableGroups/);
  });

  it("a far table's order: group prices, delivery below the free amount, none at or above it", async () => {
    const small = await order("T3", [{ itemId: tea.id, qty: 4 }]); // 4 × 17 = 68
    expect(small.status).toBe(200);
    expect(small.body.total).toBe(98);
    const saved = await (await getDb()).collection("orders").findOne({ clientId: small.body.orderId });
    expect(saved.items.map((i) => [i.name, i.rate, !!i.charge])).toEqual([["Tea", 17, false], ["Delivery charge", 30, true]]);

    const big = await order("T3", [{ itemId: dal.id, variant: dal.variants[1].label, qty: 2 }]); // 2 × 199 = 398
    expect(big.body.total).toBe(398);

    const nearOrder = await order("T1", [{ itemId: tea.id, qty: 4 }]);
    expect(nearOrder.body.total).toBe(60);
  });

  it("promo minimums and free delivery go by the food; the payable includes the charge", async () => {
    await c("POST", "/promos", { code: "FAR20", description: "", type: "flat", value: 20, minOrder: 60 });
    // 4 teas = ₹68 of food: the code works (min ₹60), delivery is charged (below ₹300).
    const check = await client()("POST", `/public/shop/${token}/promo`, { code: "FAR20", table: "T3", items: [{ itemId: tea.id, qty: 4 }] });
    expect(check.body).toMatchObject({ amount: 20, payable: 78 });
    const placed = await order("T3", [{ itemId: tea.id, qty: 4 }], { promo: "FAR20", phone: "9876500002" });
    expect(placed.body).toMatchObject({ total: 98, promo: { code: "FAR20", amount: 20 } });
    expect(placed.body.pay.amount).toBe(78); // what they pay: food − promo + delivery (no GST here)
  });

  it("bills keep the delivery line, and it isn't counted as a dish", async () => {
    const clientId = crypto.randomUUID();
    const items = [{ itemId: tea.id, name: "Tea", qty: 2, rate: 17 }, { itemId: "", name: "Delivery charge", category: "Charges", qty: 1, rate: 30, charge: true }];
    expect((await c("POST", "/bills", { bills: [{ clientId, billNo: "A-9001", createdAt: new Date().toISOString(), items }] })).status).toBe(200);
    const bill = (await c("GET", "/bills")).body.bills.find((b) => b.clientId === clientId);
    expect(bill.total).toBe(64);
    expect(bill.items.find((i) => i.name === "Delivery charge")).toMatchObject({ charge: true, amount: 30 });
  });
});
