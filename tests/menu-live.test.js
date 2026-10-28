// Live menu: a version that moves whenever the menu screens would show something different, so open
// screens fetch the menu again without anyone refreshing.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "menu-live-test";
  process.env.JWT_SECRET = "menu-live-test-secret-menu-live-test";
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

describe("live menu version", () => {
  let c, token, tea;
  const staffV = async () => (await c("GET", "/menu-version")).body.v;
  const publicV = async () => (await client()("GET", `/public/shop/${token}/menu-version`)).body.v;
  // Runs a change and says whether the version moved.
  const moves = async (fn) => {
    const before = await staffV();
    await fn();
    return (await staffV()) !== before;
  };

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Live Cafe", name: "Owner", phone: "9876543212", email: "live@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
  });

  it("the staff and public checks agree, and the menu carries the same version", async () => {
    const v = await staffV();
    expect(v).toBeGreaterThan(0);
    expect(await publicV()).toBe(v);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.menuVersion).toBe(v);
    expect((await client()("GET", `/public/shop/nope-nope-nope-nope/menu-version`)).status).toBe(404);
  });

  it("moves on a price edit, a new or deleted dish, stock, and shop settings; not on reads", async () => {
    expect(await moves(() => c("GET", "/menu"))).toBe(false);
    expect(await moves(() => client()("GET", `/public/shop/${token}?t=T1`))).toBe(false);
    expect(await moves(() => c("PUT", `/menu/${tea.id}`, { variants: [{ label: "", price: 18 }] }))).toBe(true);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.menu.find((m) => m.id === tea.id).variants[0].price).toBe(18);
    let added;
    expect(await moves(async () => (added = (await c("POST", "/menu", { name: "Lassi", category: "Drinks", variants: [{ label: "", price: 40 }] })).body))).toBe(true);
    expect(await moves(() => c("DELETE", `/menu/${added.id}`))).toBe(true);
    expect(await moves(() => c("PUT", `/menu/${tea.id}/stock`, { soldOut: true }))).toBe(true);
    expect(await moves(() => c("PUT", `/menu/${tea.id}/stock`, { soldOut: false }))).toBe(true);
    expect(await moves(() => c("PUT", "/shop", { addonGroups: [{ id: "g1", name: "Sugar", min: 0, max: 1, options: [{ id: "less", name: "Less sugar", price: 0 }], items: [tea.id], categories: [] }] }))).toBe(true);
  });

  it("moves when an order sells the last one", async () => {
    await c("PUT", `/menu/${tea.id}/stock`, { stock: 1 });
    const bill = { clientId: crypto.randomUUID(), billNo: "A-1", createdAt: new Date().toISOString(), items: [{ itemId: tea.id, name: "Tea", qty: 1, rate: 18 }] };
    expect(await moves(() => c("POST", "/bills", { bills: [bill] }))).toBe(true);
    expect((await c("GET", "/menu")).body.find((m) => m.id === tea.id).soldOut).toBe(true);
  });
});
