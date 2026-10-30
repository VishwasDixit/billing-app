// Promo codes sent to chosen customers on WhatsApp (Customers › Send offer): only their mobiles
// can use the code, it isn't advertised on the menu, and more customers can be added later.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import { checkPromo, fillName, offerText } from "../shared/promo.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "promo-invite-test";
  process.env.JWT_SECRET = "promo-invite-test-secret-promo-invite";
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
function client(ip = `10.8.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

describe("invite-only rules", () => {
  const p = { code: "VIP7K2Q", active: true, type: "percent", value: 10, maxDiscount: 100, minOrder: 0, phones: ["9876500001"] };
  it("needs an invited mobile", () => {
    expect(checkPromo(p, { subtotal: 500, where: "qr" }).reason).toMatch(/Enter your mobile/);
    expect(checkPromo(p, { subtotal: 500, where: "billing" }).reason).toMatch(/Add the customer's mobile/);
    expect(checkPromo(p, { subtotal: 500, where: "qr", phone: "9876500002" }).reason).toMatch(/isn't for this mobile/);
    expect(checkPromo(p, { subtotal: 500, where: "qr", phone: "9876500001" })).toEqual({ ok: true, amount: 50 });
    expect(checkPromo({ ...p, phones: [] }, { subtotal: 500, where: "qr" }).ok).toBe(true);
  });

  it("writes the WhatsApp message", () => {
    const t = offerText({ ...p, minOrder: 300, validTo: "2026-11-06" }, "Rooftop Cafe", { link: "https://x.test/order/abc?code=VIP7K2Q" });
    expect(t).toContain("*VIP7K2Q*");
    expect(t).toContain("10% off up to ₹100");
    expect(t).toContain("min order ₹300");
    expect(t).toContain("6 Nov 2026");
    expect(t).toContain("https://x.test/order/abc?code=VIP7K2Q");
    expect(fillName(t, "Ravi Kumar")).toMatch(/^Hi Ravi!/);
    expect(offerText(p, "Cafe")).toContain("at the counter");
  });
});

describe("codes for invited customers", () => {
  let c, token, tea, promo;
  const item = () => [{ itemId: tea.id, variant: tea.variants[0].label, qty: 5 }];
  const tryCode = (phone) => client()("POST", `/public/shop/${token}/promo`, { code: "VIPONLY", items: item(), phone, table: "T1" });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Invite Cafe", name: "Owner", phone: "9876543213", email: "invite@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    await (await getDb()).collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
  });

  it("saves the mobiles cleaned, and never shows the code on the menu", async () => {
    const r = await c("POST", "/promos", { code: "vipOnly", type: "flat", value: 20, phones: ["+91 98765 00001", "09876500001", "12345", "9876500003"], showOnMenu: true });
    expect(r.status).toBe(200);
    promo = r.body.promo;
    expect(promo.phones).toEqual(["9876500001", "9876500003"]);
    expect(promo.showOnMenu).toBe(false);
    const menu = (await client()("GET", `/public/shop/${token}?t=T1`)).body;
    expect((menu.offers || []).map((o) => o.code)).not.toContain("VIPONLY");
  });

  it("works only for those mobiles", async () => {
    expect((await tryCode("9876500001")).body.amount).toBe(20);
    const no = await tryCode("9876500002");
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/isn't for this mobile/);
    expect((await tryCode("")).body.error).toMatch(/Enter your mobile/);

    const order = (phone) => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Ravi", phone, items: item(), promo: "VIPONLY" });
    expect((await order("9876500002")).status).toBe(400);
    const ok = await order("98765 00003");
    expect(ok.status).toBe(200);
    expect(ok.body.promo?.code).toBe("VIPONLY");
  });

  it("more customers can be invited later", async () => {
    const r = await c("POST", `/promos/${promo.id}/invite`, { phones: ["9876500002", "9876500001"] });
    expect(r.status).toBe(200);
    expect(r.body.promo.phones.sort()).toEqual(["9876500001", "9876500002", "9876500003"]);
    expect((await tryCode("9876500002")).body.amount).toBe(20);
  });

  it("billing needs the customer's invited mobile", async () => {
    const check = (phone) => c("POST", "/promos/check", { code: "VIPONLY", subtotal: 200, phone });
    expect((await check(undefined)).body.error).toMatch(/Add the customer's mobile/);
    expect((await check("9999999999")).status).toBe(400);
    expect((await check("+91 98765 00001")).body.amount).toBe(20);
  });

  it("editing keeps the list; clearing it opens the code to everyone", async () => {
    const body = { code: "VIPONLY", type: "flat", value: 25, phones: ["9876500001", "9876500002", "9876500003"] };
    expect((await c("PUT", `/promos/${promo.id}`, body)).body.promo.phones).toHaveLength(3);
    await c("PUT", `/promos/${promo.id}`, { ...body, phones: [] });
    expect((await tryCode("9000000000")).body.amount).toBe(25);
    // An open code stays open when "invited".
    expect((await c("POST", `/promos/${promo.id}/invite`, { phones: ["9876500004"] })).body.promo.phones).toEqual([]);
  });
});
