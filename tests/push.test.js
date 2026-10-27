// Lock-screen alerts (Web Push): staff devices subscribe, and new QR orders, table help, bill
// requests and payment claims reach the right shop's devices (web-push itself is mocked).
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

const sent = vi.hoisted(() => ({ calls: [], dead: new Set() }));
vi.mock("web-push", () => ({
  default: {
    sendNotification: vi.fn(async (sub, payload, opts) => {
      sent.calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
      if (sent.dead.has(sub.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201 };
    }),
  },
}));

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "push-test";
  process.env.JWT_SECRET = "push-test-secret-push-test-secret";
  process.env.VAPID_PUBLIC_KEY = "BTestPublicKey_abc-123";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
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
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

beforeEach(() => {
  sent.calls.length = 0;
  sent.dead.clear();
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

async function shop(email) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Push Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }, { id: "T3", name: "Table 3" }], qrOrdering: true });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const item = (await c("GET", "/menu")).body.find((m) => m.variants.length === 1);
  const code = (await c("GET", "/staff/code")).body.code;
  const worker = async (name, access, pin) => {
    const s = (await c("POST", "/staff", { name, role: "cook", pin, wage: 1, access })).body;
    const w = client();
    expect((await w("POST", "/auth/staff-login", { code, staffId: s.id, pin })).status).toBe(200);
    return w;
  };
  return { c, token, item, worker, shopId: r.body.shop.id };
}

const sub = (name) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomBytes(4).toString("hex")}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
const order = (token, table, item, name = "Ravi") =>
  client()("POST", `/public/shop/${token}/orders`, { name, phone: "9876500001", table, items: [{ itemId: item.id, qty: 2 }] });
const to = () => sent.calls.map((x) => x.endpoint).sort();

