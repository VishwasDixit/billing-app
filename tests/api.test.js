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

  it("reports setup status on /health without revealing values", async () => {
    const r = await client()("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, database: "connected", JWT_SECRET: true, MONGODB_URI: true, ADMIN_EMAIL: true });
    expect(JSON.stringify(r.body)).not.toContain("test-secret");
  });

  it("explains a missing JWT_SECRET and creates nothing", async () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "short";
    try {
      const c = client();
      const r = await c("POST", "/auth/register", { shopName: "No Secret", name: "Owner", phone: "9876543210", email: "nosecret@shop.test", password: "secret12" });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/JWT_SECRET/);
      expect((await client()("GET", "/health")).body.JWT_SECRET).toBe(false);
    } finally {
      process.env.JWT_SECRET = saved;
    }
    // The email is still free once the secret is fixed.
    await registered("nosecret@shop.test");
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

describe("menu pictures", () => {
  // Smallest valid PNG (1x1 transparent pixel).
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  it("gives every seeded item a default picture that exists", async () => {
    const fs = await import("node:fs");
    const { c } = await registered("pics@shop.test");
    const menu = (await c("GET", "/menu")).body;
    for (const m of menu) {
      expect(m.image).toMatch(/^\/menu\/[a-z]+\.svg$/);
      expect(fs.existsSync(new URL(`../public${m.image}`, import.meta.url))).toBe(true);
    }
    expect(menu.filter((m) => m.image === "/menu/plate.svg")).toHaveLength(0);
    const added = (await c("POST", "/menu", { name: "Masala Dosa", category: "South Indian", variants: [{ label: "", price: 80 }] })).body;
    expect(added.image).toMatch(/^\/menu\/.+\.svg$/);
  });

  it("uploads, serves, replaces and removes a photo", async () => {
    const { c } = await registered("photo@shop.test");
    const item = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");

    const up = await c("PUT", `/menu/${item.id}/image`, { dataUrl: PNG });
    expect(up.status).toBe(200);
    expect(up.body.image).toMatch(/^\/api\/menu-images\/[a-f0-9]{24}$/);

    const r = await fetch(base.replace(/\/api$/, "") + up.body.image);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toMatch(/immutable/);
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(PNG.split(",")[1], "base64"))).toBe(true);

    // Replacing deletes the old photo.
    const again = await c("PUT", `/menu/${item.id}/image`, { dataUrl: PNG });
    expect((await fetch(base.replace(/\/api$/, "") + up.body.image)).status).toBe(404);

    const removed = await c("DELETE", `/menu/${item.id}/image`);
    expect(removed.body.image).toBe("/menu/tea.svg");
    expect((await fetch(base.replace(/\/api$/, "") + again.body.image)).status).toBe(404);
  });

  it("rejects bad or oversized photos and other shops", async () => {
    const a = await registered("photo-a@shop.test");
    const b = await registered("photo-b@shop.test");
    const item = (await a.c("GET", "/menu")).body[0];
    expect((await a.c("PUT", `/menu/${item.id}/image`, { dataUrl: "data:image/png;base64," + Buffer.from("not an image").toString("base64") })).status).toBe(400);
    expect((await a.c("PUT", `/menu/${item.id}/image`, { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" })).status).toBe(400);
    const big = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100 * 1024)]).toString("base64");
    expect((await a.c("PUT", `/menu/${item.id}/image`, { dataUrl: big })).status).toBe(400);
    expect((await b.c("PUT", `/menu/${item.id}/image`, { dataUrl: PNG })).status).toBe(404);
    expect((await b.c("DELETE", `/menu/${item.id}/image`)).status).toBe(404);
    expect((await a.c("PUT", `/menu/${item.id}`, { image: "https://evil.example/x.png" })).status).toBe(400);
  });

  it("adds default pictures only to items that have none", async () => {
    const { c, shop } = await registered("legacy-pics@shop.test");
    const db = await getDb();
    const { ObjectId } = await import("mongodb");
    const sid = new ObjectId(shop.id);
    // Simulate a menu created before pictures existed, plus one custom photo.
    await db.collection("menuItems").updateMany({ shopId: sid }, { $unset: { image: "" } });
    const tea = await db.collection("menuItems").findOne({ shopId: sid, name: "Tea" });
    await c("PUT", `/menu/${tea._id}/image`, { dataUrl: PNG });

    const r = await c("POST", "/menu/default-images");
    expect(r.body.updated).toBe(79);
    expect(r.body.menu.find((m) => m.name === "Dal Tadka").image).toBe("/menu/dal.svg");
    expect(r.body.menu.find((m) => m.name === "Tea").image).toMatch(/^\/api\/menu-images\//);
  });
});

describe("payment link", () => {
  // Fake Razorpay API: payments keyed by ID. Other requests (our own server) pass through.
  const realFetch = globalThis.fetch;
  let payments = {};
  let captured = [];
  let offline = false;
  beforeAll(() => {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.startsWith("https://api.razorpay.com/")) return realFetch(url, init);
      if (offline) throw new TypeError("fetch failed");
      const m = /\/payments\/([^/]+)(\/capture)?$/.exec(u);
      const p = m && payments[decodeURIComponent(m[1])];
      if (!p) return new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }), { status: 400 });
      if (m[2]) {
        captured.push(p.id);
        p.status = "captured";
      }
      return new Response(JSON.stringify(p), { status: 200 });
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  const pay = (id, amount, status = "captured", ageDays = 0) =>
    (payments[id] = { id, amount, currency: "INR", status, created_at: Math.floor((Date.now() - ageDays * 864e5) / 1000) });

  it("approves a real ₹49 payment immediately and extends the plan", async () => {
    const { c } = await registered("auto-ok@shop.test");
    pay("pay_AutoOk49xxxxxx", 4900);
    const r = await c("POST", "/pay/upi", { plan: "monthly", via: "link", utr: "pay_AutoOk49xxxxxx" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ autoApproved: true, status: "approved", approvedBy: "razorpay-auto" });
    expect((await c("GET", "/auth/me")).body.shop.status).toMatchObject({ state: "paid", daysLeft: 37 });
    // The same payment can't buy a second plan, even from another shop.
    const other = await registered("auto-other@shop.test");
    expect((await other.c("POST", "/pay/upi", { plan: "monthly", via: "link", utr: "pay_AutoOk49xxxxxx" })).status).toBe(409);
  });

  it("captures an authorized payment before approving", async () => {
    const { c } = await registered("auto-auth@shop.test");
    pay("pay_AutoAuth4000xx", 40000, "authorized");
    const r = await c("POST", "/pay/upi", { plan: "yearly", via: "link", utr: "pay_AutoAuth4000xx" });
    expect(r.body.autoApproved).toBe(true);
    expect(captured).toContain("pay_AutoAuth4000xx");
  });

  it("rejects wrong amounts, failed, unknown and old payments with a reason", async () => {
    const { c } = await registered("auto-bad@shop.test");
    pay("pay_TooSmall4000x", 4000);
    pay("pay_Failed490000x", 4900, "failed");
    pay("pay_TooOld4900xxx", 4900, "captured", 30);
    const sub = (utr, plan = "monthly") => c("POST", "/pay/upi", { plan, via: "link", utr });
    expect((await sub("pay_TooSmall4000x")).body.error).toMatch(/₹40.*₹49/);
    expect((await sub("pay_AutoOk49xxxxxx".replace("Ok", "No"))).body.error).toMatch(/no payment/i);
    expect((await sub("pay_Failed490000x")).body.error).toMatch(/failed/);
    expect((await sub("pay_TooOld4900xxx")).body.error).toMatch(/too old/);
    expect((await sub("pay_TooSmall4000x")).status).toBe(400);
    pay("pay_Monthly4900xx", 4900);
    expect((await sub("pay_Monthly4900xx", "yearly")).body.error).toMatch(/₹49.*₹400/);
    expect((await c("GET", "/pay/history")).body.payments).toHaveLength(0);
  });

  it("keeps the payment pending when Razorpay can't be reached, then approves it later", async () => {
    const { c } = await registered("auto-later@shop.test");
    const admin = client();
    await admin("POST", "/auth/login", { email: "admin@shop.test", password: "secret12" });
    offline = true;
    pay("pay_LaterPaid4900x", 4900);
    const r = await c("POST", "/pay/upi", { plan: "monthly", via: "link", utr: "pay_LaterPaid4900x" });
    expect(r.body).toMatchObject({ status: "pending" });
    expect(r.body.autoApproved).toBeUndefined();
    offline = false;
    // Opening the Plans page re-checks it with Razorpay.
    const h = await c("GET", "/pay/history");
    expect(h.body.approved).toBe(1);
    expect(h.body.payments[0].status).toBe("approved");
    expect((await admin("POST", "/admin/payments/recheck", {})).body.approved).toBe(0);
  });

  it("still waits for the admin when no Razorpay keys are set", async () => {
    const { c } = await registered("no-keys@shop.test");
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      expect((await c("POST", "/pay/upi", { plan: "monthly", via: "link", utr: "412345678901" })).status).toBe(400);
      const p = await c("POST", "/pay/upi", { plan: "yearly", via: "link", utr: "pay_N3abc12XYZdef" });
      expect(p.body).toMatchObject({ method: "link", status: "pending", amount: 400 });
      expect((await c("POST", "/pay/upi", { plan: "yearly", via: "link", utr: "pay_N3abc12XYZdef" })).status).toBe(409);
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });
});

