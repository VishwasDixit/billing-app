import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "phone-trust-test";
  process.env.JWT_SECRET = "phone-trust-test-secret-phone";
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

async function shopWithTables(email) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Trust Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  expect(r.status).toBe(201);
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne(
    { _id: new ObjectId(r.body.shop.id) },
    { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
  );
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }] });
  await c("PUT", "/shop", { qrOrdering: true });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const dish = (await c("GET", "/menu")).body.find((m) => m.variants.length === 1);
  return { c, token, dish };
}

const PHONE_A = "AAAAAAAAAAAAAAAAAAAA";
const PHONE_B = "BBBBBBBBBBBBBBBBBBBB";

describe("checking QR customers' mobile numbers (free: trust once the shop accepts)", () => {
  it("a new number waits for the staff once; after they accept, that phone orders freely", async () => {
    const { c, token, dish } = await shopWithTables("trust1@x.test");
    const p = client();
    const order = (phone, device) => p("POST", `/public/shop/${token}/orders`, { name: "Asha", phone, table: "T1", device, items: [{ itemId: dish.id, qty: 1 }] });

    const first = await order("9811100001", PHONE_A);
    expect(first.status).toBe(200);
    expect(first.body.phoneCheck).toBe("new");

    // A second order before anyone accepted the first: held back, with a clear reason.
    const again = await order("9811100001", PHONE_A);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("VERIFY_WAIT");
    // Made-up numbers from the same phone don't get round it.
    const other = await order("9811100002", PHONE_A);
    expect(other.status).toBe(409);

    // Staff see the badge, and the phone's key itself is never stored or shown.
    const list = (await c("GET", "/orders")).body;
    const staffView = (list.orders || list).find((o) => o.clientId === first.body.orderId);
    expect(staffView.phoneCheck).toBe("new");
    expect(JSON.stringify(list)).not.toContain(PHONE_A);
    expect(staffView.deviceHash).toBeUndefined();

    expect((await c("POST", `/orders/${first.body.orderId}/status`, { status: "accepted" })).status).toBe(200);

    // Trusted now: more orders go through straight away, even with one still waiting.
    const t1 = await order("9811100001", PHONE_A);
    expect(t1.status).toBe(200);
    expect(t1.body.phoneCheck).toBe("trusted");
    const t2 = await order("9811100001", PHONE_A);
    expect(t2.status).toBe(200);
    for (const o of [t1, t2]) await c("POST", `/orders/${o.body.orderId}/status`, { status: "accepted" });

    // The same number on another phone is "known" (it ordered here before), and waits once.
    const k = await order("9811100001", PHONE_B);
    expect(k.body.phoneCheck).toBe("known");
    expect((await order("9811100001", PHONE_B)).status).toBe(409);
  });

  it("a rejected order doesn't trust the phone", async () => {
    const { c, token, dish } = await shopWithTables("trust2@x.test");
    const p = client();
    const order = () => p("POST", `/public/shop/${token}/orders`, { name: "Prank", phone: "9000000001", table: "T1", device: PHONE_A, items: [{ itemId: dish.id, qty: 1 }] });
    const first = await order();
    await c("POST", `/orders/${first.body.orderId}/status`, { status: "rejected", reason: "No one at the table" });
    const next = await order();
    expect(next.status).toBe(200);
    expect(next.body.phoneCheck).toBe("new");
    expect((await order()).status).toBe(409);
  });

  it("checks the phone key and limits orders from a phone that isn't trusted", async () => {
    const { c, token, dish } = await shopWithTables("trust3@x.test");
    const p = client();
    const bad = await p("POST", `/public/shop/${token}/orders`, { name: "Asha", phone: "9811100001", table: "T1", device: "short", items: [{ itemId: dish.id, qty: 1 }] });
    expect(bad.status).toBe(400);

    // Each order rejected straight away, so only the hourly limit stops this phone.
    const codes = [];
    for (let i = 0; i < 9; i++) {
      const r = await p("POST", `/public/shop/${token}/orders`, { name: "Asha", phone: `98111000${10 + i}`, table: "T1", device: PHONE_B, items: [{ itemId: dish.id, qty: 1 }] });
      codes.push(r.status);
      if (r.status === 200) await c("POST", `/orders/${r.body.orderId}/status`, { status: "rejected" });
    }
    expect(codes.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(codes[8]).toBe(429);
  });
});
