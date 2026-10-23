import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, inv, units;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "kitchen-test";
  process.env.JWT_SECRET = "kitchen-test-secret-kitchen-test";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  inv = await import("../server/kitchen/inventory.js");
  units = await import("../server/kitchen/units.js");
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  inv?.setKitchenClock(null);
  server?.close();
  await closeDb?.();
  await mongod?.stop();
});

function client(extraHeaders = {}) {
  let cookie = "";
  const headers = { ...extraHeaders };
  const c = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, ...headers }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
  c.setHeader = (k, v) => (headers[k] = v);
  c.cookie = () => cookie;
  return c;
}

async function shopWithKitchen(email) {
  const c = client();
  await c("POST", "/auth/register", { shopName: "Kitchen Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const menu = (await c("GET", "/menu")).body;
  const dal = menu.find((m) => m.name === "Dal Tadka");
  const tea = menu.find((m) => m.name === "Tea");
  const std = await c("POST", "/kitchen/recipes/standard", { itemIds: [dal.id, tea.id] });
  expect(std.body.created).toBe(2);
  const ings = (await c("GET", "/kitchen/ingredients")).body.ingredients;
  const ing = (name) => ings.find((i) => i.name === name);
  return { c, dal, tea, ing };
}
const move = (m) => ({ clientId: crypto.randomUUID(), ...m });
const bill = (items) => ({ bills: [{ clientId: crypto.randomUUID(), billNo: "A-" + Math.floor(Math.random() * 1e6), createdAt: new Date().toISOString(), items }] });

describe("units", () => {
  it("converts within a kind and refuses across kinds", () => {
    expect(units.convert(250, "g", "kg")).toBe(0.25);
    expect(units.convert(1.5, "L", "ml")).toBe(1500);
    expect(units.convert(2, "dozen", "pcs")).toBe(24);
    expect(units.convert(1, "kg", "L")).toBeNull();
    expect(units.fmtQty(0.75, "kg")).toBe("750 g");
  });
});

describe("recipes use up kitchen stock", () => {
  it("takes ingredients per plate (half/full) for counter bills, table orders once, with costs", async () => {
    const { c, dal, ing } = await shopWithKitchen("k1@x.test");
    const toor = ing("Toor dal");
    expect(toor).toMatchObject({ unit: "kg", stock: 0 });
    const recipe = (await c("GET", `/kitchen/recipes/${dal.id}`)).body.recipe;
    expect(recipe.variants.Full.find((p) => p.ingredientId === toor.id)).toMatchObject({ qty: 70, unit: "g" });
    expect(recipe.variants.Half.find((p) => p.ingredientId === toor.id).qty).toBe(42);
    expect(recipe.cost.Full).toBeGreaterThan(0);

    const r = await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: toor.id, type: "purchase", qty: 5, unit: "kg", cost: 700 })] });
    expect(r.body.results[0].ok).toBe(true);

    // 2 Full + 1 Half = 70*2 + 42 = 182 g
    await c("POST", "/bills", bill([{ itemId: dal.id, name: "Dal Tadka", variant: "Full", qty: 2, rate: 150 }, { itemId: dal.id, name: "Dal Tadka", variant: "Half", qty: 1, rate: 80 }]));
    const after = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.id === toor.id);
    expect(after.stock).toBeCloseTo(5 - 0.182, 3);
    expect(after.costPerUnit).toBe(140);
    const used = (await c("GET", "/kitchen/moves?type=used")).body.moves.find((m) => m.ingredientId === toor.id);
    expect(used).toMatchObject({ qty: -0.182, cost: 25.48 });

    // A table bill (with orders) doesn't use stock again; the order did when it was taken.
    const order = { clientId: crypto.randomUUID(), orderNo: "A1", table: "T1", createdAt: new Date().toISOString(), items: [{ itemId: dal.id, name: "Dal Tadka", variant: "Full", qty: 1, rate: 150 }] };
    await c("POST", "/orders", { orders: [order] });
    await c("POST", "/bills", { bills: [{ ...bill(order.items).bills[0], orderIds: [order.clientId] }] });
    const after2 = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.id === toor.id);
    expect(after2.stock).toBeCloseTo(5 - 0.182 - 0.07, 3);
  });

  it("uses the batch that expires first", async () => {
    const batches = [
      { id: "late", qty: 2, expiry: new Date(Date.now() + 10 * 864e5), receivedAt: new Date() },
      { id: "soon", qty: 1, expiry: new Date(Date.now() + 864e5), receivedAt: new Date() },
    ];
    expect(inv.drawBatches(batches, 1.5)).toEqual([{ ...batches[0], qty: 1.5 }]);
  });
});

