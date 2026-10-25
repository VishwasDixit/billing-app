// Promo codes: Settings list (owner), checks at Billing (staff), QR orders (customers), and 1000 tables.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "promos-test";
  process.env.JWT_SECRET = "promos-test-secret-promos-test-secret";
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

let ipN = 0;
function client(ip = `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

async function shop(email, extra = {}) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Promo Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne(
    { _id: new ObjectId(r.body.shop.id) },
    { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
  );
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }], qrOrdering: true, upiId: "dhaba@okaxis", qrPayment: "choose", ...extra });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  const menu = (await c("GET", "/menu")).body;
  const tea = menu.find((m) => m.name === "Tea"); // ₹15
  const order = (body) => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone: "9876500001", items: [{ itemId: tea.id, qty: 20 }], ...body });
  return { c, token, tea, order };
}

const promo = (p) => ({ description: "", type: "percent", value: 10, ...p });

describe("promo codes in Settings", () => {
  it("owner creates, lists, edits and deletes codes; codes are unique and not case-sensitive", async () => {
    const { c } = await shop("crud@promo.test");
    const r = await c("POST", "/promos", promo({ code: "welcome10", description: "10% off", maxDiscount: 50 }));
    expect(r.status).toBe(200);
    expect(r.body.promo).toMatchObject({ code: "WELCOME10", type: "percent", value: 10, maxDiscount: 50, active: true, uses: 0 });
    expect((await c("POST", "/promos", promo({ code: "Welcome10" }))).status).toBe(409);
    expect((await c("POST", "/promos", promo({ code: "x!" }))).status).toBe(400);
    expect((await c("POST", "/promos", promo({ code: "BIG", value: 150 }))).status).toBe(400); // over 100%
    const id = r.body.promo.id;
    expect((await c("PUT", `/promos/${id}`, promo({ code: "WELCOME10", value: 15, active: false }))).body.promo).toMatchObject({ value: 15, active: false });
    expect((await c("GET", "/promos")).body.promos).toHaveLength(1);
    expect((await c("DELETE", `/promos/${id}`)).status).toBe(200);
    expect((await c("GET", "/promos")).body.promos).toHaveLength(0);
  });

  it("managers can check codes but not see or change the list; another shop's codes don't work", async () => {
    const { c } = await shop("roles@promo.test");
    await c("POST", "/promos", promo({ code: "STAFF10" }));
    const mgr = (await c("POST", "/staff", { name: "Sita", role: "manager", pin: "2222", wage: 1 })).body;
    const code = (await c("GET", "/staff/code")).body.code;
    const m = client();
    await m("POST", "/auth/staff-login", { code, staffId: mgr.id, pin: "2222" });
    expect((await m("GET", "/promos")).status).toBe(403);
    expect((await m("POST", "/promos", promo({ code: "HACK" }))).status).toBe(403);
    expect((await m("POST", "/promos/check", { code: "staff10", subtotal: 200 })).body).toMatchObject({ code: "STAFF10", amount: 20 });

    const other = await shop("other@promo.test");
    expect((await other.c("POST", "/promos/check", { code: "STAFF10", subtotal: 200 })).status).toBe(404);
  });
});

describe("checking a code", () => {
  it("applies caps, minimum order, dates, pause and where it works", async () => {
    const { c } = await shop("rules@promo.test");
    const check = async (code, subtotal = 300) => (await c("POST", "/promos/check", { code, subtotal })).body;
    await c("POST", "/promos", promo({ code: "CAP", value: 50, maxDiscount: 100 }));
    await c("POST", "/promos", promo({ code: "FLAT", type: "flat", value: 80, minOrder: 400 }));
    await c("POST", "/promos", promo({ code: "OLD", validTo: "2020-01-01" }));
    await c("POST", "/promos", promo({ code: "SOON", validFrom: "2099-01-01" }));
    await c("POST", "/promos", promo({ code: "PAUSED", active: false }));
    await c("POST", "/promos", promo({ code: "QRONLY", where: "qr" }));
    expect(await check("CAP")).toMatchObject({ amount: 100 });
    expect((await check("FLAT")).error).toMatch(/₹400 or more/);
    expect(await check("FLAT", 500)).toMatchObject({ amount: 80 });
    expect((await check("OLD")).error).toMatch(/expired/);
    expect((await check("SOON")).error).toMatch(/starts/i);
    expect((await check("PAUSED")).error).toMatch(/paused/i);
    expect((await check("QRONLY")).error).toMatch(/table QR/);
    expect((await check("NOPE")).error).toMatch(/isn't a valid code/);
  });
});

describe("customers using a code with a QR order", () => {
  it("previews, then the order, payment and P-bill carry the discount (prices from the server)", async () => {
    const { c, token, tea, order } = await shop("qr@promo.test", { gstPercent: 5 });
    await c("POST", "/promos", promo({ code: "TEA20", value: 20, showOnMenu: true, description: "20% off tea" }));
    const pub = (await client()("GET", `/public/shop/${token}`)).body;
    expect(pub.offers).toEqual([expect.objectContaining({ code: "TEA20", description: "20% off tea" })]);

    const pre = await client()("POST", `/public/shop/${token}/promo`, { code: "tea20", phone: "9876500001", items: [{ itemId: tea.id, qty: 20 }] });
    expect(pre.body).toMatchObject({ code: "TEA20", amount: 60 }); // 20% of 300

    const o = (await order({ promo: "TEA20" })).body;
    expect(o.promo).toMatchObject({ code: "TEA20", amount: 60 });
    expect(o.pay.amount).toBe(252); // (300 − 60) + 5% GST
    const p = client();
    await p("POST", `/public/shop/${token}/orders/${o.orderId}/pay`, { key: o.key, method: "upi" });
    const conf = (await c("POST", `/orders/${o.orderId}/payment`, { action: "confirm" })).body;
    expect(conf.bill).toMatchObject({ total: 252, discount: { amount: 60 }, promo: { code: "TEA20" } });
    const list = (await c("GET", "/promos")).body.promos;
    expect(list[0]).toMatchObject({ uses: 1, discountGiven: 60 });
  });

  it("refuses a bad code instead of placing the order without it", async () => {
    const { c, order } = await shop("bad@promo.test");
    await c("POST", "/promos", promo({ code: "MIN1K", minOrder: 1000 }));
    const r = await order({ promo: "MIN1K" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/₹1,000 or more/);
    expect((await c("GET", "/orders")).body.orders).toHaveLength(0);
  });

  it("once per mobile, and a rejected order frees the use", async () => {
    const { c, order } = await shop("phone@promo.test");
    await c("POST", "/promos", promo({ code: "ONCE", onePerPhone: true }));
    const first = (await order({ promo: "ONCE" })).body;
    expect(first.promo.code).toBe("ONCE");
    expect((await order({ promo: "ONCE", phone: "+91 98765 00001" })).body.error).toMatch(/already used on this mobile/i);
    expect((await order({ promo: "ONCE", phone: "9876500002" })).status).toBe(200);
    await c("POST", `/orders/${first.orderId}/status`, { status: "rejected", reason: "closed" });
    expect((await order({ promo: "ONCE" })).status).toBe(200);
    expect((await c("GET", "/promos")).body.promos[0].uses).toBe(2);
  });

  it("a total-use limit holds when many customers order at once", async () => {
    const { c, order } = await shop("limit@promo.test");
    await c("POST", "/promos", promo({ code: "FIRST3", maxUses: 3 }));
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) => order({ promo: "FIRST3", phone: `98765100${String(i).padStart(2, "0")}`, table: i % 2 ? "T1" : "T2" })));
    expect(r.filter((x) => x.status === 200)).toHaveLength(3);
    expect(r.filter((x) => x.status === 400).every((x) => /fully used/.test(x.body.error))).toBe(true);
    expect((await c("GET", "/promos")).body.promos[0].uses).toBe(3);
  });
});

describe("staff applying a code on a bill", () => {
  it("counts the use once even when the upload is sent again", async () => {
    const { c, tea } = await shop("bill@promo.test");
    await c("POST", "/promos", promo({ code: "COUNTER", type: "flat", value: 25 }));
    const bill = {
      clientId: crypto.randomUUID(),
      billNo: "C-1",
      createdAt: new Date().toISOString(),
      paymentMode: "cash",
      discount: { type: "flat", value: 25 },
      promo: { code: "COUNTER", source: "billing" },
      items: [{ itemId: tea.id, name: "Tea", qty: 10, rate: 15 }],
    };
    await c("POST", "/bills", { bills: [bill] });
    await c("POST", "/bills", { bills: [bill] });
    const saved = (await c("GET", "/bills")).body.bills[0];
    expect(saved).toMatchObject({ total: 125, promo: { code: "COUNTER" } });
    expect((await c("GET", "/promos")).body.promos[0]).toMatchObject({ uses: 1, discountGiven: 25 });
  });
});

describe("many tables", () => {
  it("saves 1000 tables and refuses 1001", async () => {
    const { c } = await shop("tables@promo.test");
    const tables = (n) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, name: `Table ${i + 1}` }));
    expect((await c("PUT", "/shop", { tables: tables(1000) })).status).toBe(200);
    expect((await c("GET", "/shop")).body.tables).toHaveLength(1000);
    expect((await c("PUT", "/shop", { tables: tables(1001) })).status).toBe(400);
  });
});

describe("codes for some tables only", () => {
  it("works at the chosen tables, not at others or at the counter", async () => {
    const { c, token, tea, order } = await shop("tables-promo@promo.test");
    await c("POST", "/promos", promo({ code: "WELCOME100", type: "flat", value: 100 }));
    await c("POST", "/promos", promo({ code: "WELCOME50", type: "flat", value: 50, tables: ["T1"], showOnMenu: true }));
    expect((await c("GET", "/promos")).body.promos.find((p) => p.code === "WELCOME50").tables).toEqual(["T1"]);
    // Customer page gets the tables, so it only shows the offer at those tables.
    expect((await client()("GET", `/public/shop/${token}`)).body.offers[0].tables).toEqual(["T1"]);

    expect((await order({ promo: "WELCOME50", table: "T1" })).body.promo).toMatchObject({ code: "WELCOME50", amount: 50 });
    const t2 = await order({ promo: "WELCOME50", table: "T2", phone: "9876500009" });
    expect(t2.status).toBe(400);
    expect(t2.body.error).toMatch(/Table 1/);
    expect((await order({ promo: "WELCOME100", table: "T2", phone: "9876500008" })).body.promo.amount).toBe(100);
    expect((await client()("POST", `/public/shop/${token}/promo`, { code: "WELCOME50", table: "T2", items: [{ itemId: tea.id, qty: 20 }] })).status).toBe(400);

    // Staff: fine on Table 1's bill, not on a counter bill.
    expect((await c("POST", "/promos/check", { code: "WELCOME50", subtotal: 300, table: "T1" })).body.amount).toBe(50);
    expect((await c("POST", "/promos/check", { code: "WELCOME50", subtotal: 300 })).body.error).toMatch(/Table 1/);
    // Tables that don't exist are refused when saving.
    expect((await c("POST", "/promos", promo({ code: "GHOST", tables: ["T99"] }))).status).toBe(400);
  });
});

describe("opening hours for QR orders", () => {
  const hm = (minsFromNow) => new Date(Date.now() + 5.5 * 3600e3 + minsFromNow * 60e3).toISOString().slice(11, 16);
  it("takes orders only while open, with a friendly message otherwise", async () => {
    const { c, token, order } = await shop("hours@promo.test");
    await c("PUT", "/shop", { hours: { enabled: true, open: hm(120), close: hm(240), closedDays: [], message: "" } });
    const pub = (await client()("GET", `/public/shop/${token}`)).body;
    expect(pub.ordering).toMatchObject({ open: false, closedForHours: true });
    expect(pub.ordering.reason).toMatch(/closed right now/i);
    expect(pub.ordering.reason).toMatch(/open/i);
    expect((await order({})).status).toBe(403);

    // Open now (a window around the current time), with the shop's own message kept for later.
    await c("PUT", "/shop", { hours: { enabled: true, open: hm(-60), close: hm(60), closedDays: [], message: "Kitchen's resting! Back at {open} 🍲" } });
    expect((await client()("GET", `/public/shop/${token}`)).body.ordering).toMatchObject({ open: true });
    expect((await order({})).status).toBe(200);

    // Closed today (weekly off), with the custom message.
    const today = new Date(Date.now() + 5.5 * 3600e3).getUTCDay();
    await c("PUT", "/shop", { hours: { enabled: true, open: hm(-60), close: hm(60), closedDays: [today, (today + 6) % 7], message: "Kitchen's resting! Back at {open} 🍲" } }); // (the window may start yesterday near midnight)
    const off = (await client()("GET", `/public/shop/${token}`)).body.ordering;
    expect(off.open).toBe(false);
    expect(off.reason).toMatch(/^Kitchen's resting! Back at /);
    expect(off.reason).not.toMatch(/\{open\}/);
  });
});

describe("closing the shop for a day", () => {
  it("closes QR ordering today, for some days, or until reopened, with a message", async () => {
    const { c, token, order } = await shop("closed@promo.test");
    const ordering = async () => (await client()("GET", `/public/shop/${token}`)).body.ordering;
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

    const r = await c("PUT", "/shop/closure", { until: "today", message: "" });
    expect(r.body.closure).toMatchObject({ until: today });
    expect(await ordering()).toMatchObject({ open: false, closedForHours: true });
    expect((await ordering()).reason).toMatch(/closed today/i);
    expect((await order({})).status).toBe(403);

    await c("PUT", "/shop/closure", { until: "2099-01-05", message: "Diwali holidays 🪔 Back on {open}!" });
    expect((await ordering()).reason).toBe("Diwali holidays 🪔 Back on 6 Jan!");

    await c("PUT", "/shop/closure", { until: "manual", message: "" });
    expect((await ordering()).reason).toMatch(/closed right now/i);

    // Managers can open it again; dates in the past are refused.
    const mgr = (await c("POST", "/staff", { name: "Sita", role: "manager", pin: "2222", wage: 1 })).body;
    const code = (await c("GET", "/staff/code")).body.code;
    const m = client();
    await m("POST", "/auth/staff-login", { code, staffId: mgr.id, pin: "2222" });
    expect((await m("PUT", "/shop/closure", { until: null })).body.closure).toBeNull();
    expect((await ordering()).open).toBe(true);
    expect((await c("PUT", "/shop/closure", { until: "2020-01-01" })).status).toBe(400);
  });
});
