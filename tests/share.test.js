// Link previews: WhatsApp's bot gets the shop's name and logo for a shared order link.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "share-test";
  process.env.JWT_SECRET = "share-test-secret-share-test-secret";
  delete process.env.OTP_DEV_LOG;
  delete process.env.APP_URL;
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

describe("order link preview", () => {
  let token, shops;
  const page = (path) => fetch(base + path).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), text: await r.text() }));

  beforeAll(async () => {
    let cookie = "";
    const r = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.1" }, body: JSON.stringify({ shopName: "Grill & <Hive>", name: "Owner", phone: "9876543215", email: "share@test.local", password: "secret12" }) });
    cookie = r.headers.get("set-cookie").split(";")[0];
    const shopId = (await r.json()).shop.id;
    const { ObjectId } = await import("mongodb");
    shops = (await getDb()).collection("shops");
    await shops.updateOne({ _id: new ObjectId(shopId) }, { $set: { subscription: { plan: "monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 864e5) }, address: 'MG Road "near park"' } });
    token = (await (await fetch(base + "/shop/order-token", { method: "POST", headers: { cookie } })).json()).orderToken;
  });

  it("names the shop, escaped, with the app icon when there's no logo", async () => {
    const r = await page(`/share/order/${token}`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/html/);
    expect(r.text).toContain("<title>Grill &amp; &lt;Hive&gt;</title>");
    expect(r.text).toContain('property="og:title" content="Grill &amp; &lt;Hive&gt;"');
    expect(r.text).toContain("Order online from Grill &amp; &lt;Hive&gt; · MG Road &quot;near park&quot;");
    expect(r.text).toMatch(/og:image" content="http:\/\/[^"]+\/apple-touch-icon\.png"/);
    expect(r.text).not.toContain("<Hive>");
  });

  it("uses the shop's logo, and the code from the link", async () => {
    await shops.updateOne({ orderToken: token }, { $set: { logo: `data:image/png;base64,${PNG.toString("base64")}` } });
    const r = await page(`/share/order/${token}?code=vip7k2q&t=T1`);
    expect(r.text).toMatch(new RegExp(`og:image" content="http://[^"]+/api/public/shop/${token}/logo\\?v=[0-9a-f]{10}"`));
    expect(r.text).toContain("Your code VIP7K2Q is ready");
    expect(r.text).toMatch(new RegExp(`og:url" content="http://[^"]+/order/${token}\\?code=vip7k2q&amp;t=T1"`));
  });

  it("serves the logo as a picture", async () => {
    const r = await fetch(base + `/public/shop/${token}/logo`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
    await shops.updateOne({ orderToken: token }, { $set: { logo: "" } });
    expect((await fetch(base + `/public/shop/${token}/logo`)).status).toBe(404);
  });

  it("an unknown link still gets a plain page", async () => {
    const r = await page("/share/order/nope-nope-nope-nope-1");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<title>Order online</title>");
    expect((await fetch(base + "/public/shop/bad/logo")).status).toBe(404);
  });
});
