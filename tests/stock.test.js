import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, stock;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "stock-test";
  process.env.JWT_SECRET = "stock-test-secret-stock-test-secret";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  stock = await import("../server/stock.js");
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  stock?.setStockClock(null);
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

async function paidShop(email, extra = {}) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Stock Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne(
    { _id: new ObjectId(r.body.shop.id) },
    { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
  );
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true, ...extra });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const menu = (await c("GET", "/menu")).body;
  const single = menu.filter((m) => m.variants.length === 1);
  return { c, token, a: single[0], b: single[1] };
}
const pub = client();
const order = (token, items) => pub("POST", `/public/shop/${token}/orders`, { table: "T1", items });

describe("menu stock", () => {
  it("hides sold-out dishes from customers and refuses them", async () => {
    const { c, token, a } = await paidShop("so@x.test");
    const r = await c("PUT", `/menu/${a.id}/stock`, { soldOut: true });
    expect(r.body).toMatchObject({ soldOut: true });
    const menu = (await pub("GET", `/public/shop/${token}`)).body.menu;
    expect(menu.some((m) => m.id === a.id)).toBe(false);
    const refused = await order(token, [{ itemId: a.id, qty: 1 }]);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/sold out/);
    await c("PUT", `/menu/${a.id}/stock`, { soldOut: false });
    expect((await pub("GET", `/public/shop/${token}`)).body.menu.some((m) => m.id === a.id)).toBe(true);
  });

  it("counts down on accepted QR orders, staff orders and counter bills, not twice for table bills", async () => {
    const { c, token, a } = await paidShop("count@x.test");
    await c("PUT", `/menu/${a.id}/stock`, { stock: 5 });
    expect((await pub("GET", `/public/shop/${token}`)).body.menu.find((m) => m.id === a.id).left).toBe(5);
    expect((await order(token, [{ itemId: a.id, qty: 6 }])).body.error).toMatch(/Only 5/);

    const q = await order(token, [{ itemId: a.id, qty: 2 }]);
    const left = async () => (await c("GET", "/menu")).body.find((m) => m.id === a.id);
    expect((await left()).stock).toBe(5); // not counted until staff accept
    await c("POST", `/orders/${q.body.orderId}/status`, { status: "accepted" });
    expect((await left()).stock).toBe(3);

    const staff = { clientId: crypto.randomUUID(), orderNo: "A1", table: "T1", createdAt: new Date().toISOString(), items: [{ itemId: a.id, name: a.name, qty: 1, rate: 10 }] };
    await c("POST", "/orders", { orders: [staff, staff] }); // uploaded twice, counted once
    expect((await left()).stock).toBe(2);

    // The table bill covers those orders: no more stock taken.
    await c("POST", "/bills", { bills: [{ clientId: crypto.randomUUID(), billNo: "A-1", createdAt: new Date().toISOString(), items: [{ itemId: a.id, name: a.name, qty: 3, rate: 10 }], orderIds: [q.body.orderId, staff.clientId] }] });
    expect((await left()).stock).toBe(2);

    // A counter bill takes the last 2: sold out.
    await c("POST", "/bills", { bills: [{ clientId: crypto.randomUUID(), billNo: "A-2", createdAt: new Date().toISOString(), items: [{ itemId: a.id, name: a.name, qty: 2, rate: 10 }] }] });
    expect(await left()).toMatchObject({ stock: 0, soldOut: true });
    expect((await pub("GET", `/public/shop/${token}`)).body.menu.some((m) => m.id === a.id)).toBe(false);
  });

  it("starts each day with the daily amount again", async () => {
    const { c, a } = await paidShop("daily@x.test");
    await c("PUT", `/menu/${a.id}/stock`, { stock: 0, dailyStock: 40 });
    expect((await c("GET", "/menu")).body.find((m) => m.id === a.id)).toMatchObject({ stock: 0, soldOut: true, dailyStock: 40 });
    stock.setStockClock(() => new Date(Date.now() + 864e5));
    try {
      expect((await c("GET", "/menu")).body.find((m) => m.id === a.id)).toMatchObject({ stock: 40, soldOut: false });
    } finally {
      stock.setStockClock(null);
    }
  });
});

