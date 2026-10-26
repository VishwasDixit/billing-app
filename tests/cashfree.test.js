// Shops' own Cashfree gateway: keys, online payments that confirm orders by themselves (webhook or
// return check, exactly once), failed payments, refunds, and pay-later rules / blocking.
// Cashfree itself is a fake server here (CASHFREE_API_BASE).
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, fake;
const APP_ID = "TEST10001", SECRET = "cfsk_ma_test_abc123secret";

// ---- Fake Cashfree PG ----
const cf = { orders: new Map(), refunds: [], calls: [] };
function startFake() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const send = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
        cf.calls.push({ method: req.method, url: req.url, version: req.headers["x-api-version"] });
        if (req.headers["x-client-id"] !== APP_ID || req.headers["x-client-secret"] !== SECRET) return send(401, { message: "authentication Failed", code: "request_failed" });
        const m = /^\/pg\/orders(?:\/([^/]+))?(\/payments|\/refunds)?$/.exec(req.url.split("?")[0]);
        if (!m) return send(404, { message: "not found" });
        const [, id, sub] = m;
        if (req.method === "POST" && !id) {
          const b = JSON.parse(body);
          cf.orders.set(b.order_id, { ...b, order_status: "ACTIVE", payments: [] });
          return send(200, { order_id: b.order_id, order_amount: b.order_amount, order_status: "ACTIVE", payment_session_id: `session_${b.order_id}` });
        }
        const o = cf.orders.get(id);
        if (!o) return send(404, { message: "order not found", code: "order_not_found" });
        if (sub === "/payments") return send(200, o.payments);
        if (sub === "/refunds") {
          const b = JSON.parse(body);
          cf.refunds.push({ order: id, ...b });
          return send(200, { refund_id: b.refund_id, refund_amount: b.refund_amount, refund_status: "PENDING" });
        }
        return send(200, { order_id: id, order_amount: o.order_amount, order_status: o.order_status });
      });
    });
    s.listen(0, () => resolve(s));
  });
}
// The customer pays (or fails) on Cashfree's page.
function cfPay(orderId, { status = "SUCCESS", amount, group = "upi" } = {}) {
  const o = cf.orders.get(orderId);
  const p = { cf_payment_id: String(Math.floor(Math.random() * 1e9)), payment_status: status, payment_amount: amount ?? o.order_amount, payment_group: group, payment_time: new Date().toISOString() };
  o.payments.unshift(p);
  if (status === "SUCCESS") o.order_status = "PAID";
  return p;
}
function signedWebhook(shopId, orderId, p, secret = SECRET) {
  const raw = JSON.stringify({ type: p.payment_status === "SUCCESS" ? "PAYMENT_SUCCESS_WEBHOOK" : "PAYMENT_FAILED_WEBHOOK", data: { order: { order_id: orderId, order_amount: p.payment_amount }, payment: p } });
  const ts = String(Date.now());
  const sig = crypto.createHmac("sha256", secret).update(ts + raw).digest("base64");
  return fetch(`${base}/public/pay/cashfree/${shopId}`, { method: "POST", headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": sig }, body: raw });
}

beforeAll(async () => {
  fake = await startFake();
  process.env.CASHFREE_API_BASE = `http://127.0.0.1:${fake.address().port}/pg`;
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "cashfree-test";
  process.env.JWT_SECRET = "cashfree-test-secret-cashfree-test-secret";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  server?.close();
  fake?.close();
  await closeDb?.();
  await mongod?.stop();
});

let ipN = 0;
function client(ip = `10.8.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

async function shop(email, settings = {}, { connect = true } = {}) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Online Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const shopId = r.body.shop.id;
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(shopId) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true, qrPayment: "choose", gstPercent: 5, ...settings });
  if (connect) expect((await c("PUT", "/shop/gateway", { appId: APP_ID, secret: SECRET, mode: "test" })).status).toBe(200);
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea"); // ₹15
  const p = client();
  const order = async (body = {}) => (await p("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone: "9876500001", items: [{ itemId: tea.id, qty: 20 }], ...body })).body;
  const payOnline = (o) => p("POST", `/public/shop/${token}/orders/${o.orderId}/pay-online`, { key: o.key });
  const check = (o) => p("GET", `/public/shop/${token}/orders/${o.orderId}/pay-online?k=${o.key}`);
  const pay = (o, method) => p("POST", `/public/shop/${token}/orders/${o.orderId}/pay`, { key: o.key, method });
  return { c, shopId, token, tea, order, payOnline, check, pay };
}

describe("connecting Cashfree", () => {
  it("checks the keys, stores the secret encrypted and never shows it", async () => {
    const { c, shopId } = await shop("connect@cf.test", {}, { connect: false });
    const bad = await c("PUT", "/shop/gateway", { appId: APP_ID, secret: "cfsk_ma_test_wrong999", mode: "test" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Cashfree didn't accept/);
    const ok = await c("PUT", "/shop/gateway", { appId: APP_ID, secret: SECRET, mode: "test" });
    expect(ok.body.gateway).toEqual({ name: "cashfree", mode: "test", appIdEnd: "0001", connectedAt: expect.any(String) });
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);
    expect(JSON.stringify((await c("GET", "/shop")).body)).not.toContain(SECRET);
    const { ObjectId } = await import("mongodb");
    const saved = await (await getDb()).collection("shops").findOne({ _id: new ObjectId(shopId) });
    expect(JSON.stringify(saved)).not.toContain(SECRET); // encrypted at rest
    expect(cf.calls.every((x) => x.version === "2023-08-01")).toBe(true);
    // Managers can't see or change it.
    const mgr = (await c("POST", "/staff", { name: "Sita", role: "manager", pin: "2222", wage: 1 })).body;
    const code = (await c("GET", "/staff/code")).body.code;
    const m = client();
    await m("POST", "/auth/staff-login", { code, staffId: mgr.id, pin: "2222" });
    expect((await m("PUT", "/shop/gateway", { disconnect: true })).status).toBe(403);
    expect((await c("PUT", "/shop/gateway", { disconnect: true })).body.gateway).toBeNull();
  });
});

describe("paying online", () => {
  it("creates the Cashfree order with the server's amount, and the webhook confirms it once", async () => {
    const { c, shopId, order, payOnline, check } = await shop("pay@cf.test");
    const o = await order();
    const r = await payOnline(o);
    expect(r.body).toMatchObject({ paymentSessionId: expect.stringMatching(/^session_/), mode: "sandbox" });
    const cfo = cf.orders.get(r.body.cfOrderId);
    expect(cfo.order_amount).toBe(315); // 20 × ₹15 + 5% GST
    expect(cfo.customer_details.customer_phone).toBe("9876500001");
    expect(cfo.order_meta.notify_url).toMatch(new RegExp(`/api/public/pay/cashfree/${shopId}$`));

    const p = cfPay(r.body.cfOrderId);
    // Webhook and the return check race: one bill, one confirmation.
    const [w1, c1, w2] = await Promise.all([signedWebhook(shopId, r.body.cfOrderId, p), check(o), signedWebhook(shopId, r.body.cfOrderId, p)]);
    expect([w1.status, w2.status]).toEqual([200, 200]);
    expect(c1.body.pay.state).toBe("paid");
    const orders = (await c("GET", "/orders")).body.orders;
    expect(orders[0].pay).toMatchObject({ state: "paid", method: "online", confirmedBy: "Online (Cashfree)" });
    const bills = (await c("GET", "/bills")).body.bills.filter((b) => b.billNo.startsWith("P-"));
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ total: 315, paymentMode: "upi", paymentGateway: { name: "cashfree", orderId: r.body.cfOrderId } });
  });

  it("refuses bad signatures, other shops' ids and wrong amounts", async () => {
    const a = await shop("sig-a@cf.test");
    const b = await shop("sig-b@cf.test");
    const o = await a.order();
    const r = await a.payOnline(o);
    const p = cfPay(r.body.cfOrderId);
    expect((await signedWebhook(a.shopId, r.body.cfOrderId, p, "not-the-secret")).status).toBe(400);
    expect((await signedWebhook(b.shopId, r.body.cfOrderId, p)).status).toBe(200); // accepted, but not b's order
    expect((await a.c("GET", "/orders")).body.orders[0].pay.state).not.toBe("paid");

    const o2 = await a.order({ phone: "9876500002" });
    const r2 = await a.payOnline(o2);
    const short = cfPay(r2.body.cfOrderId, { amount: 1 });
    cf.orders.get(r2.body.cfOrderId).order_status = "ACTIVE"; // Cashfree didn't take the full amount
    await signedWebhook(a.shopId, r2.body.cfOrderId, short);
    const st = (await a.c("GET", "/orders")).body.orders.find((x) => x.clientId === o2.orderId);
    expect(st.pay.state).not.toBe("paid");
  });

  it("pay first: the paid order goes to the kitchen by itself", async () => {
    const { c, order, payOnline, check } = await shop("first@cf.test", { qrPayment: "first" });
    const o = await order();
    expect((await c("POST", `/orders/${o.orderId}/status`, { status: "accepted" })).status).toBe(409);
    const r = await payOnline(o);
    cfPay(r.body.cfOrderId, { group: "credit_card" });
    expect((await check(o)).body).toMatchObject({ status: "accepted", pay: { state: "paid" } });
    const bill = (await c("GET", "/bills")).body.bills[0];
    expect(bill.paymentMode).toBe("card");
  });

  it("a failed payment: pay later if the shop allows it, otherwise retry, and cancel after 15 minutes", async () => {
    const later = await shop("fail-later@cf.test", { payFail: "later" });
    const o = await later.order();
    const r = await later.payOnline(o);
    cfPay(r.body.cfOrderId, { status: "FAILED" });
    expect((await later.check(o)).body.pay).toMatchObject({ failed: true, payLater: true });
    expect((await later.pay(o, "end")).body.pay.state).toBe("end");

    const strict = await shop("fail-cancel@cf.test", { payFail: "cancel", qrPayment: "first" });
    const o2 = await strict.order();
    const r2 = await strict.payOnline(o2);
    cfPay(r2.body.cfOrderId, { status: "FAILED" });
    expect((await strict.check(o2)).body.pay).toMatchObject({ failed: true });
    expect((await strict.pay(o2, "end")).status).toBe(400);
    // 15 minutes later, still unpaid → cancelled.
    const db = await getDb();
    await db.collection("orders").updateOne({ clientId: o2.orderId }, { $set: { createdAt: new Date(Date.now() - 16 * 60e3) } });
    const list = (await strict.c("GET", "/orders")).body.orders;
    expect(list.find((x) => x.clientId === o2.orderId)).toMatchObject({ status: "rejected", rejectReason: expect.stringMatching(/not paid/i) });
  });

  it("cancelling a paid online order refunds through Cashfree", async () => {
    const { c, order, payOnline, check } = await shop("refund@cf.test");
    const o = await order();
    const r = await payOnline(o);
    cfPay(r.body.cfOrderId);
    await check(o);
    expect((await c("POST", `/orders/${o.orderId}/status`, { status: "rejected", reason: "closed" })).body.pay.state).toBe("refundDue");
    const ref = await c("POST", `/orders/${o.orderId}/payment`, { action: "refund-online" });
    expect(ref.body.pay).toMatchObject({ state: "refunded", refund: { status: "PENDING" } });
    expect(cf.refunds.at(-1)).toMatchObject({ order: r.body.cfOrderId, refund_amount: 315 });
  });
});

describe("pay later rules and blocking", () => {
  it("'No one' and blocked customers must pay before the kitchen gets the order", async () => {
    const none = await shop("none@cf.test", { payLater: "none" });
    const o = await none.order();
    expect(o.pay).toMatchObject({ rule: "first", payLater: false });
    expect((await none.pay(o, "end")).status).toBe(400);

    const s = await shop("block@cf.test", { payLater: "unblocked", blockAfter: 2 });
    // Ravi eats and leaves without paying, twice → blocked automatically.
    for (let i = 0; i < 2; i++) {
      const x = await s.order();
      expect(x.pay.payLater).toBe(true);
      await s.c("POST", `/orders/${x.orderId}/status`, { status: "accepted" });
      const left = await s.c("POST", "/orders/left-unpaid", { table: "T1" });
      expect(left.body.customers[0]).toMatchObject({ phone: "9876500001", unpaidCount: i + 1, blocked: i === 1 });
    }
    const after = (await s.c("GET", "/orders")).body.orders.filter((x) => x.status === "unpaid");
    expect(after).toHaveLength(2);
    const blocked = await s.order();
    expect(blocked.pay).toMatchObject({ rule: "first", payLater: false });
    // Someone else can still pay later; the owner can unblock Ravi.
    expect((await s.order({ phone: "9876500003", name: "Asha" })).pay.payLater).toBe(true);
    const ravi = (await s.c("GET", "/customers")).body.customers.find((x) => x.phone === "9876500001");
    expect(ravi).toMatchObject({ unpaidCount: 2, payLaterBlocked: true });
    await s.c("PUT", `/customers/${ravi.id}/pay-later`, { blocked: false });
    expect((await s.order()).pay.payLater).toBe(true);
    // Unpaid orders are not sales.
    expect((await s.c("GET", "/bills")).body.bills).toHaveLength(0);
  });
});
