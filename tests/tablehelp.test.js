// Customers ask the restaurant from the QR page (call a waiter, water, questions); staff reply.
// And the bestsellers shown on the customer menu.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "tablehelp-test";
  process.env.JWT_SECRET = "tablehelp-test-secret-tablehelp-test";
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
function client(ip = `10.7.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

async function shop(email, settings = {}) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Help Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const { ObjectId } = await import("mongodb");
  await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
  await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }], qrOrdering: true, ...settings });
  const token = (await c("POST", "/shop/order-token")).body.orderToken;
  return { c, token, shopId: r.body.shop.id };
}
const device = () => crypto.randomBytes(12).toString("base64url");

describe("asking the restaurant", () => {
  it("quick asks and questions reach the staff, who reply; customers see only their own", async () => {
    const { c, token } = await shop("help@th.test");
    const me = device();
    const phone = client();
    const ask = (body) => phone("POST", `/public/shop/${token}/help`, { table: "T1", deviceKey: me, name: "Ravi", ...body });
    const water = await ask({ kind: "water" });
    expect(water.status).toBe(200);
    // Tapping again soon doesn't make a second request.
    expect((await ask({ kind: "water" })).body.id).toBe(water.body.id);
    const q = await ask({ kind: "question", text: "  Is the <b>paneer</b> spicy?  " });
    expect(q.body.text).toBe("Is the <b>paneer</b> spicy?"); // plain text, shown as text
    expect((await ask({ kind: "question", text: "x".repeat(201) })).status).toBe(400);
    expect((await ask({ kind: "question", text: " " })).status).toBe(400);
    expect((await ask({ kind: "dance" })).status).toBe(400);
    expect((await ask({ kind: "water", table: "T9" })).status).toBe(400);

    // Someone else's phone at the same table doesn't see Ravi's questions.
    const other = device();
    await client()("POST", `/public/shop/${token}/help`, { table: "T1", deviceKey: other, kind: "waiter" });
    const mine = (await phone("GET", `/public/shop/${token}/help?d=${me}`)).body.requests;
    expect(mine.map((x) => x.kind).sort()).toEqual(["question", "water"]);
    expect((await phone("GET", `/public/shop/${token}/help?d=short`)).status).toBe(400);

    // Staff see all three on the Orders screen (through the normal refresh).
    const open = (await c("GET", "/orders")).body.helpRequests;
    expect(open).toHaveLength(3);
    expect(open.find((x) => x.kind === "water")).toMatchObject({ table: "T1", tableName: "Table 1", name: "Ravi", count: 2 });
    expect(open[0].deviceKey).toBeUndefined();

    const qid = open.find((x) => x.kind === "question").id;
    expect((await c("POST", `/orders/help/${qid}`, { reply: "Medium spicy 🌶️" })).body).toMatchObject({ status: "replied", reply: "Medium spicy 🌶️", repliedBy: "Owner" });
    await c("POST", `/orders/help/${water.body.id}`, { done: true });
    const after = (await phone("GET", `/public/shop/${token}/help?d=${me}`)).body.requests;
    expect(after.find((x) => x.kind === "question")).toMatchObject({ status: "replied", reply: "Medium spicy 🌶️" });
    expect(after.find((x) => x.kind === "water").status).toBe("done");
    // Done ones leave the staff list.
    expect((await c("GET", "/orders")).body.helpRequests.map((x) => x.kind).sort()).toEqual(["question", "waiter"]);

    // Another shop can't touch them.
    const b = await shop("help-b@th.test");
    expect((await b.c("POST", `/orders/help/${qid}`, { done: true })).status).toBe(404);
  });

  it("limits how many requests a table or a phone can send, and needs QR ordering on", async () => {
    const { c, token } = await shop("limits@th.test");
    const p = client();
    let last;
    for (let i = 0; i < 16; i++) last = await p("POST", `/public/shop/${token}/help`, { table: "T2", deviceKey: device(), kind: "question", text: `q ${i}` });
    expect(last.status).toBe(429);
    await c("PUT", "/shop", { qrOrdering: false });
    expect((await client()("POST", `/public/shop/${token}/help`, { table: "T1", deviceKey: device(), kind: "waiter" })).status).toBe(403);
  });

  it("kitchen phones can answer too", async () => {
    const { c, token } = await shop("kitchen@th.test");
    const cook = (await c("POST", "/staff", { name: "Ramu", role: "cook", pin: "1111", wage: 1 })).body;
    const code = (await c("GET", "/staff/code")).body.code;
    const k = client();
    await k("POST", "/auth/staff-login", { code, staffId: cook.id, pin: "1111" });
    const r = await client()("POST", `/public/shop/${token}/help`, { table: "T1", deviceKey: device(), kind: "waiter" });
    expect((await k("POST", `/orders/help/${r.body.id}`, { reply: "Coming!" })).body.repliedBy).toBe("Ramu");
  });
});

describe("bestsellers on the customer menu", () => {
  it("come from paid bills in the last 30 days (not deleted ones), else the menu order", async () => {
    const { c, token } = await shop("popular@th.test");
    const menu = (await c("GET", "/menu")).body;
    const fresh = (await client()("GET", `/public/shop/${token}`)).body.popular;
    expect(fresh).toEqual(menu.filter((m) => m.active !== false).slice(0, 8).map((m) => m.id));

    // Dishes without a stock count (selling a counted dish can sell it out, and sold-out dishes are hidden).
    const free = menu.filter((m) => m.active !== false && m.stock == null && m.dailyStock == null);
    const [a, b, d] = [free[10], free[20], free[30]];
    const bill = (items) => ({ clientId: crypto.randomUUID(), billNo: `X-${Math.floor(Math.random() * 1e6)}`, createdAt: new Date().toISOString(), paymentMode: "cash", items });
    const line = (m, qty) => ({ itemId: m.id, name: m.name, qty, rate: m.variants[0].price, variant: m.variants[0].label || "" });
    const del = bill([line(d, 50)]);
    await c("POST", "/bills", { bills: [bill([line(a, 3), line(b, 5)]), bill([line(a, 4)]), del] });
    const saved = (await c("GET", "/bills")).body.bills.find((x) => x.clientId === del.clientId);
    await c("POST", `/bills/${saved.id}/delete`, { reason: "wrong" });
    // Cached for a few hours: clear it to see the new numbers now.
    await (await getDb()).collection("shops").updateMany({}, { $unset: { popularCache: "" } });
    const pop = (await client()("GET", `/public/shop/${token}`)).body.popular;
    expect(pop.slice(0, 2)).toEqual([a.id, b.id]); // 7 of a, 5 of b; the deleted 50 don't count
    expect(pop).not.toContain(d.id);
  });
});

describe("the shop controls the help section", () => {
  it("can turn help off, pick which quick asks show, and turn off questions", async () => {
    const { c, token } = await shop("settings@th.test");
    const pub = async () => (await client()("GET", `/public/shop/${token}`)).body.help;
    const ask = (kind, text) => client()("POST", `/public/shop/${token}/help`, { table: "T1", deviceKey: device(), kind, ...(text && { text }) });
    // Default: on, the restaurant set (call staff instead of waiter is optional).
    expect(await pub()).toEqual({ enabled: true, asks: ["waiter", "water", "bill", "cutlery"], questions: true });

    // A library: only "Call staff" and questions.
    expect((await c("PUT", "/shop", { help: { enabled: true, asks: ["staff"], questions: true } })).status).toBe(200);
    expect(await pub()).toEqual({ enabled: true, asks: ["staff"], questions: true });
    expect((await ask("water")).status).toBe(400);
    expect((await ask("staff")).status).toBe(200);
    expect((await ask("question", "Where are the history books?")).status).toBe(200);

    await c("PUT", "/shop", { help: { enabled: true, asks: ["staff"], questions: false } });
    expect((await ask("question", "hello")).status).toBe(400);

    await c("PUT", "/shop", { help: { enabled: false, asks: ["staff"], questions: true } });
    expect((await pub()).enabled).toBe(false);
    expect((await ask("staff")).status).toBe(403);
    // Unknown buttons are refused when saving.
    expect((await c("PUT", "/shop", { help: { enabled: true, asks: ["dance"], questions: true } })).status).toBe(400);
  });
});