describe("cook entries and alerts", () => {
  it("raises waste, count-mismatch, running-out and expiry alerts, and builds the shopping list", async () => {
    const { c, tea, ing } = await shopWithKitchen("k2@x.test");
    const milk = ing("Milk");
    const oil = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Refined oil");
    // Oil isn't in these recipes yet: add it from the starter list.
    if (!oil) await c("POST", "/kitchen/ingredients/starter", { names: ["Refined oil"] });
    const oilId = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Refined oil").id;

    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: oilId, type: "purchase", qty: 5, unit: "L", cost: 750 })] });
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: oilId, type: "waste", qty: 2, unit: "L", reason: "spilled" })] });
    let alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.find((a) => a.type === "waste").message).toMatch(/2 L Refined oil spilled · ₹300 · by Owner/);

    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: oilId, type: "count", qty: 2.2, unit: "L" })] });
    alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.find((a) => a.type === "variance").message).toMatch(/expected 3 L, counted 2.2 L \(800 ml missing/);

    // Milk: 2 L bought, then 16 teas × 100 ml = 1.6 L used → running out.
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: milk.id, type: "purchase", qty: 2, unit: "L", cost: 120 })] });
    await c("POST", "/bills", bill([{ itemId: tea.id, name: "Tea", qty: 16, rate: 10 }]));
    alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    const low = alerts.find((a) => a.ingredientId === milk.id && (a.type === "low" || a.type === "out"));
    expect(low.message).toMatch(/Milk: 400 ml left.*Please arrange/);
    expect((await c("GET", "/kitchen/alerts/count")).body.count).toBeGreaterThan(0);

    const list = (await c("GET", "/kitchen/shopping-list")).body;
    const milkLine = list.items.find((i) => i.name === "Milk");
    expect(milkLine.qty).toBeGreaterThan(0);
    expect(milkLine.cost).toBe(Math.round(milkLine.qty * 60 * 100) / 100);

    // Restocking settles the running-out alert.
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: milk.id, type: "purchase", qty: 10, unit: "L", cost: 600 })] });
    alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.some((a) => a.ingredientId === milk.id && (a.type === "low" || a.type === "out"))).toBe(false);

    // Paneer bought with a 1-day expiry.
    await c("POST", "/kitchen/ingredients/starter", { names: ["Paneer"] });
    const paneer = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Paneer");
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: paneer.id, type: "purchase", qty: 2, unit: "kg", expiry: new Date(Date.now() + 20 * 3600e3).toISOString() })] });
    alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.find((a) => a.type === "expiring").message).toMatch(/2 kg Paneer expires (today|tomorrow)/);
    // The same entry sent twice (offline retry) only counts once.
    const twice = move({ ingredientId: paneer.id, type: "waste", qty: 0.1, unit: "kg", reason: "dropped" });
    await c("POST", "/kitchen/moves", { moves: [twice, twice] });
    expect((await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.id === paneer.id).stock).toBeCloseTo(1.9, 3);

    const report = (await c("GET", "/kitchen/report")).body;
    expect(report.totals.wasteCost).toBeGreaterThan(300);
    expect(report.totals.foodCostPct).not.toBeNull();
    expect(report.waste[0]).toHaveProperty("by");
  });
});

