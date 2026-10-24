// Attack tests: each one tries to break the app the way an attacker would, and states how the app
// must respond. Written first (test-driven); a failing test here is a security hole to fix.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;
const SECRET = "security-test-secret-security-test";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "security-test";
  process.env.JWT_SECRET = SECRET;
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

function client(extra = {}) {
  let cookie = extra.cookie || "";
  const c = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie && { cookie }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, body: json, headers: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}

async function owner(email) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Shop " + email, name: "Owner", phone: "9876543210", email, password: "secret12" });
  expect(r.status).toBe(201);
  return { c, shopId: r.body.shop.id, userId: r.body.user.id };
}

describe("one shop can never touch another shop's data", () => {
  it("refuses every id from another shop", async () => {
    const a = await owner("a@sec.test");
    const b = await owner("b@sec.test");
    // Shop B creates things.
    const menu = (await b.c("GET", "/menu")).body;
    const clientId = crypto.randomUUID();
    await b.c("POST", "/bills", { bills: [{ clientId, billNo: "B-1", createdAt: new Date().toISOString(), items: [{ itemId: menu[0].id, name: menu[0].name, qty: 1, rate: 10 }] }] });
    const bill = (await b.c("GET", "/bills")).body.bills[0];
    const cust = (await b.c("POST", "/customers", { clientId: crypto.randomUUID(), name: "Secret Customer", phone: "9000000001" })).body;
    const exp = (await b.c("POST", "/expenses", { date: "2026-10-01", category: "Rent", amount: 5000 })).body;
    const staff = (await b.c("POST", "/staff", { name: "Worker B", role: "cook", pin: "1234", wage: 9000 })).body;
    const adv = (await b.c("POST", `/staff/${staff.id}/advances`, { amount: 500, date: "2026-10-02" })).body;
    await b.c("POST", "/kitchen/ingredients/starter", { names: ["Onion"] });
    const ing = (await b.c("GET", "/kitchen/ingredients")).body.ingredients[0];

    // Shop A tries to read, change and delete them by id.
    const attempts = [
      ["PUT", `/bills/${bill.id}`, { items: [{ name: "x", qty: 1, rate: 1 }], discount: { type: "percent", value: 0 }, gstPercent: 0, paymentMode: "cash", reason: "items" }],
      ["POST", `/bills/${bill.id}/delete`, { reason: "test" }],
      ["POST", `/bills/${bill.id}/restore`, {}],
      ["POST", `/bills/${bill.clientId}/confirm-payment`, {}],
      ["GET", `/customers/${cust.id}`],
      ["PUT", `/customers/${cust.id}`, { name: "Hacked" }],
      ["POST", `/customers/${cust.id}/payments`, { amount: 10 }],
      ["PUT", `/expenses/${exp.id}`, { date: "2026-10-01", category: "Rent", amount: 1 }],
      ["DELETE", `/expenses/${exp.id}`],
      ["PUT", `/staff/${staff.id}`, { wage: 1 }],
      ["PUT", `/staff/advances/${adv.id}`, { amount: 1, date: "2026-10-02" }],
      ["DELETE", `/staff/advances/${adv.id}`],
      ["PUT", "/staff/attendance", { staffId: staff.id, date: "2026-10-03", status: "absent" }],
      ["GET", `/staff/${staff.id}/passbook`],
      ["PUT", `/kitchen/ingredients/${ing.id}`, { minStock: 99 }],
      ["DELETE", `/kitchen/ingredients/${ing.id}`],
      ["PUT", `/menu/${menu[0].id}`, { name: "Hacked" }],
      ["DELETE", `/menu/${menu[0].id}`],
    ];
    for (const [m, path, body] of attempts) {
      const r = await a.c(m, path, body);
      expect([400, 403, 404], `${m} ${path} → ${r.status}`).toContain(r.status);
    }
    // Nothing of B's changed.
    expect((await b.c("GET", "/bills")).body.bills[0]).toMatchObject({ status: "paid", total: 10 });
    expect((await b.c("GET", "/customers")).body.customers.find((x) => x.id === cust.id)?.name).toBe("Secret Customer");
    expect((await b.c("GET", "/menu")).body[0].name).toBe(menu[0].name);
    // And B's lists never show up for A.
    expect((await a.c("GET", "/bills")).body.bills).toHaveLength(0);
    expect((await a.c("GET", "/customers")).body.customers.some((x) => x.name === "Secret Customer")).toBe(false);
  });
});

