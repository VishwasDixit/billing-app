// Dice game: one throw a day per mobile and per phone, rolled on the server; a 7 wins a code for
// that mobile only, once, today. Also: WhatsApp links open at the customer's last table.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import { isWin, diceOfferText } from "../shared/dice.js";
import { withTable } from "../src/lib/orderLink.js";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "dice-test";
  process.env.JWT_SECRET = "dice-test-secret-dice-test-secret-dice";
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
function client(ip = `10.6.${(++ipN >> 8) & 255}.${ipN & 255}`) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

describe("rules and texts", () => {
  it("only a 7 wins", () => {
    expect(isWin([3, 4])).toBe(true);
    expect(isWin([6, 1])).toBe(true);
    expect(isWin([6, 6])).toBe(false);
    expect(diceOfferText({ percent: 50, minOrder: 120, maxDiscount: 100 })).toBe("50% off up to ₹100 on orders above ₹120");
  });

  it("puts the table in order links", () => {
    const t = "Order here: https://x.app/order/dMxuDnRzcLZGPnn_RNhnFw?code=VIP1 now";
    expect(withTable(t, "T 4")).toBe("Order here: https://x.app/order/dMxuDnRzcLZGPnn_RNhnFw?code=VIP1&t=T+4 now");
    expect(withTable("https://x.app/order/dMxuDnRzcLZGPnn_RNhnFw", "T1")).toBe("https://x.app/order/dMxuDnRzcLZGPnn_RNhnFw?t=T1");
    expect(withTable(t, "")).toBe(t);
  });
});

describe("dice game", () => {
  let c, token, db, tea;
  const throwDice = (phone, device = `dev${phone}xyz`) => client()("POST", `/public/shop/${token}/dice`, { phone, device });

  beforeAll(async () => {
    c = client();
    const r = await c("POST", "/auth/register", { shopName: "Dice Cafe", name: "Owner", phone: "9876543216", email: "dice@test.local", password: "secret12" });
    const { ObjectId } = await import("mongodb");
    db = await getDb();
    await db.collection("shops").updateOne({ _id: new ObjectId(r.body.shop.id) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } } });
    await c("PUT", "/shop", { tables: [{ id: "T1", name: "Table 1" }, { id: "T2", name: "Table 2" }], qrOrdering: true });
    token = (await c("POST", "/shop/order-token")).body.orderToken;
    tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
  });

  it("is off until the owner turns it on", async () => {
    expect((await throwDice("9876500101")).status).toBe(400);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.dice).toBeNull();
    expect((await c("PUT", "/shop", { dice: { on: true, percent: 50, minOrder: 120, maxDiscount: 100 } })).status).toBe(200);
    expect((await client()("GET", `/public/shop/${token}?t=T1`)).body.dice).toEqual({ percent: 50, minOrder: 120, maxDiscount: 100 });
  });

  it("needs a mobile, and gives one throw a day per mobile and per phone", async () => {
    expect((await throwDice("123")).status).toBe(400);
    const first = await throwDice("9876500102");
    expect(first.status).toBe(200);
    expect(first.body.already).toBe(false);
    expect(first.body.dice).toHaveLength(2);
    for (const d of first.body.dice) expect(d).toBeGreaterThanOrEqual(1), expect(d).toBeLessThanOrEqual(6);
    expect(first.body.win).toBe(first.body.dice[0] + first.body.dice[1] === 7);

    const again = await throwDice("9876500102", "otherdevice123");
    expect(again.body).toMatchObject({ already: true, dice: first.body.dice, mine: true });
    // Same phone, another mobile number: no second throw.
    const swap = await throwDice("9876500103", "dev9876500102xyz");
    expect(swap.body).toMatchObject({ already: true, mine: false, code: "" });
  });

  it("two taps at once still give one throw", async () => {
    const [a, b] = await Promise.all([throwDice("9876500104"), throwDice("9876500104")]);
    expect(a.body.dice).toEqual(b.body.dice);
    expect(await db.collection("diceRolls").countDocuments({ phone: "9876500104" })).toBe(1);
  });

  it("dice are fair: every face, about 1 in 6 sevens", async () => {
    const n = 1200;
    await db.collection("diceRolls").deleteMany({});
    const res = [];
    for (let i = 0; i < n; i += 40) res.push(...(await Promise.all(Array.from({ length: 40 }, (_, j) => throwDice(String(9000000000 + i + j))))));
    const faces = new Array(7).fill(0);
    let sevens = 0;
    for (const r of res) {
      expect(r.status).toBe(200);
      faces[r.body.dice[0]]++;
      faces[r.body.dice[1]]++;
      if (r.body.win) sevens++;
    }
    for (let f = 1; f <= 6; f++) expect(faces[f]).toBeGreaterThan(300); // expected 400 each
    expect(sevens).toBeGreaterThan(130); // expected 200
    expect(sevens).toBeLessThan(280);
  }, 60000);

  it("a win is a code for that mobile only, once, today, above the minimum", async () => {
    const win = await db.collection("diceRolls").findOne({ win: true });
    expect(win.code).toMatch(/^DICE[A-Z0-9]{5}$/);
    const code = win.code;
    const items = (qty) => [{ itemId: tea.id, variant: tea.variants[0].label, qty }];
    const price = tea.variants[0].price;
    const big = Math.ceil(300 / price);
    const check = (phone, qty) => client()("POST", `/public/shop/${token}/promo`, { code, items: items(qty), phone, table: "T1" });
    expect((await check("9876509999", big)).body.error).toMatch(/isn't for this mobile/);
    expect((await check(win.phone, 1)).status).toBe(400); // below ₹120
    const ok = await check(win.phone, big);
    expect(ok.body.amount).toBe(Math.min(100, (big * price) / 2));
    // Not in the owner's code list.
    expect((await c("GET", "/promos")).body.promos.map((p) => p.code)).not.toContain(code);

    const order = () => client()("POST", `/public/shop/${token}/orders`, { table: "T2", name: "Winner", phone: win.phone, items: items(big), promo: code });
    expect((await order()).body.promo?.code).toBe(code);
    expect((await order()).status).toBe(400); // used up
    const today = (await c("GET", "/dice/today")).body;
    expect(today.wins).toBeGreaterThan(0);
    expect(today.used).toBe(1);

    // Its link opens at the table they ordered from.
    expect((await c("GET", "/customers/last-tables")).body.tables[win.phone]).toBe("T2");
  });
});
