import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import { salaryFor, loanFor, wageFor } from "../shared/salary.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "salary-test";
  process.env.JWT_SECRET = "salary-test-secret-salary-test-secret";
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

describe("salary rules", () => {
  const w = { wageType: "monthly", wage: 30000 };
  it("works out day rates on month days, 30 or 26 working days", () => {
    const full = Array.from({ length: 31 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, status: "present" }));
    expect(salaryFor(w, "2026-03", full).earned).toBe(30000);
    expect(salaryFor(w, "2026-03", full, [], [], [], { settings: { dayBasis: "30" } }).earned).toBe(30000); // capped at the wage
    expect(salaryFor(w, "2026-03", full.slice(0, 15), [], [], [], { settings: { dayBasis: "30" } }).earned).toBe(15000);
    expect(salaryFor(w, "2026-03", full.slice(0, 13), [], [], [], { settings: { dayBasis: "26" } }).earned).toBe(15000);
  });

  it("counts weekly offs and (optionally) unmarked days, only up to today and after joining", () => {
    // March 2026: 1st is a Sunday → Sundays 1, 8, 15, 22, 29.
    const s = salaryFor({ ...w, joinedAt: "2026-03-05" }, "2026-03", [{ date: "2026-03-10", status: "absent" }], [], [], [], {
      settings: { weeklyOff: [0], unmarked: "present" },
      today: "2026-03-20",
    });
    // Joined 5th; 5–20 = 16 days: 1 absent, Sundays 8 and 15 off, 13 present.
    expect(s.auto).toEqual({ weekoff: 2, present: 13 });
    expect(s.paidDays).toBe(15);
  });

  it("takes loan instalments, skips months, and stops when repaid", () => {
    const loan = { amount: 5000, cut: 2000, startMonth: "2026-01", skips: ["2026-02"] };
    expect(loanFor(loan, "2025-12").cut).toBe(0);
    expect(loanFor(loan, "2026-01")).toEqual({ cut: 2000, leftBefore: 5000, leftAfter: 3000 });
    expect(loanFor(loan, "2026-02").cut).toBe(0);
    expect(loanFor(loan, "2026-03").cut).toBe(2000);
    expect(loanFor(loan, "2026-04")).toEqual({ cut: 1000, leftBefore: 1000, leftAfter: 0 });
    expect(loanFor(loan, "2026-05").cut).toBe(0);
    expect(loanFor({ ...loan, closedMonth: "2026-03" }, "2026-03").cut).toBe(0);
  });

  it("uses the wage that was in force that month", () => {
    const s = { wage: 14000, wageType: "monthly", wageHistory: [{ from: "0000-00", wage: 12000, wageType: "monthly" }, { from: "2026-10", wage: 14000, wageType: "monthly" }] };
    expect(wageFor(s, "2026-09").wage).toBe(12000);
    expect(wageFor(s, "2026-10").wage).toBe(14000);
    expect(wageFor({ wage: 9000 }, "2020-01").wage).toBe(9000);
  });
});