describe("sessions and tokens can't be forged or swapped", () => {
  it("rejects tampered, unsigned, expired and wrong-secret tokens", async () => {
    const a = await owner("tok@sec.test");
    const forge = (payload, secret = SECRET, opts = {}) => jwt.sign(payload, secret, opts);
    const db = await getDb();
    const u = await db.collection("users").findOne({ email: "tok@sec.test" });
    const good = { uid: String(u._id), sid: String(u.shopId), sv: 0 };
    const tries = [
      forge(good, "wrong-secret-wrong-secret"),
      forge(good, SECRET, { expiresIn: -10 }),
      // alg:none token (no signature)
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify(good)).toString("base64url") + ".",
      // HS384 with the right secret: only HS256 is accepted
      forge(good, SECRET, { algorithm: "HS384" }),
      "garbage",
    ];
    for (const t of tries) expect((await client({ cookie: `bt=${t}` })("GET", "/auth/me")).status).toBe(401);
    expect((await a.c("GET", "/auth/me")).status).toBe(200);
  });

  it("a staff PIN token can't be used as a login, and a login can't be used as a staff PIN token", async () => {
    const a = await owner("swap@sec.test");
    const w = (await a.c("POST", "/staff", { name: "Cook", role: "cook", pin: "1234" })).body;
    // Kitchen phone: PIN check returns a short staff token.
    await a.c("POST", "/auth/kitchen-mode", { password: "secret12" });
    const pinTok = (await a.c("POST", "/staff/verify-pin", { staffId: w.id, pin: "1234" })).body.token;
    expect(pinTok).toBeTruthy();
    expect((await client({ cookie: `bt=${pinTok}` })("GET", "/auth/me")).status).toBe(401);

    // A worker's own-phone login cookie used as the shared-phone PIN token.
    const { code } = (await (await owner("swap2@sec.test")).c("GET", "/staff/code")).body; // another shop (unused)
    const o = await owner("swap3@sec.test");
    const cook = (await o.c("POST", "/staff", { name: "Cook2", role: "cook", pin: "4321" })).body;
    const code3 = (await o.c("GET", "/staff/code")).body.code;
    const s = client();
    await s("POST", "/auth/staff-login", { code: code3, staffId: cook.id, pin: "4321" });
    const staffCookie = s.cookie().split("=")[1];
    expect(code).toBeTruthy();
    // On the owner's own session, presenting it as x-staff-token must not identify "Cook2".
    const k = client();
    await k("POST", "/auth/login", { email: "swap3@sec.test", password: "secret12" });
    await k("POST", "/auth/kitchen-mode", { password: "secret12" });
    const onion = await k("POST", "/kitchen/ingredients/starter", { names: ["Onion"] });
    expect(onion.status).toBe(200);
    const ing = (await k("GET", "/kitchen/ingredients")).body.ingredients[0];
    const r = await k("POST", "/kitchen/moves", { moves: [{ clientId: crypto.randomUUID(), ingredientId: ing.id, type: "purchase", qty: 1, unit: "kg" }] }, { "x-staff-token": staffCookie });
    expect(r.status).toBe(401); // STAFF_PIN: not accepted as a PIN token
  });
});