describe("udhar (credit) accounts", () => {
  const cust = (name = "Ramesh Kumar", phone = "9876501234") => ({ clientId: crypto.randomUUID(), name, phone });
  const creditBill = (customer, rate, paidNow = 0, over = {}) =>
    bill({ paymentMode: "credit", customer, paidNow, items: [{ name: "Thali", qty: 1, rate }], discount: { type: "flat", value: 0 }, gstPercent: 0, ...over });
  const customerByName = async (c, name) => (await c("GET", "/customers")).body.customers.find((x) => x.name === name);

  it("needs a customer for an udhar bill and creates it once", async () => {
    const { c } = await registered("udhar-create@shop.test");
    const r1 = await c("POST", "/bills", { bills: [bill({ paymentMode: "credit" })] });
    expect(r1.body.results[0]).toMatchObject({ ok: false, code: 400 });

    const ramesh = cust();
    const b = creditBill(ramesh, 500, 200);
    await c("POST", "/bills", { bills: [b] });
    await c("POST", "/bills", { bills: [b] }); // offline queue resend
    const list = (await c("GET", "/customers")).body;
    expect(list.customers).toHaveLength(1);
    expect(list.customers[0]).toMatchObject({ name: "Ramesh Kumar", phone: "9876501234", due: 300, settled: false });
    expect(list).toMatchObject({ totalDue: 300, owingCount: 1 });
  });

  it("tracks dues through payments, voids and deleted payments", async () => {
    const { c } = await registered("udhar-due@shop.test");
    const ramesh = cust();
    await c("POST", "/bills", { bills: [creditBill(ramesh, 500, 200)] });
    const r = await customerByName(c, "Ramesh Kumar");
    const pay = await c("POST", `/customers/${r.id}/payments`, { amount: 100, mode: "upi" });
    expect(pay.body.due).toBe(200);

    const billId = (await c("GET", "/bills?mode=credit")).body.bills[0].id;
    await c("POST", `/bills/${billId}/void`, { reason: "cancelled" });
    expect((await customerByName(c, "Ramesh Kumar")).due).toBe(-100); // advance

    const detail = (await c("GET", `/customers/${r.id}`)).body;
    const paymentId = detail.ledger.find((e) => e.type === "payment").id;
    expect((await c("DELETE", `/customers/${r.id}/payments/${paymentId}`)).body.due).toBe(0);
  });

  it("clears the oldest bills first and settles the account", async () => {
    const { c } = await registered("udhar-fifo@shop.test");
    const sita = cust("Sita Devi", "9876500000");
    const old = creditBill(sita, 300, 0, { createdAt: new Date(Date.now() - 86400e3).toISOString(), billNo: "A-1" });
    const recent = creditBill(sita, 200, 0, { billNo: "A-2" });
    await c("POST", "/bills", { bills: [old, recent] });
    const s = await customerByName(c, "Sita Devi");

    await c("POST", `/customers/${s.id}/payments`, { amount: 350 });
    let bills = (await c("GET", "/bills?mode=credit")).body.bills;
    expect(bills.find((b) => b.billNo === "A-1").udhar).toEqual({ left: 0, state: "cleared" });
    expect(bills.find((b) => b.billNo === "A-2").udhar).toEqual({ left: 150, state: "part" });

    const settled = await c("POST", `/customers/${s.id}/payments`, { amount: 150 });
    expect(settled.body).toMatchObject({ due: 0, settled: true });
    bills = (await c("GET", "/bills?mode=credit")).body.bills;
    expect(bills.every((b) => b.udhar.state === "cleared")).toBe(true);
    const list = (await c("GET", "/customers")).body;
    expect(list.owingCount).toBe(0);

    const ledger = (await c("GET", `/customers/${s.id}`)).body.ledger;
    expect(ledger[0].balance).toBe(0); // newest first
    expect(ledger.map((e) => e.type)).toEqual(["payment", "payment", "bill", "bill"]);
  });

  it("keeps customers private to their shop and records reminders", async () => {
    const a = await registered("udhar-a@shop.test");
    const b = await registered("udhar-b@shop.test");
    await a.c("POST", "/bills", { bills: [creditBill(cust("Private Person"), 100)] });
    const p = await customerByName(a.c, "Private Person");
    expect((await b.c("GET", "/customers")).body.customers).toHaveLength(0);
    expect((await b.c("GET", `/customers/${p.id}`)).status).toBe(404);
    expect((await b.c("POST", `/customers/${p.id}/payments`, { amount: 100 })).status).toBe(404);
    expect((await b.c("POST", `/customers/${p.id}/reminded`)).status).toBe(404);

    expect((await a.c("POST", `/customers/${p.id}/reminded`)).status).toBe(200);
    expect((await customerByName(a.c, "Private Person")).lastRemindedAt).toBeTruthy();
    expect((await a.c("POST", "/customers", { clientId: crypto.randomUUID(), name: "Bad Phone", phone: "12" })).status).toBe(400);
  });

  it("reports udhar given, collected and outstanding on the dashboard", async () => {
    const { c } = await registered("udhar-dash@shop.test");
    await c("POST", "/bills", { bills: [creditBill(cust("Mohan"), 400, 100), creditBill(cust("Geeta"), 250)] });
    const m = await customerByName(c, "Mohan");
    await c("POST", `/customers/${m.id}/payments`, { amount: 50 });
    const a = (await c("GET", "/analytics")).body;
    expect(a.credit).toEqual({ given: 550, collected: 50, outstanding: 500 });
    expect(a.payments.find((p) => p.mode === "credit")).toMatchObject({ bills: 2, sales: 650 });
  });
});