describe("customer bill on phone", () => {
  it("asks for the bill, shows it after billing, and staff confirm the UPI payment", async () => {
    const { c, token, b } = await paidShop("bill@x.test", { upiId: "dhaba@okaxis" });
    const q = (await order(token, [{ itemId: b.id, qty: 2 }])).body;
    const status = () => pub("GET", `/public/shop/${token}/orders/${q.orderId}?k=${q.key}`);

    // Nothing to bill before the kitchen has it.
    expect((await pub("POST", `/public/shop/${token}/bill-request`, { orderId: q.orderId, key: q.key, method: "upi" })).status).toBe(400);
    await c("POST", `/orders/${q.orderId}/status`, { status: "accepted" });
    expect((await pub("POST", `/public/shop/${token}/bill-request`, { orderId: q.orderId, key: "wrong", method: "upi" })).status).toBe(404);
    const req = await pub("POST", `/public/shop/${token}/bill-request`, { orderId: q.orderId, key: q.key, method: "upi" });
    expect(req.body.billRequest.method).toBe("upi");
    expect((await c("GET", "/orders")).body.orders.find((o) => o.clientId === q.orderId).billRequest.method).toBe("upi");

    const billId = crypto.randomUUID();
    await c("POST", "/bills", {
      bills: [{ clientId: billId, billNo: "A-7", createdAt: new Date().toISOString(), items: [{ itemId: b.id, name: b.name, qty: 2, rate: b.variants[0].price }], paymentMode: "upi", table: "Table 1", orderIds: [q.orderId] }],
    });
    const s = (await status()).body;
    expect(s.status).toBe("billed");
    expect(s.upi).toMatchObject({ id: "dhaba@okaxis" });
    expect(s.bill).toMatchObject({ id: billId, billNo: "A-7", total: b.variants[0].price * 2, paymentMode: "upi", customerPaid: false, paymentConfirmed: false });

    expect((await pub("POST", `/public/shop/${token}/bills/${billId}/paid`, { orderId: q.orderId, key: "nope" })).status).toBe(404);
    expect((await pub("POST", `/public/shop/${token}/bills/${billId}/paid`, { orderId: q.orderId, key: q.key, utr: "412345678901" })).body.ok).toBe(true);
    expect((await status()).body.bill.customerPaid).toBe(true);
    const claims = (await c("GET", "/orders")).body.paymentClaims;
    expect(claims[0]).toMatchObject({ clientId: billId, billNo: "A-7", table: "Table 1", customerPaid: { utr: "412345678901" } });

    const other = (await paidShop("other-bill@x.test")).c;
    expect((await other("POST", `/bills/${billId}/confirm-payment`, { mode: "upi" })).status).toBe(404);
    expect((await c("POST", `/bills/${billId}/confirm-payment`, { mode: "upi" })).status).toBe(200);
    expect((await status()).body.bill.paymentConfirmed).toBe(true);
    expect((await c("GET", "/orders")).body.paymentClaims).toHaveLength(0);
  });

  it("only offers UPI when the shop has a UPI ID", async () => {
    const { c, token, b } = await paidShop("noupi@x.test");
    const q = (await order(token, [{ itemId: b.id, qty: 1 }])).body;
    await c("POST", `/orders/${q.orderId}/status`, { status: "accepted" });
    expect((await pub("POST", `/public/shop/${token}/bill-request`, { orderId: q.orderId, key: q.key, method: "upi" })).status).toBe(400);
    expect((await pub("POST", `/public/shop/${token}/bill-request`, { orderId: q.orderId, key: q.key, method: "counter" })).body.billRequest.method).toBe("counter");
    expect((await pub("GET", `/public/shop/${token}/orders/${q.orderId}?k=${q.key}`)).body.upi).toBeNull();
  });
});