describe("cross-site and malformed requests", () => {
  it("refuses state-changing requests that aren't JSON (blocks form-based CSRF)", async () => {
    const a = await owner("csrf@sec.test");
    const r = await a.c("POST", "/expenses", JSON.stringify({ date: "2026-10-01", category: "Rent", amount: 999 }), { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    const r2 = await a.c("POST", "/expenses", "date=2026-10-01&category=Rent&amount=999", { "content-type": "application/x-www-form-urlencoded" });
    expect(r2.status).toBe(415);
    expect((await a.c("GET", "/expenses")).body.expenses).toHaveLength(0);
  });

  it("refuses oversized bodies and huge arrays quickly", async () => {
    const a = await owner("big@sec.test");
    // Over 512 KB: refused before it's read.
    const r = await a.c("POST", "/bills", JSON.stringify({ bills: [], pad: "x".repeat(600 * 1024) }));
    expect(r.status).toBe(413);
    // Just under the limit but a huge array: rejected by validation, fast (no memory blow-up).
    const t = Date.now();
    const r2 = await a.c("POST", "/bills", JSON.stringify({ bills: Array.from({ length: 200000 }, () => 1) }));
    expect(r2.status).toBe(400);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("ignores operator injection in login and query strings", async () => {
    await owner("inj@sec.test");
    const r = await client()("POST", "/auth/login", { email: { $ne: "" }, password: { $ne: "" } });
    expect(r.status).toBe(400);
    const a = await owner("inj2@sec.test");
    const q = await a.c("GET", "/bills?status[$ne]=x&q=.*");
    expect(q.status).toBe(200);
  });
});

describe("brute force is limited", () => {
  it("locks login after repeated wrong passwords", async () => {
    await owner("brute@sec.test");
    const c = client();
    let last;
    for (let i = 0; i < 12; i++) last = await c("POST", "/auth/login", { email: "brute@sec.test", password: "wrong-" + i });
    expect(last.status).toBe(429);
    // Even the right password waits.
    expect((await c("POST", "/auth/login", { email: "brute@sec.test", password: "secret12" })).status).toBe(429);
  });

  it("doesn't say whether an email has an account", async () => {
    await owner("exists@sec.test");
    const known = await client()("POST", "/auth/login", { email: "exists@sec.test", password: "nope-nope" });
    const unknown = await client()("POST", "/auth/login", { email: "ghost@sec.test", password: "nope-nope" });
    expect(known.body.error).toBe(unknown.body.error);
  });

  it("new passwords must be at least 8 characters", async () => {
    const r = await client()("POST", "/auth/register", { shopName: "Weak", name: "Owner", phone: "9876543210", email: "weak@sec.test", password: "123456" });
    expect(r.status).toBe(400);
  });
});

describe("public QR pages can't be abused", () => {
  it("prices come from the menu, not the customer's phone", async () => {
    const a = await owner("price@sec.test");
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(a.shopId) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 9e8) } } });
    await a.c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    const token = (await a.c("POST", "/shop/order-token")).body.orderToken;
    const tea = (await a.c("GET", "/menu")).body.find((m) => m.name === "Tea");
    const r = await client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone: "9876500001", items: [{ itemId: tea.id, qty: 2, rate: 0.01, price: 0 }], total: 1 });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(30);
    // Someone else's order can't be read or paid without its key.
    expect((await client()("GET", `/public/shop/${token}/orders/${r.body.orderId}?k=guess`)).status).toBe(404);
    expect((await client()("POST", `/public/shop/${token}/orders/${r.body.orderId}/pay`, { key: "guess", method: "upi" })).status).toBe(404);
    // The customer view never shows other customers' phone numbers.
    const page = await client()("GET", `/public/shop/${token}`);
    expect(JSON.stringify(page.body)).not.toMatch(/9876500001/);
  });
});

describe("security headers on API responses", () => {
  it("API responses aren't cached and can't be sniffed or framed", async () => {
    const r = await client()("GET", "/auth/config");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});
