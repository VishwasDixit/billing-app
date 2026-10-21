import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, images;
const calls = []; // Pexels queries actually sent
const photos = (n, start = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: start + i,
    alt: "food",
    photographer: "Cook " + (start + i),
    photographer_url: "https://www.pexels.com/@cook",
    url: `https://www.pexels.com/photo/${start + i}/`,
  }));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "images-test";
  process.env.JWT_SECRET = "images-test-secret-images-test";
  process.env.PEXELS_API_KEY = "test-key";
  ({ closeDb, getDb } = await import("../server/db.js"));
  images = await import("../server/routes/images.js");
  // Few results for the "indian food" query of "rare dish", plenty otherwise.
  images.setTestFetch(async (url, opts) => {
    if (url.startsWith("https://commons.wikimedia.org/")) {
      expect(opts.headers["User-Agent"]).toMatch(/BizoraBilling/);
      const q = new URL(url).searchParams.get("gsrsearch");
      calls.push("commons:" + q);
      const page = (i, mime = "image/jpeg") => ({
        pageid: 500 + i,
        index: i,
        title: `File:Dal Makhani ${i}.jpg`,
        imageinfo: [
          {
            mime,
            thumburl: `https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/Dal_Makhani_${i}.jpg/330px-Dal_Makhani_${i}.jpg?utm_source=x`,
            descriptionurl: `https://commons.wikimedia.org/wiki/File:Dal_Makhani_${i}.jpg`,
            extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Cook">Cook</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } },
          },
        ],
      });
      const pages = Object.fromEntries([...Array(7)].map((_, i) => [500 + i, page(i)]).concat([[999, { ...page(9, "image/svg+xml"), pageid: 999 }]]));
      return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
    }
    expect(opts.headers.Authorization).toBe("test-key");
    const q = new URL(url).searchParams.get("query");
    calls.push(q);
    if (q.startsWith("busy")) return new Response("{}", { status: 429 });
    const n = q === "rare dish indian food" ? 2 : 10;
    return new Response(JSON.stringify({ photos: photos(n, calls.length * 100) }), { status: 200 });
  });
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  images?.setTestFetch(null);
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
async function shopClient(email) {
  const c = client();
  const r = await c("POST", "/auth/register", { shopName: "Dhaba", name: "Owner", phone: "9876543210", email, password: "secret12" });
  expect(r.status).toBe(201);
  return c;
}

describe("smart dish queries", () => {
  it("cleans sizes and extras out of dish names", () => {
    expect(images.cleanDish("Dal Makhani (Full)")).toBe("dal makhani");
    expect(images.cleanDish("Masala Chai 150ml")).toBe("masala chai");
    expect(images.cleanDish("Spl. Veg Thali - 2 pcs")).toBe("veg thali");
    expect(images.queriesFor("Dal Makhani (Full)", "Dal Special")).toEqual(["dal makhani indian food", "dal makhani", "dal indian food"]);
  });
});

describe("photo search", () => {
  it("searches, returns direct Pexels links, and caches for everyone", async () => {
    const a = await shopClient("img-a@x.test");
    const r = await a("GET", "/images/search?q=" + encodeURIComponent("Paneer Tikka (Half)"));
    expect(r.status).toBe(200);
    expect(r.body.query).toBe("paneer tikka indian food");
    expect(r.body.results).toHaveLength(10);
    expect(r.body.results[0].url).toMatch(images.PEXELS_PHOTO_URL);
    const sent = calls.length;
    const b = await shopClient("img-b@x.test");
    expect((await b("GET", "/images/search?q=Paneer%20Tikka")).body.results).toHaveLength(10);
    expect(calls.length).toBe(sent); // served from the shared cache
  });

  it("falls back to a simpler query when there are too few photos", async () => {
    const c = await shopClient("img-c@x.test");
    const r = await c("GET", "/images/search?q=rare%20dish");
    expect(r.body.query).toBe("rare dish");
    expect(r.body.results).toHaveLength(10);
  });

  it("says when the library is busy, and limits searches per shop", async () => {
    const c = await shopClient("img-d@x.test");
    expect((await c("GET", "/images/search?q=busy")).status).toBe(429);
    const db = await getDb();
    const shopId = (await db.collection("users").findOne({ email: "img-d@x.test" })).shopId;
    await db.collection("rateLimits").updateOne({ _id: `img:shop:${shopId}` }, { $set: { hits: 60 } });
    const r = await c("GET", "/images/search?q=samosa");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Too many photo searches/);
  });
});

