// Loyalty streak: order on 6 days in a row and the next visit's dish is free (within 3 days).
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { streakInfo, streakText, loyaltyMessage, addDays } from "../shared/loyalty.js";
import { istDay } from "../shared/hours.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "loyalty-test";
  process.env.JWT_SECRET = "loyalty-test-secret-loyalty-test-secret";
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

describe("streak rules", () => {
  const today = "2026-11-10";
  const run = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

  it("counts days in a row; a gap starts again", () => {
    expect(streakInfo(run("2026-11-07", 4), { today, need: 6 }).count).toBe(4);
    expect(streakInfo([...run("2026-11-01", 3), ...run("2026-11-06", 2)], { today, need: 6 }).count).toBe(0); // last visit 2 days ago
    expect(streakInfo([...run("2026-11-01", 3), ...run("2026-11-08", 2)], { today, need: 6 }).count).toBe(2);
  });

  it("no visit yet today still keeps yesterday's streak", () => {
    const s = streakInfo(run("2026-11-05", 5), { today, need: 6 });
    expect(s).toMatchObject({ count: 5, visitedToday: false, earned: [] });
  });

  it("6 in a row earns on the 6th day, then counts again", () => {
    const s = streakInfo(run("2026-11-01", 9), { today: "2026-11-09", need: 6 });
    expect(s.earned).toEqual(["2026-11-06"]);
    expect(s.count).toBe(3);
    expect(streakInfo(run("2026-11-01", 9), { today: "2026-11-09", need: 6, after: "2026-11-06" }).earned).toEqual([]);
    expect(streakInfo(run("2026-11-01", 12), { today: "2026-11-12", need: 6 }).earned).toEqual(["2026-11-06", "2026-11-12"]);
  });

  it("visits before the scheme started don't count", () => {
    expect(streakInfo(run("2026-11-01", 6), { today: "2026-11-06", need: 6, since: "2026-11-03" }).earned).toEqual([]);
  });

  it("texts", () => {
    expect(streakText(4, 6, { name: "Masala Chai" })).toBe("🔥 4-day streak · 2 more days in a row for a free Masala Chai");
    expect(streakText(0, 6, { name: "Tea" })).toMatch(/Order 6 days in a row/);
    expect(loyaltyMessage("GrillHive", { count: 0, need: 6, dish: { name: "Tea" } })).toContain("7th day's Tea is FREE");
    expect(loyaltyMessage("GrillHive", { count: 4, need: 6, dish: { name: "Tea" }, link: "https://x" })).toMatch(/4-day streak[\s\S]*2 more days[\s\S]*https:\/\/x/);
    expect(loyaltyMessage("GrillHive", { need: 6, dish: { name: "Tea" }, reward: { validTo: "2026-11-12" } })).toContain("FREE Tea");
  });
});

