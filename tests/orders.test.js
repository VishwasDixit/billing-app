import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "orders-test";
  process.env.JWT_SECRET = "orders-test-secret-orders-test";
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

async function shopWithTables(email, { paid = true } = {}) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Table Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  expect(r.status).toBe(201);
  const { ObjectId } = await import("mongodb");
  if (paid) {
    await (await getDb()).collection("shops").updateOne(
      { _id: new ObjectId(r.body.shop.id) },
      { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
    );
  }
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }], qrOrdering: true });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const menu = (await c("GET", "/menu")).body;
  return { c, token, menu, shopId: r.body.shop.id };
}

const pub = () => client();

describe("QR table ordering", () => {
  it("shows the menu and takes an order that staff accept, with prices from the server", async () => {
    const { c, token, menu } = await shopWithTables("qr1@x.test");
    const p = pub();
    const page = await p("GET", `/public/shop/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.ordering.open).toBe(true);
    expect(page.body.tables).toEqual([{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }]);
    expect(page.body.menu.length).toBeGreaterThan(10);
    expect(JSON.stringify(page.body)).not.toContain("orderToken");

    const one = menu.find((m) => m.variants.length === 1);
    const two = menu.find((m) => m.variants.length > 1);
    const placed = await p("POST", `/public/shop/${token}/orders`, {
      table: "T2",
      items: [
        { itemId: one.id, qty: 2, rate: 1 }, // a rate sent by the phone is ignored
        { itemId: two.id, variant: two.variants[1].label, qty: 1, note: "less spicy" },
      ],
      note: "window seat",
    });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({ orderNo: "Q1", status: "new", total: one.variants[0].price * 2 + two.variants[1].price });

    const st = await p("GET", `/public/shop/${token}/orders/${placed.body.orderId}?k=${placed.body.key}`);
    expect(st.body).toMatchObject({ status: "new", tableName: "Table 2" });
    expect((await p("GET", `/public/shop/${token}/orders/${placed.body.orderId}?k=wrong`)).status).toBe(404);

    expect((await c("GET", "/orders/summary")).body.waiting).toBe(1);
    const list = (await c("GET", "/orders")).body.orders;
    expect(list[0]).toMatchObject({ orderNo: "Q1", source: "qr", table: "T2", status: "new" });
    expect(list[0]).not.toHaveProperty("customerKey");
    expect(list[0].items[1]).toMatchObject({ variant: two.variants[1].label, note: "less spicy" });

    expect((await c("POST", `/orders/${placed.body.orderId}/status`, { status: "accepted" })).body.status).toBe("accepted");
    expect((await c("POST", `/orders/${placed.body.orderId}/status`, { status: "accepted" })).status).toBe(409);
    expect((await c("POST", `/orders/${placed.body.orderId}/status`, { status: "preparing" })).body.status).toBe("preparing");
    expect((await c("POST", `/orders/${placed.body.orderId}/status`, { status: "ready" })).body.status).toBe("ready");
    expect((await p("GET", `/public/shop/${token}/orders/${placed.body.orderId}?k=${placed.body.key}`)).body.status).toBe("ready");
    expect((await c("GET", "/orders/summary")).body.waiting).toBe(0);

    // Numbers count up for the day.
    const second = await p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [{ itemId: one.id, qty: 1 }] });
    expect(second.body.orderNo).toBe("Q2");
    const rej = await c("POST", `/orders/${second.body.orderId}/status`, { status: "rejected", reason: "Item finished" });
    expect(rej.body).toMatchObject({ status: "rejected", rejectReason: "Item finished" });
    expect((await p("GET", `/public/shop/${token}/orders/${second.body.orderId}?k=${second.body.key}`)).body).toMatchObject({ status: "rejected", reason: "Item finished" });
  });

  it("refuses bad tables, items, tokens, closed ordering and trial shops", async () => {
    const { c, token, menu } = await shopWithTables("qr2@x.test");
    const p = pub();
    const one = menu.find((m) => m.variants.length === 1);
    expect((await p("POST", `/public/shop/${token}/orders`, { table: "T9", items: [{ itemId: one.id, qty: 1 }] })).status).toBe(400);
    expect((await p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [{ itemId: "nope", qty: 1 }] })).status).toBe(400);
    expect((await p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [] })).status).toBe(400);
    expect((await p("GET", `/public/shop/not-a-real-token-123456`)).status).toBe(404);

    await c("PUT", `/menu/${one.id}`, { active: false });
    expect((await p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [{ itemId: one.id, qty: 1 }] })).body.error).toMatch(/no longer on the menu/);

    await c("PUT", "/shop", { qrOrdering: false });
    expect((await p("GET", `/public/shop/${token}`)).body.ordering.open).toBe(false);
    await c("PUT", "/shop", { qrOrdering: true });

    // A new link stops old QR codes.
    const fresh = (await c("POST", "/shop/order-token")).body.orderToken;
    expect(fresh).not.toBe(token);
    expect((await p("GET", `/public/shop/${token}`)).status).toBe(404);

    const trial = await shopWithTables("qr-trial@x.test", { paid: false });
    const tp = await p("GET", `/public/shop/${trial.token}`);
    expect(tp.body.ordering).toMatchObject({ open: false });
    expect((await p("POST", `/public/shop/${trial.token}/orders`, { table: "T1", items: [{ itemId: trial.menu[0].id, qty: 1 }] })).status).toBe(403);
  });

  it("limits orders per table", async () => {
    const { token, menu } = await shopWithTables("qr3@x.test");
    const p = pub();
    const item = { itemId: menu.find((m) => m.variants.length === 1).id, qty: 1 };
    const statuses = [];
    for (let i = 0; i < 26; i++) statuses.push((await p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [item] })).status);
    expect(statuses.slice(0, 25).every((s) => s === 200)).toBe(true);
    expect(statuses[25]).toBe(429);
  });
});

describe("staff orders and billing a table", () => {
  it("uploads offline staff orders once, and a table bill marks its orders billed", async () => {
    const { c, token, menu } = await shopWithTables("staff@x.test");
    const item = menu.find((m) => m.variants.length === 1);
    const order = {
      clientId: crypto.randomUUID(),
      orderNo: "A1",
      table: "T1",
      tableName: "Table 1",
      createdAt: new Date().toISOString(),
      items: [{ itemId: item.id, name: item.name, qty: 3, rate: item.variants[0].price }],
    };
    const up = await c("POST", "/orders", { orders: [order, order] });
    expect(up.body.results.map((r) => r.ok)).toEqual([true, true]);
    expect(up.body.results[1].duplicate).toBe(true);
    const qr = await pub()("POST", `/public/shop/${token}/orders`, { table: "T1", items: [{ itemId: item.id, qty: 1 }] });
    await c("POST", `/orders/${qr.body.orderId}/status`, { status: "accepted" });

    let open = (await c("GET", "/orders")).body.orders.filter((o) => o.table === "T1");
    expect(open.map((o) => [o.orderNo, o.status, o.source])).toEqual([["A1", "accepted", "staff"], ["Q1", "accepted", "qr"]]);

    const bill = {
      clientId: crypto.randomUUID(),
      billNo: "A-1",
      createdAt: new Date().toISOString(),
      items: [{ name: item.name, qty: 4, rate: item.variants[0].price }],
      paymentMode: "cash",
      table: "Table 1",
      orderIds: open.map((o) => o.clientId),
    };
    expect((await c("POST", "/bills", { bills: [bill] })).body.results[0].ok).toBe(true);
    open = (await c("GET", "/orders")).body.orders.filter((o) => o.table === "T1");
    expect(open.map((o) => o.status)).toEqual(["billed", "billed"]);
    expect((await c("GET", "/bills")).body.bills[0]).toMatchObject({ table: "Table 1", orderIds: bill.orderIds });
  });
});
