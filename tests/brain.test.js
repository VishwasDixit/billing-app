import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { learnSeries, predict, reorderPoint, leadTime, zScore, calibration } from "../server/brain/model.js";

const DAY = 864e5;
const IST = 5.5 * 3600e3;
const istWeekday = (t) => new Date(t + IST).getUTCDay();

describe("learning maths", () => {
  it("learns a weekday pattern (busy Saturdays)", () => {
    const y = [];
    const wd = [];
    for (let i = 0; i < 35; i++) {
      const d = i % 7; // starts on a Sunday
      wd.push(d);
      y.push(d === 6 ? 30 : 10);
    }
    const m = learnSeries(y, wd);
    expect(predict(m, 6)).toBeGreaterThan(25);
    expect(predict(m, 2)).toBeLessThan(14);
  });

  it("follows a rising trend", () => {
    const y = Array.from({ length: 28 }, (_, i) => 10 + i);
    const m = learnSeries(y, y.map((_, i) => i % 7));
    expect(predict(m, 0, 1)).toBeGreaterThan(33);
  });

  it("starts simple with little data", () => {
    const m = learnSeries([4, 6, 5], [1, 2, 3]);
    expect(m.weekly).toBe(false);
    expect(predict(m, 4)).toBeCloseTo(5, 0);
  });

  it("reorders earlier when use jumps around or the supplier is slow", () => {
    const steady = reorderPoint({ mean: 2, std: 0.1, leadDays: 1 });
    const jumpy = reorderPoint({ mean: 2, std: 1, leadDays: 1 });
    const slow = reorderPoint({ mean: 2, std: 0.1, leadDays: 3 });
    expect(jumpy).toBeGreaterThan(steady);
    expect(slow).toBeGreaterThan(steady * 2);
    expect(leadTime([0.5, 2, 1, 30])).toBe(1);
    expect(leadTime([])).toBe(1);
  });

  it("scores unusual values and recipe gaps", () => {
    expect(zScore(500, [50, 60, 40, 50])).toBeGreaterThan(3);
    expect(Math.abs(zScore(55, [50, 60, 40, 50]))).toBeLessThan(1);
    expect(calibration(0.24, 2)).toEqual({ ratio: 0.12, factor: 1.12 });
    expect(calibration(1, 0)).toBeNull();
  });
});

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "brain-test";
  process.env.JWT_SECRET = "brain-test-secret-brain-test-secret";
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