describe("lock-screen alerts", () => {
  let A, B, owner, kitchen, manager, other;

  beforeAll(async () => {
    A = await shop("a@push.test");
    B = await shop("b@push.test");
    A.k = await A.worker("Ramu", "kitchen", "1111");
    A.m = await A.worker("Sita", "manager", "2222");
    [owner, kitchen, manager, other] = [sub("owner"), sub("kitchen"), sub("manager"), sub("other")];
  });

  it("staff devices subscribe (checked), and only signed-in staff can", async () => {
    expect((await A.c("GET", "/push/key")).body.publicKey).toBe("BTestPublicKey_abc-123");
    expect((await A.k("GET", "/push/key")).status).toBe(200);
    expect((await A.c("POST", "/push/subscribe", owner)).status).toBe(200);
    expect((await A.k("POST", "/push/subscribe", kitchen)).status).toBe(200);
    expect((await A.m("POST", "/push/subscribe", manager)).status).toBe(200);
    expect((await B.c("POST", "/push/subscribe", other)).status).toBe(200);
    // Saving again updates the same row.
    expect((await A.c("POST", "/push/subscribe", owner)).status).toBe(200);

    expect((await client()("POST", "/push/subscribe", sub("x"))).status).toBe(401);
    expect((await A.c("POST", "/push/subscribe", { ...sub("x"), endpoint: "http://insecure.example.com/x" })).status).toBe(400);
    // Not a real push service (the server would post there): refused.
    for (const endpoint of ["https://push.example.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x"])
      expect((await A.c("POST", "/push/subscribe", { ...sub("x"), endpoint })).status).toBe(400);
    const apple = "https://web.push.apple.com/QGuQyavXutnMhjUDDJcNE";
    expect((await A.c("POST", "/push/subscribe", { ...sub("x"), endpoint: apple })).status).toBe(200);
    await A.c("POST", "/push/unsubscribe", { endpoint: apple });
    expect((await A.c("POST", "/push/subscribe", { endpoint: sub("x").endpoint, keys: {} })).status).toBe(400);

    const rows = await (await getDb()).collection("pushSubs").find({}).toArray();
    expect(rows).toHaveLength(4);
    expect(Object.fromEntries(rows.map((r) => [r.endpoint, r.role]))).toEqual({ [owner.endpoint]: "owner", [kitchen.endpoint]: "kitchen", [manager.endpoint]: "manager", [other.endpoint]: "owner" });
    expect(rows.find((r) => r.endpoint === kitchen.endpoint).name).toBe("Ramu");
  });

  it("a new QR order reaches every device of that shop only, once per table in a short time", async () => {
    expect((await order(A.token, "T1", A.item)).status).toBe(200);
    expect(to()).toEqual([owner.endpoint, kitchen.endpoint, manager.endpoint].sort());
    const { payload, opts } = sent.calls[0];
    expect(payload).toMatchObject({ tag: "orders", url: "/orders", body: expect.stringContaining("2 items") });
    expect(payload.title).toMatch(/New order #Q1 · Table 1/);
    expect(opts).toMatchObject({ urgency: "high", topic: "orders", TTL: 900, vapidDetails: { publicKey: "BTestPublicKey_abc-123", privateKey: "test-private-key" } });

    // A busy table ordering again right away doesn't buzz the phones again; another table does.
    sent.calls.length = 0;
    expect((await order(A.token, "T1", A.item)).status).toBe(200);
    expect(sent.calls).toHaveLength(0);
    expect((await order(A.token, "T2", A.item)).status).toBe(200);
    expect(sent.calls).toHaveLength(3);

    // Shop B's order goes to shop B only.
    sent.calls.length = 0;
    expect((await order(B.token, "T1", B.item)).status).toBe(200);
    expect(to()).toEqual([other.endpoint]);
  });

  it("table help reaches the kitchen too; bills and payments only the counter", async () => {
    const help = (kind, table = "T1") => client()("POST", `/public/shop/${A.token}/help`, { table, deviceKey: crypto.randomBytes(12).toString("base64url"), kind });
    expect((await help("water")).status).toBe(200);
    expect(to()).toEqual([owner.endpoint, kitchen.endpoint, manager.endpoint].sort());
    expect(sent.calls[0].payload.title).toMatch(/Table 1/);
    sent.calls.length = 0;
    await help("water"); // merged with the open one
    expect(sent.calls).toHaveLength(0);

    // The bill: staff accept the order, then the table asks for it.
    const placed = (await order(A.token, "T3", A.item)).body;
    await A.c("POST", `/orders/${placed.orderId}/status`, { status: "accepted" });
    sent.calls.length = 0;
    const br = await client()("POST", `/public/shop/${A.token}/bill-request`, { orderId: placed.orderId, key: placed.key, method: "counter" });
    expect(br.status).toBe(200);
    expect(to()).toEqual([owner.endpoint, manager.endpoint].sort());
    expect(sent.calls[0].payload.title).toMatch(/Table 3 asks for the bill/);

    // A customer says they paid an order by UPI: the counter is told, not the kitchen.
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(A.shopId) }, { $set: { qrPayment: "first", upiId: "dhaba@upi" } });
    const first = (await order(A.token, "T2", A.item, "Payer")).body;
    sent.calls.length = 0;
    expect((await client()("POST", `/public/shop/${A.token}/orders/${first.orderId}/pay`, { key: first.key, method: "upi", utr: "123456" })).body.pay.state).toBe("claimed");
    expect(to()).toEqual([owner.endpoint, manager.endpoint].sort());
    expect(sent.calls[0].payload.title).toMatch(/says paid by UPI/);
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(A.shopId) }, { $unset: { qrPayment: 1, upiId: 1 } });
  });

  it("devices that are gone are forgotten; unsubscribing works only for your own shop", async () => {
    const db = await getDb();
    sent.dead.add(manager.endpoint);
    await order(A.token, "T1", A.item, "Later").then(() => client()("POST", `/public/shop/${A.token}/help`, { table: "T2", deviceKey: crypto.randomBytes(12).toString("base64url"), kind: "waiter" }));
    expect(sent.calls.some((x) => x.endpoint === manager.endpoint)).toBe(true);
    expect(await db.collection("pushSubs").countDocuments({ endpoint: manager.endpoint })).toBe(0);
    expect(await db.collection("pushSubs").countDocuments({ endpoint: owner.endpoint })).toBe(1);

    // Shop B can't remove shop A's device.
    expect((await B.c("POST", "/push/unsubscribe", { endpoint: kitchen.endpoint })).status).toBe(200);
    expect(await db.collection("pushSubs").countDocuments({ endpoint: kitchen.endpoint })).toBe(1);
    expect((await A.c("POST", "/push/unsubscribe", { endpoint: owner.endpoint })).status).toBe(200);
    expect(await db.collection("pushSubs").countDocuments({ endpoint: owner.endpoint })).toBe(0);

    // A phone that signs in to another shop takes its alerts along: no more from the old one.
    await B.c("POST", "/push/subscribe", kitchen);
    sent.calls.length = 0;
    await client()("POST", `/public/shop/${A.token}/help`, { table: "T3", deviceKey: crypto.randomBytes(12).toString("base64url"), kind: "cutlery" });
    expect(sent.calls).toHaveLength(0);
    await order(B.token, "T2", B.item);
    expect(to()).toEqual([kitchen.endpoint, other.endpoint].sort());
  });

  it("a test alert goes to this device only, if it's saved for this shop", async () => {
    const mine = sub("tester");
    expect((await client()("POST", "/push/test", { endpoint: mine.endpoint })).status).toBe(401);
    // Not subscribed yet, or saved for another shop: refused, nothing sent.
    expect((await A.c("POST", "/push/test", { endpoint: mine.endpoint })).status).toBe(404);
    await A.c("POST", "/push/subscribe", mine);
    expect((await B.c("POST", "/push/test", { endpoint: mine.endpoint })).status).toBe(404);
    expect(sent.calls).toHaveLength(0);

    expect((await A.c("POST", "/push/test", { endpoint: mine.endpoint })).status).toBe(200);
    expect(to()).toEqual([mine.endpoint]);
    expect(sent.calls[0].payload.title).toMatch(/Test alert/);
    expect((await A.c("POST", "/push/test", { endpoint: "https://push.example.com/x" })).status).toBe(400);

    // A gone device is forgotten and the user is told.
    sent.dead.add(mine.endpoint);
    expect((await A.c("POST", "/push/test", { endpoint: mine.endpoint })).status).toBe(502);
    expect(await (await getDb()).collection("pushSubs").countDocuments({ endpoint: mine.endpoint })).toBe(0);

    // At most 10 an hour per device.
    const again = sub("again");
    await A.c("POST", "/push/subscribe", again);
    for (let i = 0; i < 10; i++) expect((await A.c("POST", "/push/test", { endpoint: again.endpoint })).status).toBe(200);
    expect((await A.c("POST", "/push/test", { endpoint: again.endpoint })).status).toBe(429);
    await A.c("POST", "/push/unsubscribe", { endpoint: again.endpoint });
  });

  it("without server keys nothing is offered or sent", async () => {
    const keep = process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      expect((await B.c("GET", "/push/key")).body.publicKey).toBe("");
      expect((await B.c("POST", "/push/subscribe", sub("late"))).status).toBe(503);
      expect((await order(B.token, "T3", B.item)).status).toBe(200);
      expect(sent.calls).toHaveLength(0);
    } finally {
      process.env.VAPID_PRIVATE_KEY = keep;
    }
  });
});
