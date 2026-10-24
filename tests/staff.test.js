import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "staff-test";
  process.env.JWT_SECRET = "staff-test-secret-staff-test-secret";
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

const M = "2026-03"; // 31 days; 1 March 2026 is a Sunday (Sundays: 1, 8, 15, 22, 29)

async function setup(email) {
  const c = client();
  await c("POST", "/auth/register", { shopName: "Staff Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  const a = (await c("POST", "/staff", { name: "Ramesh", role: "cook", pin: "1111", wage: 31000, wageType: "monthly" })).body;
  const b = (await c("POST", "/staff", { name: "Sita", role: "helper", wage: 500, wageType: "daily" })).body;
  const month = async () => (await c("GET", `/staff/attendance?month=${M}`)).body;
  return { c, a, b, month };
}

describe("attendance ranges", () => {
  it("marks from–to for several workers, skips Sundays, keeps marked days, and clears", async () => {
    const { c, a, b, month } = await setup("range@test.local");
    await c("PUT", "/staff/attendance", { staffId: a.id, date: "2026-03-03", status: "absent", otHours: 2 });

    const r = await c("PUT", "/staff/attendance/bulk", { staffIds: [a.id, b.id], from: "2026-03-01", to: "2026-03-15", status: "present", skipSundays: true, onlyEmpty: true });
    expect(r.status).toBe(200);
    // 15 days − 3 Sundays = 12 per worker; Ramesh's 3rd is kept.
    expect(r.body).toMatchObject({ marked: 23, skipped: 1 });
    let m = await month();
    const day = (id, d) => m.records.find((x) => x.staffId === id && x.date === d);
    expect(day(a.id, "2026-03-03")).toMatchObject({ status: "absent", otHours: 2 });
    expect(day(a.id, "2026-03-08")).toBeUndefined(); // Sunday
    expect(day(b.id, "2026-03-14").status).toBe("present");

    // Overwrite (keeps the overtime already entered), then clear a range.
    await c("PUT", "/staff/attendance/bulk", { staffIds: [a.id], from: "2026-03-03", to: "2026-03-03", status: "half" });
    await c("PUT", "/staff/attendance/bulk", { staffIds: [b.id], from: "2026-03-10", to: "2026-03-15", status: "none" });
    m = await month();
    expect(day(a.id, "2026-03-03")).toMatchObject({ status: "half", otHours: 2 });
    expect(m.records.filter((x) => x.staffId === b.id)).toHaveLength(7);

    expect((await c("PUT", "/staff/attendance/bulk", { staffIds: [a.id], from: "2026-01-01", to: "2026-03-31", status: "present" })).status).toBe(400);
    expect((await c("PUT", "/staff/attendance/bulk", { staffIds: [a.id], from: "2026-03-05", to: "2026-03-01", status: "present" })).status).toBe(400);
  });
});

describe("fixing advances and salary", () => {
  it("edits advances, adds bonus/deduction, and edits or removes payments with their expense", async () => {
    const { c, a, month } = await setup("money@test.local");
    await c("PUT", "/staff/attendance/bulk", { staffIds: [a.id], from: "2026-03-01", to: "2026-03-31", status: "present" });
    let s = (await month()).salary[a.id];
    expect(s.earned).toBe(31000);

    const adv = (await c("POST", `/staff/${a.id}/advances`, { amount: 500, date: "2026-03-05" })).body;
    expect((await c("PUT", `/staff/advances/${adv.id}`, { amount: 800, date: "2026-03-06", note: "medicine", mode: "upi" })).status).toBe(200);
    let m = await month();
    expect(m.advances[0]).toMatchObject({ amount: 800, date: "2026-03-06", note: "medicine", mode: "upi" });
    expect(m.salary[a.id].payable).toBe(31000 - 800);

    const bonus = (await c("POST", `/staff/${a.id}/adjustments`, { month: M, amount: 1000, note: "Holi bonus" })).body;
    await c("POST", `/staff/${a.id}/adjustments`, { month: M, amount: -200, note: "broken plate" });
    expect((await c("POST", `/staff/${a.id}/adjustments`, { month: M, amount: 0, note: "x" })).status).toBe(400);
    s = (await month()).salary[a.id];
    expect(s).toMatchObject({ bonus: 1000, deduction: 200, payable: 31000 + 1000 - 200 - 800 });
    await c("PUT", `/staff/adjustments/${bonus.id}`, { month: M, amount: 1500, note: "Holi bonus" });
    expect((await month()).salary[a.id].bonus).toBe(1500);

    await c("POST", `/staff/${a.id}/salary-paid`, { month: M, amount: 20000, date: "2026-03-31", mode: "cash" });
    m = await month();
    const pay = m.payments[0];
    const expenses = async () => (await c("GET", "/expenses?from=2026-03-01&to=2026-04-30")).body.expenses.filter((e) => e.category === "Salary");
    expect((await expenses())[0].amount).toBe(20000);

    const ed = await c("PUT", `/staff/payments/${pay.id}`, { amount: 25000, date: "2026-04-01", mode: "bank" });
    expect(ed.body.expenseUpdated).toBe(true);
    expect((await expenses())[0]).toMatchObject({ amount: 25000, date: "2026-04-01", paymentMode: "bank" });
    expect((await month()).salary[a.id].paid).toBe(25000);

    const del = await c("DELETE", `/staff/payments/${pay.id}`);
    expect(del.body.expenseRemoved).toBe(true);
    expect(await expenses()).toHaveLength(0);
    expect((await month()).salary[a.id].paid).toBe(0);
  });

  it("finds the expense of a payment made before payments remembered it", async () => {
    const { c, a, month } = await setup("older@test.local");
    await c("POST", `/staff/${a.id}/salary-paid`, { month: M, amount: 5000, date: "2026-03-31" });
    const db = await getDb();
    await db.collection("salaryPayments").updateMany({}, { $unset: { expenseId: "" } });
    const pay = (await month()).payments[0];
    expect((await c("DELETE", `/staff/payments/${pay.id}`)).body.expenseRemoved).toBe(true);
  });
});
