// Auto WhatsApp (coupons, new dishes, announcements, we miss you) with Meta's API faked, the
// STOP/START webhook, and the Instagram story reward code.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { istDay } from "../shared/hours.js";
import { addDays } from "../shared/loyalty.js";

let mongod, server, base, closeDb, getDb, wa, mk;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "marketing-test";
  process.env.JWT_SECRET = "marketing-test-secret-marketing-test";
  process.env.WHATSAPP_FAKE = "1";
  process.env.WHATSAPP_APP_SECRET = "test-app-secret";
  process.env.WHATSAPP_VERIFY_TOKEN = "test-verify";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  const { handle } = await import("../server/router.js");
  wa = await import("../server/whatsapp.js");
  mk = await import("../server/marketing.js");
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
  return async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip, ...headers }, body: typeof body === "string" ? body : body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, body: json };
  };
}

const at = (hour, day = istDay()) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+05:30`);

describe("WhatsApp helpers", () => {
  it("fills templates and cleans parameters", () => {
    expect(wa.renderTemplate("news", ["Asha", "Grill Hive", "Now open\nfor delivery", "https://x/order/abc"])).toBe("Hi Asha! 📣 News from Grill Hive: Now open for delivery See the menu: https://x/order/abc Thank you!");
    expect(wa.cleanParam("")).toBe("-");
  });

  it("checks Meta's webhook signature", () => {
    const raw = '{"a":1}';
    const sig = "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(raw).digest("hex");
    expect(wa.signatureOk(raw, sig)).toBe(true);
    expect(wa.signatureOk(raw + " ", sig)).toBe(false);
    expect(wa.signatureOk(raw, "sha256=00")).toBe(false);
  });

  it("knows quiet hours (9 pm to 10 am IST)", () => {
    expect(mk.quietNow(at(9))).toBe(true);
    expect(mk.quietNow(at(10))).toBe(false);
    expect(mk.quietNow(at(20))).toBe(false);
    expect(mk.quietNow(at(21))).toBe(true);
  });
});

describe("Auto WhatsApp", () => {
  let c, token, db, shop, tea;
  const order = (phone, extra = {}) => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: `Cust ${phone.slice(-2)}`, phone, items: [{ itemId: tea.id, variant: tea.variants[0].label, qty: 1 }], ...extra });
  const loadShop = async () => (shop = await db.collection("shops").findOne({ _id: shop._id }));
  const sentTo = (phone) => wa.fakeOutbox.filter((m) => m.to === `91${phone}`);

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Grill Hive", name: "Owner", phone: "9876543299", email: "grill@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    db = await getDb();
    shop = { _id: new ObjectId(r.body.shop.id) };
    await db.collection("shops").updateOne({ _id: shop._id }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
    // Seeded dishes are not "new this week".
    await db.collection("menuItems").updateMany({ shopId: shop._id }, { $set: { createdAt: new Date(Date.now() - 30 * 864e5) } });
  });

  it("asks customers in the cart only once the owner turns it on", async () => {
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.wa).toBe(false);
    const s = (await c("GET", "/auto-msg")).body;
    expect(s.status).toBe("ready");
    expect(s.settings.on).toBe(false);
    expect((await c("PUT", "/auto-msg", { ...s.settings, on: true, dishDay: new Date(istDay() + "T00:00:00Z").getUTCDay() })).status).toBe(200);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.wa).toBe(true);
  });

  it("only customers who ticked the box are contacts that can get messages", async () => {
    await order("9811100001", { waOptIn: true });
    await order("9811100002"); // didn't tick
    await order("9811100003", { waOptIn: true });
    const opted = await db.collection("waContacts").find({ shopId: shop._id, optIn: true }).toArray();
    expect(opted.map((x) => x.phone).sort()).toEqual(["9811100001", "9811100003"]);
    expect((await c("GET", "/auto-msg")).body.optedIn).toBe(2);
  });

  it("reminds about a running coupon, but not to someone who used it, and only once", async () => {
    expect((await c("POST", "/promos", { code: "WELCOME10", type: "percent", value: 10, maxDiscount: 50 })).status).toBe(200);
    const promo = await db.collection("promos").findOne({ shopId: shop._id, code: "WELCOME10" });
    await db.collection("promoUses").insertOne({ shopId: shop._id, promoId: promo._id, code: "WELCOME10", ref: "x", amount: 5, phone: "9811100003", at: new Date() });

    const preview = (await c("POST", "/auto-msg/preview", {})).body;
    expect(preview.list.map((m) => [m.phone, m.kind])).toEqual([["9811100001", "offer"]]);
    expect(preview.list[0].text).toMatch(/use code WELCOME10 for 10% off up to ₹50/);
    expect(preview.list[0].text).toContain(`/order/${token}?code=WELCOME10`);

    await loadShop();
    wa.fakeOutbox.length = 0;
    const run = await mk.runShop(db, shop, { now: at(11) });
    expect(run).toMatchObject({ sent: 1, failed: 0 });
    expect(sentTo("9811100001")[0].template.name).toBe("offer_reminder");
    expect((await mk.runShop(db, shop, { now: at(12) })).sent).toBe(0); // already sent
  });

  it("an announcement goes out even within the 3-day gap, then is marked sent", async () => {
    const a = (await c("POST", "/announcements", { text: "Now open for home delivery!", sendOn: istDay() })).body.announcement;
    expect(a.status).toBe("scheduled");
    expect((await c("POST", "/announcements", { text: "Too late for this", sendOn: addDays(istDay(), -1) })).status).toBe(400);
    wa.fakeOutbox.length = 0;
    const run = await mk.runShop(db, shop, { now: at(13) });
    expect(run.byKind.news).toBe(2);
    expect(sentTo("9811100001")[0].template.name).toBe("shop_news");
    const saved = await db.collection("announcements").findOne({ shopId: shop._id });
    expect(saved).toMatchObject({ status: "sent", sent: 2 });
  });

  it("new dishes go out on the chosen weekday, once that week", async () => {
    await db.collection("waContacts").updateMany({ shopId: shop._id }, { $set: { lastSentAt: new Date(Date.now() - 5 * 864e5) } });
    await db.collection("menuItems").insertOne({ shopId: shop._id, name: "Peri Peri Wings", category: "Starters", variants: [{ label: "", price: 199 }], active: true, createdAt: new Date() });
    wa.fakeOutbox.length = 0;
    const run = await mk.runShop(db, shop, { now: at(14) });
    expect(run.byKind.dishes).toBe(2);
    expect(JSON.stringify(sentTo("9811100003")[0])).toContain("Peri Peri Wings");
    await db.collection("waContacts").updateMany({ shopId: shop._id }, { $set: { lastSentAt: new Date(Date.now() - 5 * 864e5) } });
    expect((await mk.runShop(db, shop, { now: at(15) })).byKind.dishes).toBe(0);
  });

  it("says we miss you after the chosen days away, once per absence", async () => {
    const long = new Date(Date.now() - 40 * 864e5);
    await db.collection("orders").updateMany({ shopId: shop._id, customerPhone: "9811100003" }, { $set: { createdAt: long } });
    await db.collection("waContacts").updateOne({ shopId: shop._id, phone: "9811100003" }, { $set: { lastOrderAt: long, lastSentAt: new Date(Date.now() - 5 * 864e5) } });
    wa.fakeOutbox.length = 0;
    const run = await mk.runShop(db, shop, { now: at(16) });
    expect(sentTo("9811100003").map((m) => m.template.name)).toEqual(["we_miss_you"]);
    expect(run.byKind.miss).toBe(1);
    await db.collection("waContacts").updateOne({ shopId: shop._id, phone: "9811100003" }, { $set: { lastSentAt: new Date(Date.now() - 5 * 864e5) } });
    expect((await mk.runShop(db, shop, { now: at(17) })).byKind.miss).toBe(0);
  });

  it("the daily run skips quiet hours, and Run now refuses them", async () => {
    expect(await mk.runMarketing(db, { now: at(22) })).toEqual({ skipped: "quiet hours" });
  });

  it("STOP and START replies on WhatsApp opt out and back in (signed by Meta)", async () => {
    const hook = (text, sigOk = true) => {
      const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "919811100001", type: "text", text: { body: text } }] } }] }] });
      const sig = "sha256=" + crypto.createHmac("sha256", sigOk ? "test-app-secret" : "wrong").update(raw).digest("hex");
      return client()("POST", "/whatsapp/webhook", raw, { "x-hub-signature-256": sig });
    };
    expect((await client()("GET", "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=42")).body).toBe(42);
    expect((await client()("GET", "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")).status).toBe(403);
    expect((await hook("STOP", false)).status).toBe(401);
    expect((await hook("Stop")).status).toBe(200);
    let ct = await db.collection("waContacts").findOne({ shopId: shop._id, phone: "9811100001" });
    expect(ct.optIn).toBe(false);
    expect(ct.optOutAt).toBeTruthy();
    const p = (await c("POST", "/auto-msg/preview", {})).body;
    expect(p.list.some((m) => m.phone === "9811100001")).toBe(false);
    await hook("START");
    ct = await db.collection("waContacts").findOne({ shopId: shop._id, phone: "9811100001" });
    expect(ct.optIn).toBe(true);
    expect(ct.optOutAt).toBeNull();
  });

  it("staff can stop a customer's messages, but not turn them on", async () => {
    expect((await c("PUT", "/wa-contacts/9811100003", { optIn: true })).status).toBe(400);
    expect((await c("PUT", "/wa-contacts/9811100003", { optIn: false })).body).toEqual({ optIn: false, optedOut: true });
    expect((await c("GET", "/wa-contacts/9811100003")).body).toMatchObject({ optIn: false, optedOut: true });
  });
});

describe("Instagram story reward", () => {
  let c, token, db, tea;
  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Insta Cafe", name: "Owner", phone: "9876543288", email: "insta@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    db = await getDb();
    await db.collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
  });

  it("is off until set up, and needs the Instagram name", async () => {
    expect((await c("POST", "/insta-reward", { phone: "9822200001" })).status).toBe(400);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.insta).toBeNull();
    expect((await c("PUT", "/shop", { insta: { on: true, handle: "", maxDiscount: 99, validDays: 30 } })).status).toBe(400);
    const saved = await c("PUT", "/shop", { insta: { on: true, handle: "@grill.hive", maxDiscount: 99, validDays: 30 } });
    expect(saved.body.insta.handle).toBe("grill.hive");
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.insta).toEqual({ handle: "grill.hive", max: 99 });
  });

  it("gives one free-meal code per mobile: up to ₹99, that mobile only, once", async () => {
    const r = (await c("POST", "/insta-reward", { phone: "+91 98222 00001" })).body;
    expect(r).toMatchObject({ maxDiscount: 99, already: false, used: false });
    expect(r.code).toMatch(/^INSTA[A-Z0-9]{5}$/);
    expect(r.validTo).toBe(addDays(istDay(), 29));
    const again = (await c("POST", "/insta-reward", { phone: "9822200001" })).body;
    expect(again).toMatchObject({ code: r.code, already: true });
    expect((await c("GET", "/promos")).body.promos.map((p) => p.code)).not.toContain(r.code);

    const price = tea.variants[0].price;
    const qty = Math.ceil(300 / price);
    const check = (phone, q) => client()("POST", `/public/shop/${token}/promo`, { code: r.code, items: [{ itemId: tea.id, variant: tea.variants[0].label, qty: q }], phone, table: "T1" });
    expect((await check("9822200009", 1)).status).toBe(400); // another mobile
    expect((await check("9822200001", 1)).body.amount).toBe(price); // the whole meal, under ₹99
    expect((await check("9822200001", qty)).body.amount).toBe(99);
    const place = () => client()("POST", `/public/shop/${token}/orders`, { table: "T1", name: "Story Fan", phone: "9822200001", items: [{ itemId: tea.id, variant: tea.variants[0].label, qty }], promo: r.code });
    expect((await place()).body.promo).toEqual({ code: r.code, amount: 99 });
    expect((await place()).status).toBe(400);
    expect((await c("POST", "/insta-reward", { phone: "9822200001" })).body).toMatchObject({ already: true, used: true });
  });
});
