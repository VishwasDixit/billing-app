import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "qrpay-test";
  process.env.JWT_SECRET = "qrpay-test-secret-qrpay-test-secret";
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

async function shop(email, qrPayment) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Pay Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne(
    { _id: new ObjectId(r.body.shop.id) },
    { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
  );
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true, upiId: "dhaba@okaxis", qrPayment });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const menu = (await c("GET", "/menu")).body;
  const tea = menu.find((m) => m.name === "Tea");
  await c("PUT", `/menu/${tea.id}/stock`, { stock: 50 });
  const p = client();
  const order = async (qty = 2) => (await p("POST", `/public/shop/${token}/orders`, { name: "Ravi", phone: "9876500001", table: "T1", items: [{ itemId: tea.id, qty }] })).body;
  const pay = (o, method, extra = {}) => p("POST", `/public/shop/${token}/orders/${o.orderId}/pay`, { key: o.key, method, ...extra });
  const status = async (o) => (await p("GET", `/public/shop/${token}/orders/${o.orderId}?k=${o.key}`)).body;
  const teaStock = async () => (await c("GET", "/menu")).body.find((m) => m.id === tea.id).stock;
  return { c, token, tea, order, pay, status, teaStock };
}

describe("paying for QR orders", () => {
  it("at the end: no paying while ordering", async () => {
    const { order, pay } = await shop("end@test.local", "end");
    const o = await order();
    expect(o.pay).toMatchObject({ rule: "end", state: "end" });
    expect((await pay(o, "upi")).status).toBe(400);
  });

  it("customer chooses: pay now by UPI, staff confirm; the bill only asks for the rest", async () => {
    const { c, tea, order, pay, status } = await shop("choose@test.local", "choose");
    const o = await order(2); // 2 × ₹15
    expect(o.pay).toMatchObject({ rule: "choose", state: "choose", amount: 30 });
    const later = await order(1);
    expect((await pay(later, "end")).body.pay.state).toBe("end");

    expect((await pay(o, "upi", { utr: "123456789012" })).body.pay.state).toBe("claimed");
    // Wrong key is refused.
    expect((await client()("POST", `/public/shop/${(await c("GET", "/shop")).body.orderToken}/orders/${o.orderId}/pay`, { key: "nope", method: "upi" })).status).toBe(404);
    // Not received → back to choosing, with a note for the customer.
    await c("POST", `/orders/${o.orderId}/payment`, { action: "reject" });
    expect((await status(o)).pay).toMatchObject({ state: "choose", notReceived: true });
    await pay(o, "upi");
    const conf = await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" });
    expect(conf.body.pay).toMatchObject({ state: "paid", confirmedBy: "Owner" });
    expect(conf.body.status).toBe("new"); // the staff still accept it as usual
    await c("POST", `/orders/${o.orderId}/status`, { status: "accepted" });
    await c("POST", `/orders/${later.orderId}/status`, { status: "accepted" });

    // Confirming made bill P-1 for the paid order, with the customer on it.
    const bills = async () => (await c("GET", "/bills")).body.bills;
    const p1 = (await bills()).find((b) => b.billNo === "P-1");
    expect(p1).toMatchObject({ total: 30, paymentMode: "upi", orderIds: [o.orderId], customer: { name: "Ravi", phone: "9876500001" }, paymentConfirmedBy: "Owner" });
    expect(conf.body.bill.billNo).toBe("P-1");
    expect((await status(o)).bill).toMatchObject({ billNo: "P-1", paymentConfirmed: true });

    // The table's bill covers only the unpaid order; the paid one is closed with it.
    const clientId = crypto.randomUUID();
    await c("POST", "/bills", { bills: [{ clientId, billNo: "T-1", createdAt: new Date().toISOString(), paymentMode: "cash", orderIds: [o.orderId, later.orderId], items: [{ itemId: tea.id, name: "Tea", qty: 1, rate: 15 }] }] });
    const tb = (await bills()).find((b) => b.clientId === clientId);
    expect(tb.total).toBe(15);
    expect(tb.prepaid).toBeUndefined();
    const orders = (await c("GET", "/orders")).body.orders;
    expect(orders.find((x) => x.clientId === o.orderId)).toMatchObject({ status: "billed", billNo: "P-1" });
    expect(orders.find((x) => x.clientId === later.orderId)).toMatchObject({ status: "billed", billClientId: clientId });
  });

  it("a table where everything was paid can be closed without a new bill", async () => {
    const { c, order, pay } = await shop("full@test.local", "choose");
    const o = await order(2);
    const unpaid = await order(1);
    await pay(o, "upi");
    await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" });
    await c("POST", `/orders/${o.orderId}/status`, { status: "accepted" });
    await c("POST", `/orders/${unpaid.orderId}/status`, { status: "accepted" });
    expect((await c("POST", "/orders/close-table", { table: "T1" })).status).toBe(409); // one still unpaid
    await c("POST", `/orders/${unpaid.orderId}/status`, { status: "rejected" });
    const r = await c("POST", "/orders/close-table", { table: "T1" });
    expect(r.body.closed).toBe(1);
  });

  it("asks QR customers for their name and mobile, and adds them to the customer list", async () => {
    const { c, token, tea } = await shop("contact@test.local", "end");
    const p = client();
    const send = (extra) => p("POST", `/public/shop/${token}/orders`, { table: "T1", items: [{ itemId: tea.id, qty: 1 }], ...extra });
    expect((await send({ phone: "9876500001" })).status).toBe(400);
    expect((await send({ name: "Ravi", phone: "12345" })).body.error).toMatch(/10-digit mobile/);
    expect((await send({ name: "Ravi", phone: "+91 98765 00002" })).status).toBe(200);
    expect((await send({ name: "Ravi K", phone: "09876500002" })).status).toBe(200);
    const list = (await c("GET", "/customers")).body.customers.filter((x) => x.phone === "9876500002");
    expect(list).toHaveLength(1); // matched by mobile, not added twice
    const staff = (await c("GET", "/orders")).body.orders;
    expect(staff[0]).toMatchObject({ customerName: "Ravi", customerPhone: "9876500002" });
  });

  it("pay first: held (no stock, can't be accepted) until the payment is confirmed", async () => {
    const { c, order, pay, status, teaStock } = await shop("first@test.local", "first");
    const o = await order(2);
    expect(o.pay).toMatchObject({ rule: "first", state: "due" });
    expect((await pay(o, "end")).status).toBe(400);
    const acc = await c("POST", `/orders/${o.orderId}/status`, { status: "accepted" });
    expect(acc.status).toBe(409);
    expect(acc.body.code).toBe("PAY_FIRST");
    expect(await teaStock()).toBe(50);

    // Pays at the counter: staff take the cash and confirm → straight to the kitchen.
    expect((await pay(o, "counter")).body.pay).toMatchObject({ state: "due", method: "counter" });
    const conf = await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" });
    expect(conf.body).toMatchObject({ status: "accepted", pay: { state: "paid", method: "counter" } });
    expect(await teaStock()).toBe(48); // stock taken once, not again by the bill
    expect((await status(o)).status).toBe("accepted");
    expect(conf.body.bill).toMatchObject({ billNo: "P-1", paymentMode: "cash" });
  });

  it("cancelling a paid order flags a refund until it's handed back", async () => {
    const { c, order, pay } = await shop("refund@test.local", "choose");
    const o = await order(1);
    await pay(o, "upi");
    await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" });
    const rej = await c("POST", `/orders/${o.orderId}/status`, { status: "rejected", reason: "Tea finished" });
    expect(rej.body.pay.state).toBe("refundDue");
    const bin = (await c("GET", "/bills?bin=1")).body.bills;
    expect(bin[0]).toMatchObject({ billNo: "P-1", deleteReason: "cancelled" });
    expect(bin[0].deleteNote).toMatch(/refund due/);
    expect((await c("POST", `/orders/${o.orderId}/payment`, { action: "refunded" })).body.pay.state).toBe("refunded");
    expect((await pay(o, "upi")).status).toBe(409); // closed
  });

  it("limits payment tries per order", async () => {
    const { order, pay } = await shop("limit@test.local", "choose");
    const o = await order(1);
    for (let i = 0; i < 10; i++) await pay(o, "end");
    expect((await pay(o, "end")).status).toBe(429);
  });

  it("a table that paid everything can just say it's leaving", async () => {
    const { c, token, order, pay } = await shop("leaving@test.local", "choose");
    const o = await order(1);
    await pay(o, "upi");
    await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" });
    await c("POST", `/orders/${o.orderId}/status`, { status: "accepted" });
    const r = await client()("POST", `/public/shop/${token}/bill-request`, { orderId: o.orderId, key: o.key, method: "paid" });
    expect(r.body.billRequest.method).toBe("paid");
    const staff = (await c("GET", "/orders")).body.orders.find((x) => x.clientId === o.orderId);
    expect(staff.billRequest.method).toBe("paid");
  });

  it("two staff phones confirming at the same moment make one bill", async () => {
    const { c, order, pay } = await shop("race@test.local", "choose");
    const o = await order(1);
    await pay(o, "upi");
    const r = await Promise.all(Array.from({ length: 6 }, () => c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" })));
    expect(r.filter((x) => x.status === 200)).toHaveLength(1);
    expect(r.filter((x) => x.status === 409)).toHaveLength(5);
    expect((await c("GET", "/bills")).body.bills.filter((b) => b.billNo.startsWith("P-"))).toHaveLength(1);
  });

  it("orders from one mobile at the same moment save one customer", async () => {
    const { c, token, tea } = await shop("samephone@test.local", "end");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: `Family ${i}`, phone: "9876511111", items: [{ itemId: tea.id, qty: 1 }] })
      )
    );
    expect((await c("GET", "/customers")).body.customers.filter((x) => x.phone === "9876511111")).toHaveLength(1);
  });
});
