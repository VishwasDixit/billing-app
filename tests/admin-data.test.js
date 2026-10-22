import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;
const inbox = [];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "admin-data-test";
  process.env.JWT_SECRET = "admin-data-secret-admin-data-secret";
  process.env.ADMIN_EMAIL = "boss@x.test";
  ({ closeDb, getDb } = await import("../server/db.js"));
  const { setTestTransport } = await import("../server/otp/mailer.js");
  setTestTransport(async (m) => inbox.push(m));
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

// Signs up through the email-code flow (codes come from the captured inbox).
async function signup(email, shopName = "Shop " + email.split("@")[0]) {
  const c = client();
  const start = await c("POST", "/auth/register/start", { shopName, name: "Owner " + email[0], phone: "9876543210", email, password: "secret12" });
  expect(start.status).toBe(200);
  const code = [...inbox].reverse().find((m) => m.to === email && m.purpose === "register").code;
  const r = await c("POST", "/auth/register/verify", { email, code });
  expect(r.status).toBe(201);
  return { c, shop: r.body.shop };
}

const bill = () => ({
  clientId: crypto.randomUUID(),
  billNo: "A-1",
  createdAt: new Date().toISOString(),
  items: [{ name: "Tea", qty: 2, rate: 15 }],
  paymentMode: "cash",
});