describe("kitchen phone and staff", () => {
  it("is limited to kitchen screens, and entries need a staff PIN", async () => {
    const { c, ing } = await shopWithKitchen("k3@x.test");
    const ramesh = (await c("POST", "/staff", { name: "Ramesh", role: "cook", pin: "1234", wageType: "monthly", wage: 15000 })).body;
    expect(ramesh).toMatchObject({ name: "Ramesh", hasPin: true });
    expect(ramesh).not.toHaveProperty("pinHash");

    const k = client();
    await k("POST", "/auth/login", { email: "k3@x.test", password: "secret12" });
    expect((await k("POST", "/auth/kitchen-mode", { password: "nope" })).status).toBe(400);
    const km = await k("POST", "/auth/kitchen-mode", { password: "secret12" });
    expect(km.body.user.role).toBe("kitchen");
    expect((await k("GET", "/auth/me")).body.user.role).toBe("kitchen");
    for (const [m, p] of [["GET", "/bills"], ["GET", "/analytics"], ["GET", "/kitchen/report"], ["PUT", "/shop"], ["GET", "/expenses"], ["GET", "/staff/attendance?month=2026-10"]]) {
      expect((await k(m, p, m === "PUT" ? {} : undefined)).status, `${m} ${p}`).toBe(403);
    }
    expect((await k("GET", "/kitchen/ingredients")).status).toBe(200);
    expect((await k("GET", "/staff")).body.staff).toEqual([{ id: ramesh.id, name: "Ramesh", role: "cook" }]);

    const milk = ing("Milk");
    const entry = { moves: [move({ ingredientId: milk.id, type: "purchase", qty: 1, unit: "L" })] };
    expect((await k("POST", "/kitchen/moves", entry)).body.code).toBe("STAFF_PIN");
    expect((await k("POST", "/staff/verify-pin", { staffId: ramesh.id, pin: "0000" })).status).toBe(401);
    const { token } = (await k("POST", "/staff/verify-pin", { staffId: ramesh.id, pin: "1234" })).body;
    k.setHeader("x-staff-token", token);
    expect((await k("POST", "/kitchen/moves", { moves: [move({ ingredientId: milk.id, type: "waste", qty: 0.5, unit: "L", reason: "spilled" })] })).body.results[0].ok).toBe(true);
    const alerts = (await k("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.find((a) => a.type === "waste").message).toMatch(/by Ramesh/);

    for (let i = 0; i < 8; i++) await k("POST", "/staff/verify-pin", { staffId: ramesh.id, pin: "9999" });
    expect((await k("POST", "/staff/verify-pin", { staffId: ramesh.id, pin: "1234" })).status).toBe(429);
  });
});

describe("attendance and salary", () => {
  it("works out monthly and daily wages with half days, overtime and advances", async () => {
    const { salaryFor } = await import("../shared/salary.js");
    const recs = (spec) => Object.entries(spec).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));
    // October: 31 days. 22 present + 2 half + 4 week offs + 1 absent + 2 unpaid leave; 6 h overtime at ₹50.
    const s = salaryFor(
      { wageType: "monthly", wage: 15500, otRate: 50 },
      "2026-10",
      [...recs({ present: 22, half: 2, weekoff: 4, absent: 1, leave: 2 }), { status: "present", otHours: 6 }].slice(0, 31),
      [{ amount: 2000 }],
      [{ amount: 3000 }]
    );
    expect(s.perDay).toBe(500);
    expect(s.paidDays).toBe(22 + 1 + 4 + (0)); // 31 records cap: 22 P (one with OT) + 2 H + 4 WO + 1 A + 2 L
    expect(s.earned).toBe(13500);
    expect(s.overtime).toBe(0);
    const d = salaryFor({ wageType: "daily", wage: 400, otRate: 60 }, "2026-10", [...recs({ present: 10, half: 2, weekoff: 2 }), { status: "present", otHours: 3 }], [{ amount: 500 }]);
    expect(d.paidDays).toBe(12);
    expect(d.earned).toBe(4800);
    expect(d.overtime).toBe(180);
    expect(d.payable).toBe(4800 + 180 - 500);
  });

  it("lets the owner mark days, give advances and pay salary (added to expenses)", async () => {
    const { c } = await shopWithKitchen("k4@x.test");
    const w = (await c("POST", "/staff", { name: "Sita", role: "helper", wageType: "daily", wage: 400 })).body;
    for (const [date, status] of [["2026-10-01", "present"], ["2026-10-02", "half"], ["2026-10-03", "absent"]]) {
      expect((await c("PUT", "/staff/attendance", { staffId: w.id, date, status, ...(date === "2026-10-01" && { otHours: 2 }) })).status).toBe(200);
    }
    await c("PUT", "/staff/attendance", { staffId: w.id, date: "2026-10-03", status: "none" });
    await c("POST", `/staff/${w.id}/advances`, { amount: 100, date: "2026-10-02", note: "medicine" });
    let m = (await c("GET", "/staff/attendance?month=2026-10")).body;
    expect(m.records).toHaveLength(2);
    expect(m.salary[w.id]).toMatchObject({ paidDays: 1.5, earned: 600, advance: 100, payable: 500 });

    await c("POST", `/staff/${w.id}/salary-paid`, { month: "2026-10", amount: 500, date: "2026-10-31" });
    m = (await c("GET", "/staff/attendance?month=2026-10")).body;
    expect(m.salary[w.id]).toMatchObject({ paid: 500, payable: 0 });
    const exp = (await c("GET", "/expenses")).body.expenses;
    expect(exp.find((e) => e.category === "Salary")).toMatchObject({ amount: 500, note: "Sita · salary 2026-10" });
  });
});
