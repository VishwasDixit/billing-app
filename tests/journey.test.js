// End-to-end integration: one whole day at a dhaba through the real server, from sign-up to
// month close, checking that bills, dashboard, udhar, stock, kitchen and salary all agree.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "journey-test";
  process.env.JWT_SECRET = "journey-test-secret-journey-test-secret";
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
    const json = await r.json();
    if (r.status >= 500) throw new Error(`${method} ${path} → ${r.status} ${json.error}`);
    return { status: r.status, body: json };
  };
}
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);

describe("a day at the dhaba", () => {
  it("runs end to end and every screen agrees", async () => {
    // 1. Owner signs up on a paid plan, sets up tables, QR, UPI, kitchen, staff.
    const owner = client();
    const reg = await owner("POST", "/auth/register", { shopName: "Journey Dhaba", name: "Owner", phone: "9876543210", email: "journey@test.local", password: "secret12" });
    expect(reg.status).toBe(201);
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne(
      { _id: new ObjectId(reg.body.shop.id) },
      { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } }
    );
    expect((await owner("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }], qrOrdering: true, upiId: "journey@okaxis", qrPayment: "choose", askCustomer: "optional" })).status).toBe(200);
    const token = (await owner("POST", "/shop/order-token")).body.orderToken;
    const menu = (await owner("GET", "/menu")).body;
    const dish = (n) => menu.find((m) => m.name === n);
    const tea = dish("Tea");
    const dal = dish("Dal Tadka");
    await owner("POST", "/kitchen/recipes/standard", { itemIds: [tea.id, dal.id] });
    const ings = (await owner("GET", "/kitchen/ingredients")).body.ingredients;
    const ing = (n) => ings.find((i) => i.name === n);
    const buy = (i, qty, unit, cost) => owner("POST", "/kitchen/moves", { moves: [{ clientId: crypto.randomUUID(), ingredientId: ing(i).id, type: "purchase", qty, unit, cost }] });
    await buy("Toor dal", 5, "kg", 700);
    await buy("Milk", 10, "L", 600);
    const cook = (await owner("POST", "/staff", { name: "Ramesh", role: "cook", pin: "1111", wage: 15000, joinedAt: `${month}-01` })).body;
    const mgr = (await owner("POST", "/staff", { name: "Sita", role: "manager", pin: "2222", wage: 12000, joinedAt: `${month}-01` })).body;
    const code = (await owner("GET", "/staff/code")).body.code;

    // 2. Staff sign in on their own phones.
    const manager = client();
    expect((await manager("POST", "/auth/staff-login", { code, staffId: mgr.id, pin: "2222" })).status).toBe(200);
    const kitchen = client();
    expect((await kitchen("POST", "/auth/staff-login", { code, staffId: cook.id, pin: "1111" })).status).toBe(200);

    // 3. A customer orders by QR with name and mobile, and pays now.
    const phone = client();
    const qr = (await phone("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Priya", phone: "9811122233", items: [{ itemId: dal.id, variant: "Full", qty: 2 }] })).body;
    expect(qr.pay).toMatchObject({ rule: "choose", state: "choose" });
    expect((await phone("POST", `/public/shop/${token}/orders/${qr.orderId}/pay`, { key: qr.key, method: "upi", utr: "412345678901" })).body.pay.state).toBe("claimed");

    // 4. Manager confirms → bill P-1 saved; accepts → kitchen cooks.
    const conf = (await manager("POST", `/orders/${qr.orderId}/payment`, { action: "confirm" })).body;
    expect(conf.bill).toMatchObject({ billNo: "P-1", paymentMode: "upi", customer: { name: "Priya", phone: "9811122233" } });
    await manager("POST", `/orders/${qr.orderId}/status`, { status: "accepted" });
    for (const s of ["preparing", "ready", "served"]) expect((await kitchen("POST", `/orders/${qr.orderId}/status`, { status: s })).status).toBe(200);
    // Kitchen can't see money.
    expect((await kitchen("GET", "/bills")).status).toBe(403);

    // 5. Manager takes a staff order for Table 2, then bills it in cash with a customer.
    const so = { clientId: crypto.randomUUID(), orderNo: "S1", table: "T2", tableName: "Table 2", createdAt: new Date().toISOString(), items: [{ itemId: tea.id, name: "Tea", qty: 4, rate: tea.variants[0].price }] };
    expect((await manager("POST", "/orders", { orders: [so] })).body.results[0].ok).toBe(true);
    const cust = { clientId: crypto.randomUUID(), name: "Arjun", phone: "9822233344" };
    const cashBill = crypto.randomUUID();
    await manager("POST", "/bills", { bills: [{ clientId: cashBill, billNo: "M-1", createdAt: new Date().toISOString(), paymentMode: "cash", customer: cust, table: "Table 2", orderIds: [so.clientId], items: so.items }] });

    // 6. A counter udhar bill, and a part payment later.
    const udharBill = crypto.randomUUID();
    await owner("POST", "/bills", { bills: [{ clientId: udharBill, billNo: "O-1", createdAt: new Date().toISOString(), paymentMode: "credit", paidNow: 50, customer: cust, items: [{ itemId: dal.id, name: "Dal Tadka", variant: "Full", qty: 2, rate: 150 }] }] });
    const customers = (await owner("GET", "/customers")).body.customers;
    const arjun = customers.find((x) => x.clientId === cust.clientId);
    expect(arjun.due).toBe(250);
    await manager("POST", `/customers/${arjun.id}/payments`, { amount: 100, mode: "upi" });
    expect((await owner("GET", "/customers")).body.customers.find((x) => x.clientId === cust.clientId).due).toBe(150);
    expect(customers.some((x) => x.phone === "9811122233")).toBe(true); // QR customer saved too

    // 7. Everything adds up: bills list vs dashboard.
    const bills = (await owner("GET", `/bills?from=${today}&to=${today}&limit=500`)).body.bills;
    const billSum = bills.reduce((s, b) => s + b.total, 0);
    const teaTotal = 4 * tea.variants[0].price;
    expect(billSum).toBe(300 + teaTotal + 300); // P-1 (2 dal) + Table 2 tea + udhar 2 dal
    const dash = (await owner("GET", `/analytics?from=${today}&to=${today}`)).body;
    expect(dash.totals.sales).toBe(billSum);
    expect(dash.totals.bills).toBe(3);

    // 8. Kitchen stock went down by recipe for 4 Full dal and 4 teas (once each, not twice).
    const after = (await owner("GET", "/kitchen/ingredients")).body.ingredients;
    const toor = after.find((i) => i.name === "Toor dal");
    expect(toor.stock).toBeCloseTo(5 - 4 * 0.07, 3);

    // 9. Delete the udhar bill → dashboard and dues drop; restore → back.
    const ub = bills.find((b) => b.clientId === udharBill);
    await owner("POST", `/bills/${ub.id}/delete`, { reason: "wrong" });
    expect((await owner("GET", `/analytics?from=${today}&to=${today}`)).body.totals.sales).toBe(billSum - 300);
    expect((await owner("GET", "/customers")).body.customers.find((x) => x.clientId === cust.clientId).due).toBe(-100);
    await owner("POST", `/bills/${ub.id}/restore`, {});
    expect((await owner("GET", `/analytics?from=${today}&to=${today}`)).body.totals.sales).toBe(billSum);

    // 10. Manager writes an expense; it lowers profit.
    await manager("POST", "/expenses", { date: today, category: "Gas", amount: 950 });
    const dash2 = (await owner("GET", `/analytics?from=${today}&to=${today}`)).body;
    expect(dash2.totals.expenses).toBeGreaterThanOrEqual(950);
    expect(dash2.totals.profit).toBe(Math.round((dash2.totals.sales - dash2.totals.expenses) * 100) / 100);

    // 11. Attendance for the month, pay everyone, close the month.
    await owner("PUT", "/staff/attendance/bulk", { staffIds: [cook.id, mgr.id], from: `${month}-01`, to: today, status: "present" });
    const sal = (await owner("GET", `/staff/attendance?month=${month}`)).body;
    const due = [cook, mgr].map((w) => ({ staffId: w.id, amount: sal.salary[w.id].payable })).filter((p) => p.amount > 0);
    expect(due.length).toBe(2);
    expect((await owner("POST", "/staff/pay-all", { month, date: today, mode: "cash", payments: due })).status).toBe(200);
    expect((await owner("GET", `/staff/attendance?month=${month}`)).body.summary.due).toBe(0);
    await owner("POST", `/staff/months/${month}/close`);
    expect((await owner("PUT", "/staff/attendance", { staffId: cook.id, date: today, status: "absent" })).status).toBe(409);

    // 12. Bill changes are audited with names.
    const changes = (await owner("GET", `/bills/changes?from=${today}&to=${today}`)).body;
    expect(changes.items.map((x) => x.action).sort()).toEqual(["delete", "restore"]);
  });
});