let admin;
describe("admin: delete a shop", () => {
  it("exports everything, then deletes only that shop after the name is typed", async () => {
    admin = (await signup("boss@x.test", "HQ")).c;
    const gone = await signup("gone@x.test", "Gupta Sweets");
    const kept = await signup("kept@x.test", "Sharma Tea");
    for (const s of [gone, kept]) {
      await s.c("POST", "/bills", { bills: [bill(), bill()] });
      await s.c("POST", "/expenses", { date: "2026-10-01", category: "Gas", amount: 100 });
      await s.c("POST", "/help/threads", { subject: "Printer issue", text: "It does not print" });
    }

    const exp = await admin("GET", `/admin/shops/${gone.shop.id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.body.shop.name).toBe("Gupta Sweets");
    expect(exp.body.users[0]).not.toHaveProperty("passwordHash");
    expect(exp.body.bills).toHaveLength(2);
    expect(exp.body.menu.length).toBeGreaterThan(10);
    expect(exp.body.expenses).toHaveLength(1);
    expect(exp.body.help).toHaveLength(1);

    expect((await gone.c("DELETE", `/admin/shops/${kept.shop.id}`, { confirmName: "Sharma Tea" })).status).toBe(403);
    expect((await admin("DELETE", `/admin/shops/${gone.shop.id}`, { confirmName: "Gupta" })).body.error).toMatch(/doesn't match/);
    const myShop = (await admin("GET", "/auth/me")).body.shop.id;
    expect((await admin("DELETE", `/admin/shops/${myShop}`, { confirmName: "HQ" })).status).toBe(400);

    const del = await admin("DELETE", `/admin/shops/${gone.shop.id}`, { confirmName: "gupta sweets" });
    expect(del.status).toBe(200);
    expect(del.body.counts).toMatchObject({ bills: 2, expenses: 1, helpThreads: 1, users: 1 });

    const db = await getDb();
    const { ObjectId } = await import("mongodb");
    const goneId = new ObjectId(gone.shop.id);
    for (const name of ["shops", "menuItems", "bills", "expenses", "helpThreads"]) {
      expect(await db.collection(name).countDocuments(name === "shops" ? { _id: goneId } : { shopId: goneId })).toBe(0);
    }
    expect(await db.collection("users").countDocuments({ email: "gone@x.test" })).toBe(0);
    expect((await gone.c("GET", "/auth/me")).status).toBe(401);
    // The other shop is untouched.
    expect((await kept.c("GET", "/bills")).body.bills).toHaveLength(2);
    expect(await db.collection("adminLog").countDocuments({ action: "delete-shop", shopName: "Gupta Sweets" })).toBe(1);
  });
});

describe("help messages", () => {
  it("lets a shop ask, emails the admin, and shows the admin's reply", async () => {
    const shop = await signup("helpme@x.test", "Verma Dhaba");
    const other = await signup("nosy@x.test");
    const before = inbox.length;
    const t = (await shop.c("POST", "/help/threads", { subject: "Bill not printing", text: "Printer turns off when I print." })).body;
    expect(t).toMatchObject({ status: "open", unreadByAdmin: true, count: 1 });
    expect(inbox.slice(before).find((m) => m.to === "boss@x.test").subject).toContain("Verma Dhaba");

    // Another shop can't see or write to it.
    expect((await other.c("GET", "/help/threads")).body.threads).toHaveLength(0);
    expect((await other.c("POST", `/help/threads/${t.id}/messages`, { text: "hello there" })).status).toBe(404);
    expect((await shop.c("GET", "/admin/help")).status).toBe(403);

    const list = (await admin("GET", "/admin/help?status=open")).body;
    expect(list.unread).toBeGreaterThanOrEqual(1);
    expect(list.threads.find((x) => x.id === t.id)).toMatchObject({ shopName: "Verma Dhaba", unreadByAdmin: true });
    expect((await admin("GET", `/admin/help/${t.id}`)).body.unreadByAdmin).toBe(false);

    const sent = inbox.length;
    const reply = (await admin("POST", `/admin/help/${t.id}/reply`, { text: "Please turn on Slow mode in Settings." })).body;
    expect(reply).toMatchObject({ status: "answered", unreadByShop: true });
    expect(inbox.slice(sent).find((m) => m.to === "helpme@x.test").subject).toMatch(/Reply from support/);

    const mine = (await shop.c("GET", "/help/threads")).body.threads[0];
    expect(mine.messages.map((m) => m.from)).toEqual(["shop", "admin"]);
    await shop.c("POST", `/help/threads/${t.id}/read`);
    expect((await shop.c("GET", "/help/threads")).body.threads[0].unreadByShop).toBe(false);

    // A follow-up reopens it for the admin.
    expect((await shop.c("POST", `/help/threads/${t.id}/messages`, { text: "It works now, thanks!" })).body).toMatchObject({ status: "open", unreadByAdmin: true });
    expect((await admin("POST", `/admin/help/${t.id}/status`, { status: "closed" })).body.status).toBe("closed");
  });

  it("checks screenshots and limits new messages", async () => {
    const { c } = await signup("spammy@x.test");
    expect((await c("POST", "/help/threads", { subject: "Bad pic", text: "see this", image: "data:text/html;base64,PGgxPg==" })).status).toBe(400);
    const ok = await c("POST", "/help/threads", { subject: "Good pic", text: "see this", image: "data:image/jpeg;base64,/9j/4AAQ" });
    expect(ok.body.messages[0].image).toMatch(/^data:image\/jpeg/);
    for (let i = 0; i < 9; i++) await c("POST", "/help/threads", { subject: "Again " + i, text: "more text" });
    expect((await c("POST", "/help/threads", { subject: "One too many", text: "more text" })).status).toBe(429);
  });
});

describe("photo limits", () => {
  it("refuses heavy photos and caps uploaded photos per shop", async () => {
    const { c } = await signup("photos@x.test");
    const menu = (await c("GET", "/menu")).body;
    const jpeg = (bytes) => "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(bytes)]).toString("base64");
    expect((await c("PUT", `/menu/${menu[0].id}/image`, { dataUrl: jpeg(60 * 1024) })).status).toBe(400);
    expect((await c("PUT", `/menu/${menu[0].id}/image`, { dataUrl: jpeg(20 * 1024) })).status).toBe(200);

    const { MAX_PHOTOS_PER_SHOP } = await import("../server/routes/shop.js");
    const db = await getDb();
    const shopId = (await db.collection("users").findOne({ email: "photos@x.test" })).shopId;
    await db.collection("menuImages").insertMany(
      Array.from({ length: MAX_PHOTOS_PER_SHOP - 1 }, () => ({ shopId, itemId: null, type: "image/jpeg", data: Buffer.alloc(1), createdAt: new Date() }))
    );
    // Replacing an item's own photo still works at the limit; a new one doesn't.
    expect((await c("PUT", `/menu/${menu[0].id}/image`, { dataUrl: jpeg(1000) })).status).toBe(200);
    const r = await c("PUT", `/menu/${menu[1].id}/image`, { dataUrl: jpeg(1000) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Photo limit reached/);
  });
});