describe("Wikimedia Commons (no key needed)", () => {
  it("searches Commons when there is no Pexels key, with author and licence", async () => {
    const saved = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    try {
      expect(images.queriesFor("Dal Makhani (Full)", "Dal Special")).toEqual(["dal makhani", "dal makhani food", "dal food"]);
      expect(images.queriesFor("Chhola Bhatura")).toEqual(["chhola bhatura", "chole bhature", "chole bhature food"]);
      expect(images.commonSpelling("pyaj pakode")).toBe("onion pakora");
      const c = await shopClient("img-wiki@x.test");
      const r = await c("GET", "/images/search?q=Dal%20Makhani");
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("wikimedia");
      expect(calls.at(-1)).toBe("commons:dal makhani filetype:bitmap");
      expect(r.body.results).toHaveLength(7); // the SVG drawing is skipped
      const first = r.body.results[0];
      expect(first.url).toBe("https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3e/Dal_Makhani_0.jpg/330px-Dal_Makhani_0.jpg");
      expect(first.author).toBe("Cook (CC BY-SA 4.0)");

      const item = (await c("GET", "/menu")).body[0];
      const put = await c("PUT", `/menu/${item.id}`, { image: first.url, imageCredit: { author: first.author, url: first.pexelsUrl } });
      expect(put.status).toBe(200);
      expect(put.body.imageCredit.url).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      expect((await c("PUT", `/menu/${item.id}`, { image: "https://upload.wikimedia.org/evil.jpg" })).status).toBe(400);
    } finally {
      process.env.PEXELS_API_KEY = saved;
    }
  });
});

describe("saving library photos on menu items", () => {
  it("saves only the link and credit, rejects other sites, and frees an uploaded photo", async () => {
    const c = await shopClient("img-e@x.test");
    const item = (await c("GET", "/menu")).body[0];
    // An uploaded photo first (tiny valid PNG header).
    const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.alloc(20)]).toString("base64");
    expect((await c("PUT", `/menu/${item.id}/image`, { dataUrl: png })).status).toBe(200);
    const db = await getDb();
    expect(await db.collection("menuImages").countDocuments()).toBe(1);

    const link = "https://images.pexels.com/photos/123/pexels-photo-123.jpeg?auto=compress&cs=tinysrgb&w=400&h=400&fit=crop";
    const r = await c("PUT", `/menu/${item.id}`, { image: link, imageCredit: { author: "Cook", url: "https://www.pexels.com/photo/123/" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ image: link, imageCredit: { author: "Cook" } });
    expect(await db.collection("menuImages").countDocuments()).toBe(0);

    expect((await c("PUT", `/menu/${item.id}`, { image: "https://evil.example/x.jpg" })).status).toBe(400);
    // Back to the drawn picture clears the credit.
    const d = await c("DELETE", `/menu/${item.id}/image`);
    expect(d.body.imageCredit).toBeNull();
  });

  it("suggests a photo for each item in one call", async () => {
    const c = await shopClient("img-f@x.test");
    const menu = (await c("GET", "/menu")).body.slice(0, 3);
    const r = await c("POST", "/images/bulk-suggest", { itemIds: menu.map((m) => m.id) });
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toHaveLength(3);
    expect(r.body.suggestions[0]).toMatchObject({ itemId: menu[0].id, name: menu[0].name });
    expect(r.body.suggestions[0].photo.url).toMatch(images.PEXELS_PHOTO_URL);
  });
});
