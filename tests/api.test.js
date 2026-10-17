import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { computeTotals } from "../shared/totals.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "test";
  process.env.JWT_SECRET = "test-secret-test-secret-123";
  process.env.ADMIN_EMAIL = "admin@shop.test";
  process.env.RAZORPAY_KEY_ID = "rzp_test_x";
  process.env.RAZORPAY_KEY_SECRET = "rzp_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "wh_secret";
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

// Tiny client that keeps its own session cookie.
function client() {
  let cookie = "";
  return async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", cookie, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

async function registered(email, shopName = "Shop " + email) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName, name: "Owner", phone: "9876543210", email, password: "secret12" });
  expect(r.status).toBe(201);
  return { c, shop: r.body.shop };
}

const bill = (over = {}) => ({
  clientId: crypto.randomUUID(),
  billNo: "A-1",
  deviceCode: "A",
  createdAt: new Date().toISOString(),
  items: [
    { name: "Samosa", qty: 2, rate: 20, category: "Snacks" },
    { name: "Dal Tadka", variant: "Half", qty: 1, rate: 30, category: "Dal Special" },
  ],
  discount: { type: "percent", value: 10 },
  gstPercent: 5,
  paymentMode: "cash",
  ...over,
});

describe("auth and shops", () => {
  it("register seeds the GrillHive menu and starts a 7-day trial", async () => {
    const { c, shop } = await registered("a@shop.test");
    expect(shop.status.state).toBe("trial");
    expect(shop.status.daysLeft).toBe(7);
    const menu = (await c("GET", "/menu")).body;
    expect(menu.length).toBe(80);
    expect(new Set(menu.map((m) => m.category)).size).toBe(12);
    expect(menu.find((m) => m.name === "Paneer Butter Masala").variants).toEqual([
      { label: "Half", price: 150 },
      { label: "Full", price: 270 },
    ]);
  });

  it("rejects duplicate emails and wrong passwords", async () => {
    await registered("dup@shop.test");
    const c = client();
    expect((await c("POST", "/auth/register", { shopName: "X Shop", name: "Owner", phone: "9876543210", email: "dup@shop.test", password: "secret12" })).status).toBe(409);
    expect((await c("POST", "/auth/login", { email: "dup@shop.test", password: "nope" })).status).toBe(401);
    expect((await c("POST", "/auth/login", { email: "DUP@shop.test", password: "secret12" })).status).toBe(200);
  });

  it("requires login", async () => {
    expect((await client()("GET", "/menu")).status).toBe(401);
  });

  it("never lets one shop read or change another shop's data", async () => {
    const a = await registered("iso-a@shop.test");
    const b = await registered("iso-b@shop.test");
    await a.c("POST", "/bills", { bills: [bill()] });
    const exp = (await a.c("POST", "/expenses", { date: "2026-01-05", category: "Gas", amount: 500 })).body;
    const aItem = (await a.c("GET", "/menu")).body[0];

    expect((await b.c("GET", "/bills")).body.bills).toHaveLength(0);
    expect((await b.c("GET", "/expenses")).body.expenses).toHaveLength(0);
    expect((await b.c("PUT", `/menu/${aItem.id}`, { name: "Hacked" })).status).toBe(404);
    expect((await b.c("DELETE", `/expenses/${exp.id}`)).status).toBe(404);
    expect((await b.c("GET", "/admin/shops")).status).toBe(403);
  });

  it("saves shop settings including paper size", async () => {
    const { c } = await registered("settings@shop.test");
    const r = await c("PUT", "/shop", { name: "New Name", gstPercent: 5, printer: { paperSize: 80, charsPerLine: 48 } });
    expect(r.status).toBe(200);
    expect(r.body.printer).toMatchObject({ paperSize: 80, charsPerLine: 48, method: "bluetooth" });
    expect((await c("PUT", "/shop", { printer: { paperSize: 75 } })).status).toBe(400);
    expect((await c("GET", "/auth/me")).body.shop.name).toBe("New Name");
  });
});

describe("bills", () => {
  it("stores server-computed totals that match the shared totals code", async () => {
    const { c } = await registered("bills@shop.test");
    const b = bill();
    const r = await c("POST", "/bills", { bills: [{ ...b, total: 1, subtotal: 1 }] }); // client totals are ignored
    expect(r.body.results[0].ok).toBe(true);
    const saved = (await c("GET", "/bills")).body.bills[0];
    const t = computeTotals(b.items, b.discount, b.gstPercent);
    expect(saved.total).toBe(t.total);
    expect(saved.total).toBe(66.15);
    expect(saved.gst.amount).toBe(3.15);
  });

  it("saves a bill once even when the offline queue sends it twice", async () => {
    const { c } = await registered("dupbill@shop.test");
    const b = bill();
    await c("POST", "/bills", { bills: [b] });
    const again = await c("POST", "/bills", { bills: [b, b] });
    expect(again.body.results.every((x) => x.ok)).toBe(true);
    expect((await c("GET", "/bills")).body.bills).toHaveLength(1);
  });

  it("voids a bill and leaves it out of sales", async () => {
    const { c } = await registered("void@shop.test");
    await c("POST", "/bills", { bills: [bill(), bill({ billNo: "A-2" })] });
    const [first] = (await c("GET", "/bills")).body.bills;
    expect((await c("POST", `/bills/${first.id}/void`, { reason: "wrong order" })).status).toBe(200);
    expect((await c("GET", "/analytics")).body.totals.bills).toBe(1);
  });
});

