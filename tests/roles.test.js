import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "roles-test";
  process.env.JWT_SECRET = "roles-test-secret-roles-test-secret";
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

async function shopWithStaff(email) {
  const owner = client();
  await owner("POST", "/auth/register", { shopName: "Roles Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const cook = (await owner("POST", "/staff", { name: "Ramesh", role: "cook", pin: "1111" })).body;
  const mgr = (await owner("POST", "/staff", { name: "Sita", role: "manager", pin: "2222" })).body;
  const cleaner = (await owner("POST", "/staff", { name: "Mohan", role: "cleaner", pin: "3333" })).body;
  const { code } = (await owner("GET", "/staff/code")).body;
  const login = async (staffId, pin) => {
    const c = client();
    const r = await c("POST", "/auth/staff-login", { code: code.toLowerCase(), staffId, pin });
    return { c, r };
  };
  return { owner, cook, mgr, cleaner, code, login };
}

describe("staff roles", () => {
  it("gives access by job, signs staff in with code + PIN, and locks after wrong PINs", async () => {
    const { owner, cook, mgr, cleaner, code, login } = await shopWithStaff("login@test.local");
    expect(cook.access).toBe("kitchen");
    expect(mgr.access).toBe("manager");
    expect(cleaner.access).toBe("none");
    expect(cook.pinHash).toBeUndefined();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const names = (await client()("GET", `/auth/staff-names?code=${code}`)).body;
    expect(names.shop.name).toBe("Roles Dhaba");
    expect(names.staff.map((s) => s.name)).toEqual(["Ramesh", "Sita"]); // cleaner has no app access
    expect((await client()("GET", "/auth/staff-names?code=ZZZZZZ")).status).toBe(404);

    const ok = await login(cook.id, "1111");
    expect(ok.r.status).toBe(200);
    expect(ok.r.body.user).toMatchObject({ role: "kitchen", name: "Ramesh" });
    expect(ok.r.body.user.email).toBeUndefined();
    expect((await login(cleaner.id, "3333")).r.status).toBe(403);

    for (let i = 0; i < 8; i++) expect((await login(mgr.id, "9999")).r.status).toBe(401);
    expect((await login(mgr.id, "2222")).r.status).toBe(429);
    // Owner can't be locked out by this, and an owner session still works.
    expect((await owner("GET", "/analytics")).status).not.toBe(403);
  });

  it("cooks reach only kitchen things; managers bill but see no money reports", async () => {
    const { owner, cook, mgr, login } = await shopWithStaff("access@test.local");
    const { c: k } = await login(cook.id, "1111");
    const { c: m } = await login(mgr.id, "2222");

    for (const path of ["/bills", "/customers", "/analytics", "/expenses", "/staff/attendance?month=2026-10", "/bills/changes", "/kitchen/report"]) {
      expect((await k("GET", path)).status, `cook ${path}`).toBe(403);
    }
    for (const path of ["/kitchen/ingredients", "/orders", "/menu", "/auth/me", "/kitchen/alerts"]) {
      expect((await k("GET", path)).status, `cook ${path}`).toBe(200);
    }
    expect((await k("PUT", "/shop", { name: "Hacked" })).status).toBe(403);

    for (const path of ["/analytics", "/staff/attendance?month=2026-10", "/bills/changes", "/kitchen/report", "/staff/code"]) {
      expect((await m("GET", path)).status, `manager ${path}`).toBe(403);
    }
    expect((await m("PUT", "/shop", { name: "Hacked" })).status).toBe(403);
    expect((await m("PUT", "/shop/bill-pin", { password: "secret12", pin: "0000" })).status).toBe(403);
    for (const path of ["/bills", "/customers", "/orders", "/kitchen/ingredients", "/menu"]) {
      expect((await m("GET", path)).status, `manager ${path}`).toBe(200);
    }
    // The manager gets names only, never wages or PINs.
    const staff = (await m("GET", "/staff")).body.staff;
    expect(staff[0].wage).toBeUndefined();

    // A cook's kitchen entry is signed with their name, no PIN pad needed.
    await owner("POST", "/kitchen/ingredients/starter", { names: ["Onion"] });
    const onion = (await k("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Onion");
    const r = await k("POST", "/kitchen/moves", { moves: [{ clientId: crypto.randomUUID(), ingredientId: onion.id, type: "purchase", qty: 2, unit: "kg" }] });
    expect(r.body.results[0].ok).toBe(true);
    const moves = (await owner("GET", "/kitchen/moves")).body.moves;
    expect(moves[0].staffName).toBe("Ramesh");

    // Manager bills, edits and deletes; the audit names them. The owner PIN still applies.
    const menu = (await m("GET", "/menu")).body;
    const tea = menu.find((x) => x.name === "Tea");
    const clientId = crypto.randomUUID();
    await m("POST", "/bills", { bills: [{ clientId, billNo: "M-1", createdAt: new Date().toISOString(), items: [{ itemId: tea.id, name: "Tea", qty: 2, rate: 15 }] }] });
    const bill = (await m("GET", "/bills")).body.bills.find((b) => b.clientId === clientId);
    const ed = await m("PUT", `/bills/${bill.id}`, { items: [{ itemId: tea.id, name: "Tea", qty: 3, rate: 15 }], discount: { type: "percent", value: 0 }, gstPercent: 0, paymentMode: "cash", reason: "items" });
    expect(ed.body.revisions[0].by).toBe("Sita");
    await owner("PUT", "/shop/bill-pin", { password: "secret12", pin: "4321" });
    expect((await m("POST", `/bills/${bill.id}/delete`, { reason: "duplicate" })).status).toBe(401);
    expect((await m("POST", `/bills/${bill.id}/delete`, { reason: "duplicate", pin: "4321" })).body.deletedBy).toBe("Sita");
    const changes = (await owner("GET", "/bills/changes")).body;
    expect(changes.items.map((x) => x.by)).toEqual(["Sita", "Sita"]);
  });

  it("signs a worker out when the PIN, access or job changes, or the code is renewed", async () => {
    const { owner, cook, mgr, login } = await shopWithStaff("out@test.local");
    let { c: k } = await login(cook.id, "1111");
    expect((await k("GET", "/auth/me")).status).toBe(200);
    await owner("PUT", `/staff/${cook.id}`, { pin: "5555" });
    const out = await k("GET", "/auth/me");
    expect(out.status).toBe(401);
    expect(out.body.code).toBe("STAFF_OUT");

    ({ c: k } = await login(cook.id, "5555"));
    await owner("PUT", `/staff/${cook.id}`, { active: false });
    expect((await k("GET", "/auth/me")).status).toBe(401);

    const { c: m } = await login(mgr.id, "2222");
    expect((await m("GET", "/bills")).status).toBe(200);
    const { code } = (await owner("POST", "/staff/code")).body;
    expect((await m("GET", "/bills")).status).toBe(401);
    expect((await login(mgr.id, "2222")).r.status).toBe(404); // old code no longer works
    const again = await client()("POST", "/auth/staff-login", { code, staffId: mgr.id, pin: "2222" });
    expect(again.status).toBe(200);

    // Access needs a PIN.
    const noPin = await owner("POST", "/staff", { name: "Ravi", role: "helper", access: "kitchen" });
    expect(noPin.status).toBe(400);
  });

  it("the shared kitchen phone still works", async () => {
    const { owner, cook } = await shopWithStaff("shared@test.local");
    const r = await owner("POST", "/auth/kitchen-mode", { password: "secret12" });
    expect(r.body.user.role).toBe("kitchen");
    expect((await owner("GET", "/bills")).status).toBe(403);
    const v = await owner("POST", "/staff/verify-pin", { staffId: cook.id, pin: "1111" });
    expect(v.status).toBe(200);
  });

  it("managers write expenses under their name; salaries and others' entries stay with the owner", async () => {
    const { owner, cook, mgr, login } = await shopWithStaff("expense@test.local");
    const { c: m } = await login(mgr.id, "2222");
    const { c: k } = await login(cook.id, "1111");
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const old = new Date(Date.now() + 5.5 * 3600e3 - 10 * 864e5).toISOString().slice(0, 10);

    expect((await k("GET", "/expenses")).status).toBe(403);
    const added = await m("POST", "/expenses", { date: today, category: "Gas", amount: 950, note: "cylinder" });
    expect(added.status).toBe(200);
    expect(added.body.addedBy).toBe("Sita");
    expect((await m("POST", "/expenses", { date: today, category: "Salary", amount: 5000 })).status).toBe(403);
    expect((await m("POST", "/expenses", { date: old, category: "Gas", amount: 100 })).status).toBe(400);

    const sal = (await owner("POST", "/expenses", { date: today, category: "Salary", amount: 15000 })).body;
    const rent = (await owner("POST", "/expenses", { date: today, category: "Rent", amount: 8000 })).body;
    expect(sal.addedBy).toBe("Owner");
    const list = (await m("GET", "/expenses")).body;
    expect(list.expenses.map((e) => e.category).sort()).toEqual(["Gas", "Rent"]); // no salaries
    expect(list.categories).not.toContain("Salary");

    // Own entry: can fix it; the owner's entries are read-only.
    expect((await m("PUT", `/expenses/${added.body.id}`, { date: today, category: "Gas", amount: 900 })).body.amount).toBe(900);
    expect((await m("PUT", `/expenses/${rent.id}`, { date: today, category: "Rent", amount: 1 })).status).toBe(403);
    expect((await m("DELETE", `/expenses/${sal.id}`)).status).toBe(403);
    // After a day, their own entry is locked too.
    const db = await getDb();
    const { ObjectId } = await import("mongodb");
    await db.collection("expenses").updateOne({ _id: new ObjectId(added.body.id) }, { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } });
    expect((await m("DELETE", `/expenses/${added.body.id}`)).status).toBe(403);
    expect((await owner("DELETE", `/expenses/${added.body.id}`)).status).toBe(200);
  });
});
