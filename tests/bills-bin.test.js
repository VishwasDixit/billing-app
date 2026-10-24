import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "bin-test";
  process.env.JWT_SECRET = "bin-test-secret-bin-test-secret-bin";
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

async function setup(email) {
  const c = client();
  await c("POST", "/auth/register", { shopName: "Bin Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const menu = (await c("GET", "/menu")).body;
  const dal = menu.find((m) => m.name === "Dal Tadka");
  const tea = menu.find((m) => m.name === "Tea");
  // Count dal plates, and track toor dal in the kitchen.
  await c("PUT", `/menu/${dal.id}/stock`, { stock: 20 });
  await c("POST", "/kitchen/recipes/standard", { itemIds: [dal.id] });
  const toor = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Toor dal");
  await c("POST", "/kitchen/moves", { moves: [{ clientId: crypto.randomUUID(), ingredientId: toor.id, type: "purchase", qty: 5, unit: "kg" }] });
  const save = async (items, extra = {}) => {
    const clientId = crypto.randomUUID();
    await c("POST", "/bills", { bills: [{ clientId, billNo: "A-" + Math.floor(Math.random() * 1e6), createdAt: new Date().toISOString(), items, ...extra }] });
    return (await c("GET", "/bills")).body.bills.find((b) => b.clientId === clientId);
  };
  const dalStock = async () => (await c("GET", "/menu")).body.find((m) => m.id === dal.id).stock;
  const toorStock = async () => (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.id === toor.id).stock;
  return { c, dal, tea, toor, save, dalStock, toorStock };
}
const line = (m, qty, variant = "Full", rate = 150) => ({ itemId: m.id, name: m.name, variant, qty, rate });

describe("editing, deleting and restoring bills", () => {
  it("edits a bill: same number, new total, history kept, stock moved by the difference", async () => {
    const { c, dal, tea, save, dalStock, toorStock } = await setup("edit@test.local");
    const b = await save([line(dal, 2)]);
    expect(await dalStock()).toBe(18);
    expect(await toorStock()).toBeCloseTo(5 - 0.14, 3);

    const r = await c("PUT", `/bills/${b.id}`, { items: [line(dal, 3), line(tea, 2, "", 15)], discount: { type: "flat", value: 10 }, gstPercent: 0, paymentMode: "upi", reason: "added" });
    expect(r.status).toBe(200);
    expect(r.body.billNo).toBe(b.billNo);
    expect(r.body.total).toBe(450 + 30 - 10);
    expect(r.body.paymentMode).toBe("upi");
    expect(r.body.revisions).toHaveLength(1);
    expect(r.body.revisions[0]).toMatchObject({ action: "edit", reason: "added", by: "Owner" });
    expect(r.body.revisions[0].before.total).toBe(300);
    expect(await dalStock()).toBe(17); // one more plate
    expect(await toorStock()).toBeCloseTo(5 - 0.21, 3);

    // Edited down: the extra plate goes back.
    await c("PUT", `/bills/${b.id}`, { items: [line(dal, 1)], discount: { type: "percent", value: 0 }, gstPercent: 0, paymentMode: "cash", reason: "items" });
    expect(await dalStock()).toBe(19);
    expect(await toorStock()).toBeCloseTo(5 - 0.07, 3);
  });

  it("deletes into the bin, not counted anywhere, and restores as edited", async () => {
    const { c, dal, save, dalStock, toorStock } = await setup("bin@test.local");
    const keep = await save([line(dal, 1)]);
    const b = await save([line(dal, 2)]);
    expect(await dalStock()).toBe(17);

    expect((await c("POST", `/bills/${b.id}/delete`, { reason: "other" })).status).toBe(400); // "other" needs a note
    const d = await c("POST", `/bills/${b.id}/delete`, { reason: "cancelled" });
    expect(d.body).toMatchObject({ status: "deleted", deleteReason: "cancelled", foodMade: false, deletedBy: "Owner" });
    expect(new Date(d.body.purgeAt) - new Date(d.body.deletedAt)).toBe(30 * 864e5);
    // Food wasn't made: plates and dal go back.
    expect(await dalStock()).toBe(19);
    expect(await toorStock()).toBeCloseTo(5 - 0.07, 3);

    // Gone from history and sales; shown in the bin.
    const list = (await c("GET", "/bills")).body.bills;
    expect(list.map((x) => x.id)).toEqual([keep.id]);
    expect((await c("GET", "/bills?bin=1")).body.bills.map((x) => x.id)).toEqual([b.id]);
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    expect((await c("GET", `/kitchen/report?from=${today}&to=${today}`)).body.totals.sales).toBe(150);
    // Can't be edited or deleted again while in the bin.
    expect((await c("POST", `/bills/${b.id}/delete`, { reason: "test" })).status).toBe(409);

    const ch = (await c("GET", `/bills/changes?from=${today}&to=${today}`)).body;
    expect(ch).toMatchObject({ deleted: 1, deletedAmount: 300 });

    // Restore: counted again, marked, stock taken again.
    const r = await c("POST", `/bills/${b.id}/restore`, {});
    expect(r.body.status).toBe("paid");
    expect(r.body.restoredAt).toBeTruthy();
    expect(r.body.purgeAt).toBeUndefined();
    expect(r.body.revisions.at(-1)).toMatchObject({ action: "restore" });
    expect(r.body.revisions.at(-1).note).toMatch(/Customer cancelled/);
    expect(await dalStock()).toBe(17);
    expect((await c("GET", `/kitchen/report?from=${today}&to=${today}`)).body.totals.sales).toBe(450);
  });

  it("walk-outs keep stock used; udhar dues drop when the bill is deleted", async () => {
    const { c, dal, save, dalStock } = await setup("udhar@test.local");
    const customer = { clientId: crypto.randomUUID(), name: "Ramesh", phone: "9000000001" };
    const b = await save([line(dal, 2)], { paymentMode: "credit", customer, paidNow: 0 });
    const due = async () => (await c("GET", "/customers")).body.customers.find((x) => x.clientId === customer.clientId).due;
    expect(await due()).toBe(300);
    await c("POST", `/bills/${b.id}/delete`, { reason: "nopay" });
    expect(await dalStock()).toBe(18); // food was made and eaten
    expect(await due()).toBe(0);
  });

  it("keeps a permanent audit line after the bin clears", async () => {
    const { c, dal, save } = await setup("audit@test.local");
    const b = await save([line(dal, 1)]);
    await c("POST", `/bills/${b.id}/delete`, { reason: "duplicate" });
    const db = await getDb();
    const indexes = await db.collection("bills").indexes();
    expect(indexes.some((i) => i.key.purgeAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
    await db.collection("bills").deleteOne({ clientId: b.clientId }); // what the TTL index does after 30 days
    const lines = await db.collection("billAudit").find({ clientId: b.clientId }).toArray();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "delete", billNo: b.billNo, total: 150, reason: "duplicate", by: "Owner" });
  });

  it("owner PIN guards changes, locks after wrong tries, and old bills always need it", async () => {
    const { c, dal, save } = await setup("pin@test.local");
    const b = await save([line(dal, 1)]);
    expect((await c("PUT", "/shop/bill-pin", { password: "wrong", pin: "4321" })).status).toBe(400);
    const shop = (await c("PUT", "/shop/bill-pin", { password: "secret12", pin: "4321" })).body;
    expect(shop.billPin).toBe(true);
    expect(shop.billPinHash).toBeUndefined();

    const no = await c("POST", `/bills/${b.id}/delete`, { reason: "test" });
    expect(no.status).toBe(401);
    expect(no.body.code).toBe("OWNER_PIN");
    for (let i = 0; i < 5; i++) expect((await c("POST", `/bills/${b.id}/delete`, { reason: "test", pin: "0000" })).status).toBe(401);
    expect((await c("POST", `/bills/${b.id}/delete`, { reason: "test", pin: "4321" })).status).toBe(429);
    await (await getDb()).collection("rateLimits").deleteMany({});
    expect((await c("POST", `/bills/${b.id}/delete`, { reason: "test", pin: "4321" })).status).toBe(200);

    // PIN off: recent bills change freely, week-old ones still need a PIN (and one must be set).
    await c("PUT", "/shop/bill-pin", { password: "secret12", pin: null });
    const db = await getDb();
    const old = await save([line(dal, 1)]);
    await db.collection("bills").updateOne({ clientId: old.clientId }, { $set: { createdAt: new Date(Date.now() - 8 * 864e5) } });
    const r = await c("POST", `/bills/${old.id}/delete`, { reason: "test" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("OWNER_PIN_SETUP");
  });
});