describe("analytics", () => {
  it("sums sales, expenses, profit and growth for a seeded week", async () => {
    const { c } = await registered("week@shop.test");
    // 10:30 IST on 3, 4 and 5 Jan 2026, plus one bill in the previous week.
    const at = (d) => new Date(`2026-01-0${d}T10:30:00+05:30`).toISOString();
    const items = [{ name: "Tea", qty: 10, rate: 15, category: "Tea & Beverages" }]; // 150
    await c("POST", "/bills", {
      bills: [3, 4, 5].map((d, i) => bill({ billNo: `A-${i}`, createdAt: at(d), items, discount: { type: "flat", value: 0 }, gstPercent: 0 })),
    });
    await c("POST", "/bills", {
      bills: [bill({ createdAt: new Date("2025-12-28T12:00:00+05:30").toISOString(), items, discount: { type: "flat", value: 0 }, gstPercent: 0 })],
    });
    await c("POST", "/expenses", { date: "2026-01-04", category: "Gas", amount: 100 });

    const a = (await c("GET", "/analytics?from=2026-01-01&to=2026-01-07")).body;
    expect(a.totals).toMatchObject({ sales: 450, bills: 3, expenses: 100, profit: 350, avgBill: 150 });
    expect(a.previous.sales).toBe(150);
    expect(a.growth.sales).toBe(200);
    expect(a.days).toHaveLength(7);
    expect(a.days.find((d) => d.date === "2026-01-04")).toMatchObject({ sales: 150, expenses: 100, profit: 50 });
    expect(a.hours[10].sales).toBe(450); // grouped in IST
    expect(a.topItems[0]).toMatchObject({ name: "Tea", qty: 30, revenue: 450 });
  });
});

describe("subscriptions", () => {
  it("blocks new bills after the trial ends but accepts older offline bills", async () => {
    const { c, shop } = await registered("expired@shop.test");
    const db = await getDb();
    const { ObjectId } = await import("mongodb");
    const ended = new Date(Date.now() - 2 * 864e5);
    await db.collection("shops").updateOne({ _id: new ObjectId(shop.id) }, { $set: { trialEndsAt: ended } });

    const r = await c("POST", "/bills", {
      bills: [bill(), bill({ createdAt: new Date(ended.getTime() - 3600e3).toISOString() })],
    });
    expect(r.body.results[0]).toMatchObject({ ok: false, code: 402 });
    expect(r.body.results[1].ok).toBe(true);
    expect((await c("GET", "/auth/me")).body.shop.status.state).toBe("expired");
  });

  it("approves a manual UPI payment and extends the plan on top of the trial", async () => {
    const { c, shop } = await registered("upi@shop.test");
    const admin = (await registered("admin@shop.test")).c;
    const p = (await c("POST", "/pay/upi", { plan: "monthly", utr: "412345678901" })).body;
    expect(p.status).toBe("pending");
    expect((await c("POST", "/pay/upi", { plan: "monthly", utr: "412345678901" })).status).toBe(409);

    expect((await admin("POST", `/admin/payments/${p.id}/approve`)).status).toBe(200);
    expect((await admin("POST", `/admin/payments/${p.id}/approve`)).status).toBe(404); // only once
    const s = (await c("GET", "/auth/me")).body.shop.status;
    expect(s.state).toBe("paid");
    expect(s.daysLeft).toBe(37); // 7 trial days + 30
    expect((await admin("GET", "/admin/shops")).body.shops.some((x) => x.id === shop.id)).toBe(true);
  });

  it("verifies Razorpay signatures and rejects tampered ones", async () => {
    const { razorpaySignatureOk, webhookSignatureOk } = await import("../server/routes/pay.js");
    const sig = crypto.createHmac("sha256", "rzp_secret").update("order_1|pay_1").digest("hex");
    expect(razorpaySignatureOk("order_1", "pay_1", sig, "rzp_secret")).toBe(true);
    expect(razorpaySignatureOk("order_1", "pay_2", sig, "rzp_secret")).toBe(false);
    expect(razorpaySignatureOk("order_1", "pay_1", "00", "rzp_secret")).toBe(false);

    const raw = JSON.stringify({ event: "payment.captured" });
    const wsig = crypto.createHmac("sha256", "wh_secret").update(raw).digest("hex");
    expect(webhookSignatureOk(raw, wsig, "wh_secret")).toBe(true);
    expect(webhookSignatureOk(raw + " ", wsig, "wh_secret")).toBe(false);
  });

  it("extends the plan once when /verify and the webhook both arrive", async () => {
    const { c, shop } = await registered("rzp@shop.test");
    const db = await getDb();
    const { ObjectId } = await import("mongodb");
    // Stand-in for the order Razorpay would have created.
    await db.collection("payments").insertOne({
      shopId: new ObjectId(shop.id), plan: "yearly", amount: 400, method: "razorpay", razorpayOrderId: "order_T1", status: "created", createdAt: new Date(),
    });
    const signature = crypto.createHmac("sha256", "rzp_secret").update("order_T1|pay_T1").digest("hex");
    const v = await c("POST", "/pay/razorpay/verify", { razorpay_order_id: "order_T1", razorpay_payment_id: "pay_T1", razorpay_signature: signature });
    expect(v.status).toBe(200);

    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_T1", order_id: "order_T1" } } } });
    const wsig = crypto.createHmac("sha256", "wh_secret").update(raw).digest("hex");
    expect((await client()("POST", "/pay/razorpay/webhook", raw, { "x-razorpay-signature": wsig })).status).toBe(200);
    expect((await client()("POST", "/pay/razorpay/webhook", raw, { "x-razorpay-signature": "bad" })).status).toBe(400);

    const s = (await c("GET", "/auth/me")).body.shop.status;
    expect(s.daysLeft).toBe(7 + 365);
    const bad = await c("POST", "/pay/razorpay/verify", { razorpay_order_id: "order_T1", razorpay_payment_id: "pay_X", razorpay_signature: signature });
    expect(bad.status).toBe(400);
  });
});