describe("free dish for a 6-day streak", () => {
  let c, db, shopId, token, tea, dal;
  const PHONE = "9876500011";
  const daysAgo = (n) => new Date(Date.now() - n * 864e5);
  // Bills for this mobile on the given days back (n = 1 is yesterday).
  const visit = (...ns) =>
    db.collection("bills").insertMany(ns.map((n) => ({ shopId, clientId: crypto.randomUUID(), billNo: `L${n}${Math.random()}`, status: "paid", createdAt: daysAgo(n), items: [], total: 10, customer: { clientId: "c1", name: "Ravi", phone: `+91 ${PHONE}` } })));
  const order = (phone = PHONE, items = [{ itemId: dal.id, variant: dal.variants[0].label, qty: 1 }]) => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone, items });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Streak Cafe", name: "Owner", phone: "9876543214", email: "streak@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    db = await getDb();
    shopId = new ObjectId(r.body.shop.id);
    await db.collection("shops").updateOne({ _id: shopId }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    const menu = (await c("GET", "/menu")).body;
    tea = menu.find((m) => m.name === "Tea");
    dal = menu.find((m) => m.name === "Dal Tadka");
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
  });

  it("needs a free dish to turn on", async () => {
    expect((await c("PUT", "/shop", { loyalty: { on: true, days: 6, validDays: 3, dishId: "" } })).status).toBe(400);
    const r = await c("PUT", "/shop", { loyalty: { on: true, days: 6, validDays: 3, dishId: tea.id } });
    expect(r.status).toBe(200);
    expect(r.body.loyalty.since).toBe(istDay());
    // Pretend it was turned on 10 days ago so the test visits count.
    await db.collection("shops").updateOne({ _id: shopId }, { $set: { "loyalty.since": addDays(istDay(), -10) } });
  });

  it("shows the streak at the cart and at Billing", async () => {
    await visit(3, 2, 1);
    const pub = await client()("POST", `/public/shop/${token}/loyalty`, { phone: PHONE });
    expect(pub.body).toMatchObject({ on: true, count: 3, need: 6, reward: false, dish: { name: "Tea" } });
    expect((await c("GET", `/loyalty/check/${PHONE}`)).body).toMatchObject({ count: 3, reward: null });
  });

  it("6 days in a row: the next QR order gets the dish free, once", async () => {
    await visit(6, 5, 4);
    expect((await c("GET", `/loyalty/check/${PHONE}`)).body.reward).toMatchObject({ validTo: addDays(istDay(), 2) });
    const r = await order();
    expect(r.status).toBe(200);
    expect(r.body.loyalty).toEqual({ free: "Tea" });
    const saved = await db.collection("orders").findOne({ clientId: r.body.orderId });
    expect(saved.items.find((i) => i.free)).toMatchObject({ itemId: tea.id, rate: 0, qty: 1, free: "loyalty" });
    expect(saved.total).toBe(r.body.total);
    // Used: the next order today doesn't get another.
    expect((await order()).body.loyalty).toBeUndefined();

    // Cancelled: the reward comes back.
    expect((await c("POST", `/orders/${r.body.orderId}/status`, { status: "rejected", reason: "test" })).status).toBe(200);
    expect((await c("GET", `/loyalty/check/${PHONE}`)).body.reward).not.toBeNull();
  });

  it("a counter bill with the free line uses the reward", async () => {
    const bill = {
      clientId: crypto.randomUUID(), billNo: "B1", createdAt: new Date().toISOString(),
      items: [{ itemId: tea.id, name: "Tea", qty: 1, rate: 0, free: "loyalty" }],
      customer: { clientId: crypto.randomUUID(), name: "Ravi", phone: PHONE },
    };
    expect((await c("POST", "/bills", { bills: [bill] })).body.results[0].ok).toBe(true);
    const saved = await db.collection("bills").findOne({ clientId: bill.clientId });
    expect(saved.items[0].free).toBe("loyalty");
    expect(saved.loyaltyUnmatched).toBeUndefined();
    expect((await c("GET", `/loyalty/check/${PHONE}`)).body.reward).toBeNull();
    // No reward left: a second free line still saves, marked for the owner.
    const again = { ...bill, clientId: crypto.randomUUID(), billNo: "B2" };
    await c("POST", "/bills", { bills: [again] });
    expect((await db.collection("bills").findOne({ clientId: again.clientId })).loyaltyUnmatched).toBe(true);
  });

  it("an expired reward isn't given", async () => {
    const P2 = "9876500012";
    await db.collection("bills").insertMany([10, 9, 8, 7, 6, 5].map((n) => ({ shopId, clientId: crypto.randomUUID(), billNo: `X${n}`, status: "paid", createdAt: daysAgo(n), items: [], total: 10, customer: { clientId: "c2", name: "Asha", phone: P2 } })));
    const st = (await c("GET", `/loyalty/check/${P2}`)).body;
    expect(st.reward).toBeNull(); // earned 5 days ago, valid 3 days
    expect((await order(P2)).body.loyalty).toBeUndefined();
  });

  it("lists customers for the WhatsApp reminders", async () => {
    await c("POST", "/customers", { clientId: crypto.randomUUID(), name: "Neha", phone: "9876500013" });
    const r = await c("GET", "/loyalty/customers");
    expect(r.status).toBe(200);
    expect(r.body.need).toBe(6);
    expect(r.body.dish.name).toBe("Tea");
    const phones = r.body.customers.map((x) => x.phone);
    expect(phones).toContain("9876500013");
    expect(new Set(phones).size).toBe(phones.length);
  });
});
