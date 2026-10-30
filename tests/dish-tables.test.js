// Dishes only for some tables (e.g. a rooftop special): hidden from other tables' QR menu, refused
// in their QR orders, but staff can still add them anywhere.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { servedAt } from "../shared/tableGroups.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "dish-tables-test";
  process.env.JWT_SECRET = "dish-tables-test-secret-dish-tables";
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
function client(ip = `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

it("servedAt: no tables means every table", () => {
  expect(servedAt({ tables: [] }, "T1")).toBe(true);
  expect(servedAt({}, "T1")).toBe(true);
  expect(servedAt({ tables: ["T2"] }, "T1")).toBe(false);
  expect(servedAt({ tables: ["T2"] }, "T2")).toBe(true);
});

describe("dishes kept for some tables", () => {
  let c, token, dal, tea;
  const tables = [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }, { id: "T3", name: "Table 3" }];
  const menuAt = async (t) => (await client()("GET", `/public/shop/${token}?t=${t}`)).body.menu.map((m) => m.id);
  const order = (t, item) => client()("POST", `/public/shop/${token}/orders`, { table: t, name: "Ravi", phone: "9876500001", items: [{ itemId: item.id, variant: item.variants[0].label, qty: 1 }] });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Rooftop Cafe", name: "Owner", phone: "9876543212", email: "rooftop@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables, qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    const menu = (await c("GET", "/menu")).body;
    dal = menu.find((m) => m.name === "Dal Tadka");
    tea = menu.find((m) => m.name === "Tea");
  });

  it("saves only the shop's tables", async () => {
    const r = await c("PUT", `/menu/${dal.id}`, { tables: ["T2", "T2", "T99"] });
    expect(r.status).toBe(200);
    expect(r.body.tables).toEqual(["T2"]);
  });

  it("shows the dish only on its tables' QR menu", async () => {
    expect(await menuAt("T1")).not.toContain(dal.id);
    expect(await menuAt("T2")).toContain(dal.id);
    expect(await menuAt("T1")).toContain(tea.id);
  });

  it("refuses it in other tables' QR orders; staff can still add it", async () => {
    const no = await order("T1", dal);
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/not served at this table/);
    expect((await order("T2", dal)).status).toBe(200);

    const staff = { clientId: crypto.randomUUID(), orderNo: "A1", table: "T1", createdAt: new Date().toISOString(), items: [{ itemId: dal.id, name: dal.name, qty: 1, rate: 80 }] };
    expect((await c("POST", "/orders", { orders: [staff] })).body.results[0].ok).toBe(true);
  });

  it("sets a whole category at once", async () => {
    const r = await c("PUT", "/menu/category-tables", { category: tea.category, tables: ["T3", "nope"] });
    expect(r.status).toBe(200);
    const menu = (await c("GET", "/menu")).body.filter((m) => m.category === tea.category);
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.every((m) => m.tables.join() === "T3")).toBe(true);
    expect(await menuAt("T1")).not.toContain(tea.id);
    expect(await menuAt("T3")).toContain(tea.id);
  });

  it("a removed table is dropped from dishes", async () => {
    await c("PUT", "/shop", { tables: tables.filter((t) => t.id !== "T2") });
    const now = (await c("GET", "/menu")).body.find((m) => m.id === dal.id);
    expect(now.tables).toEqual([]);
    expect(await menuAt("T1")).toContain(dal.id);
  });
});