function client() {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

describe("Kitchen Brain on a real kitchen", () => {
  it("forecasts tomorrow, learns reorder levels, suggests recipe fixes and flags unusual waste", async () => {
    const c = client();
    await c("POST", "/auth/register", { shopName: "Brain Dhaba", name: "Owner", phone: "9876543210", email: "brain@test.local", password: "secret12" });
    const menu = (await c("GET", "/menu")).body;
    const dal = menu.find((m) => m.name === "Dal Tadka");
    await c("POST", "/kitchen/recipes/standard", { itemIds: [dal.id] });
    const ings = (await c("GET", "/kitchen/ingredients")).body.ingredients;
    const toor = ings.find((i) => i.name === "Toor dal");
    await c("POST", "/kitchen/moves", { moves: [{ clientId: crypto.randomUUID(), ingredientId: toor.id, type: "purchase", qty: 20, unit: "kg", cost: 2800 }] });

    const db = await getDb();
    const shopId = (await db.collection("users").findOne({ email: "brain@test.local" })).shopId;
    const t = Date.now();
    // 6 weeks of sales: Saturdays are 3× busier. Plus the toor dal those plates used.
    const bills = [];
    const used = [];
    for (let i = 42; i >= 1; i--) {
      const at = new Date(t - i * DAY);
      const plates = istWeekday(at.getTime()) === 6 ? 30 : 10;
      bills.push({ shopId, clientId: crypto.randomUUID(), billNo: `B-${i}`, status: "paid", createdAt: at, items: [{ itemId: dal.id, name: "Dal Tadka", variant: "Full", qty: plates, rate: 150 }] });
      used.push({ shopId, ingredientId: toor.id, name: "Toor dal", unit: "kg", type: "used", qty: -(plates * 0.07), cost: 0, at });
    }
    await db.collection("bills").insertMany(bills);
    await db.collection("stockMoves").insertMany(used);

    const b = (await c("GET", "/kitchen/brain?fresh=1")).body;
    expect(b.salesDays).toBeGreaterThanOrEqual(41);
    expect(b.confidence).toBe("good");
    const tomorrowSat = istWeekday(t + DAY) === 6;
    const dalTomorrow = b.tomorrow.dishes.find((d) => d.itemId === dal.id);
    expect(Math.abs(dalTomorrow.qty - (tomorrowSat ? 30 : 10))).toBeLessThanOrEqual(3);
    const prepDal = b.prep.find((p) => p.ingredientId === toor.id);
    expect(prepDal.need).toBeCloseTo(dalTomorrow.qty * 0.07, 0);
    expect(b.week).toHaveLength(7);
    // Learned reorder level is stored on the ingredient and used by the shopping list.
    const learned = (await db.collection("ingredients").findOne({ _id: new (await import("mongodb")).ObjectId(toor.id) })).brain;
    expect(learned.reorderAt).toBeGreaterThan(0);
    expect(learned.usageDays).toBeGreaterThanOrEqual(14);

    // Recipe check: three counts, each finding ~20% less dal than the recipes used.
    const counts = [
      { at: new Date(t - 20 * DAY), qty: 0 },
      { at: new Date(t - 10 * DAY), qty: -1.5 },
      { at: new Date(t - 1 * DAY - 3600e3), qty: -1.4 },
    ];
    await db.collection("stockMoves").insertMany(counts.map((x) => ({ shopId, ingredientId: toor.id, name: "Toor dal", unit: "kg", type: "count", qty: x.qty, cost: x.qty * 140, at: x.at })));
    // Waste: small for weeks, then a bad week.
    const waste = [];
    for (let w = 1; w <= 7; w++) waste.push({ shopId, ingredientId: toor.id, name: "Toor dal", unit: "kg", type: "waste", qty: -0.3, cost: 42, staffName: "Owner", at: new Date(t - (w * 7 + 2) * DAY) });
    waste.push({ shopId, ingredientId: toor.id, name: "Toor dal", unit: "kg", type: "waste", qty: -5, cost: 700, staffName: "Owner", at: new Date(t - 2 * DAY) });
    await db.collection("stockMoves").insertMany(waste);

    const b2 = (await c("GET", "/kitchen/brain?fresh=1")).body;
    const s = b2.suggestions.find((x) => x.ingredientId === toor.id);
    expect(s.message).toMatch(/Dal Tadka seem.* more Toor dal/);
    expect(s.factor).toBeGreaterThan(1.05);
    expect(b2.insights.some((i) => /Toor dal waste cost ₹700 this week/.test(i.text))).toBe(true);

    // Accepting the fix updates the recipe.
    const before = (await c("GET", `/kitchen/recipes/${dal.id}`)).body.recipe.variants.Full.find((p) => p.ingredientId === toor.id).qty;
    expect((await c("POST", `/kitchen/brain/suggestions/${s.id}/apply`)).status).toBe(200);
    const after = (await c("GET", `/kitchen/recipes/${dal.id}`)).body.recipe.variants.Full.find((p) => p.ingredientId === toor.id).qty;
    expect(after).toBeCloseTo(before * s.factor, 0);
    expect((await c("GET", "/kitchen/brain")).body.suggestions.find((x) => x.id === s.id)).toBeUndefined();
    expect((await c("POST", `/kitchen/brain/suggestions/${s.id}/apply`)).status).toBe(404);
  });
});