describe("payroll across months", () => {
  async function setup(email) {
    const c = client();
    await c("POST", "/auth/register", { shopName: "Pay Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
    const ram = (await c("POST", "/staff", { name: "Ramesh", role: "cook", pin: "1111", wage: 31000, wageType: "monthly", joinedAt: "2026-01-01" })).body;
    const sita = (await c("POST", "/staff", { name: "Sita", role: "helper", wage: 500, wageType: "daily", joinedAt: "2026-01-01" })).body;
    const month = async (m) => (await c("GET", `/staff/attendance?month=${m}`)).body;
    const fullMonth = (id, m, last = 31) => c("PUT", "/staff/attendance/bulk", { staffIds: [id], from: `${m}-01`, to: `${m}-${last}`, status: "present" });
    return { c, ram, sita, month, fullMonth };
  }

  it("carries unpaid salary and extra advances into the next month", async () => {
    const { c, ram, sita, month, fullMonth } = await setup("carry@test.local");
    await fullMonth(ram.id, "2026-01");
    await c("POST", `/staff/${ram.id}/salary-paid`, { month: "2026-01", amount: 25000, date: "2026-01-31" });
    // Sita: 4 days (₹2,000) but a ₹3,000 advance → she owes ₹1,000.
    await c("PUT", "/staff/attendance/bulk", { staffIds: [sita.id], from: "2026-01-01", to: "2026-01-04", status: "present" });
    await c("POST", `/staff/${sita.id}/advances`, { amount: 3000, date: "2026-01-02" });

    const jan = await month("2026-01");
    expect(jan.salary[ram.id]).toMatchObject({ earned: 31000, paid: 25000, payable: 6000, previousBalance: 0 });
    expect(jan.salary[sita.id].payable).toBe(-1000);
    expect(jan.summary).toMatchObject({ due: 6000, owedToShop: 1000, paid: 25000 });

    const feb = await month("2026-02");
    expect(feb.salary[ram.id].previousBalance).toBe(6000);
    expect(feb.salary[sita.id].previousBalance).toBe(-1000);
    await c("PUT", "/staff/attendance/bulk", { staffIds: [sita.id], from: "2026-02-01", to: "2026-02-10", status: "present" });
    expect((await month("2026-02")).salary[sita.id].payable).toBe(4000);

    // Passbook: newest first, balances chain.
    const pb = (await c("GET", `/staff/${ram.id}/passbook?upto=2026-02`)).body;
    expect(pb.months.map((m) => m.month)).toEqual(["2026-02", "2026-01"]);
    expect(pb.months[0].previousBalance).toBe(pb.months[1].payable);
  });

  it("starts from an opening balance", async () => {
    const { c, ram, month } = await setup("opening@test.local");
    await c("PUT", `/staff/${ram.id}`, { openingBalance: { amount: -2500, month: "2026-03" } });
    expect((await month("2026-03")).salary[ram.id].previousBalance).toBe(-2500);
    expect((await month("2026-04")).salary[ram.id].previousBalance).toBe(-2500);
  });

  it("recovers loans monthly and lists what's left", async () => {
    const { c, ram, month, fullMonth } = await setup("loan@test.local");
    await fullMonth(ram.id, "2026-03");
    const l = (await c("POST", `/staff/${ram.id}/loans`, { amount: 10000, cut: 4000, startMonth: "2026-03", date: "2026-03-01", note: "wedding" })).body;
    let m = await month("2026-03");
    expect(m.salary[ram.id]).toMatchObject({ loanCut: 4000, payable: 27000 });
    expect(m.loans[0]).toMatchObject({ amount: 10000, left: 6000, repaid: 4000 });
    await c("PUT", `/staff/loans/${l.id}`, { skip: "2026-04" });
    expect((await month("2026-04")).salary[ram.id].loanCut).toBe(0);
    expect((await month("2026-05")).salary[ram.id].loanCut).toBe(4000);
    expect((await month("2026-06")).salary[ram.id].loanCut).toBe(2000);
    expect((await month("2026-06")).loans[0].done).toBe(true);
  });

  it("keeps old wages for past months after a raise", async () => {
    const { c, ram, month, fullMonth } = await setup("raise@test.local");
    await fullMonth(ram.id, "2026-03");
    await fullMonth(ram.id, "2026-04", 30);
    await c("PUT", `/staff/${ram.id}`, { wage: 36000, wageFrom: "2026-04" });
    expect((await month("2026-03")).salary[ram.id].earned).toBe(31000);
    expect((await month("2026-04")).salary[ram.id].earned).toBe(36000);
  });

  it("pays everyone at once, closes the month and reopens it", async () => {
    const { c, ram, sita, month, fullMonth } = await setup("payall@test.local");
    await fullMonth(ram.id, "2026-03");
    await c("PUT", "/staff/attendance/bulk", { staffIds: [sita.id], from: "2026-03-01", to: "2026-03-10", status: "present" });
    const r = await c("POST", "/staff/pay-all", { month: "2026-03", date: "2026-03-31", mode: "upi", payments: [{ staffId: ram.id, amount: 31000 }, { staffId: sita.id, amount: 5000 }] });
    expect(r.body).toMatchObject({ paid: 2, total: 36000 });
    const m = await month("2026-03");
    expect(m.summary.due).toBe(0);
    const exp = (await c("GET", "/expenses?from=2026-03-01&to=2026-03-31")).body.expenses.filter((e) => e.category === "Salary");
    expect(exp).toHaveLength(2);

    await c("POST", "/staff/months/2026-03/close");
    expect((await month("2026-03")).closed.closedBy).toBe("Owner");
    const refused = await c("PUT", "/staff/attendance", { staffId: ram.id, date: "2026-03-05", status: "absent" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("MONTH_CLOSED");
    expect((await c("POST", `/staff/${ram.id}/advances`, { amount: 100, date: "2026-03-20" })).status).toBe(409);
    expect((await c("POST", `/staff/${ram.id}/advances`, { amount: 100, date: "2026-04-02" })).status).toBe(200);
    await c("POST", "/staff/months/2026-03/reopen");
    expect((await c("PUT", "/staff/attendance", { staffId: ram.id, date: "2026-03-05", status: "absent" })).status).toBe(200);
  });

  it("saves salary settings", async () => {
    const { c, ram, month } = await setup("settings@test.local");
    const r = await c("PUT", "/staff/settings", { weeklyOff: [0], unmarked: "none", dayBasis: "26", otAuto: true });
    expect(r.body.settings).toMatchObject({ weeklyOff: [0], dayBasis: "26" });
    expect((await month("2026-03")).settings.dayBasis).toBe("26");
    expect((await c("PUT", "/staff/settings", { weeklyOff: [9], unmarked: "none", dayBasis: "26", otAuto: true })).status).toBe(400);
    expect(ram.id).toBeTruthy();
  });
});
