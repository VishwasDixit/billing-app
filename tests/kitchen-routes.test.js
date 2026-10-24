// Kitchen stock and recipe screens, and the morning kitchen email.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, mailer;
const sent = [];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "kitchen-routes-test";
  process.env.JWT_SECRET = "kitchen-routes-secret-kitchen-routes";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  mailer = await import("../server/otp/mailer.js");
  const { handle } = await import("../server/router.js");
  server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
  mailer?.setTestTransport(null);
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

async function owner(email) {
  const c = client();
  await c("POST", "/auth/register", { shopName: "Kitchen Routes", name: "Owner", phone: "9876543210", email, password: "secret12" });
  return c;
}
const move = (m) => ({ clientId: crypto.randomUUID(), ...m });
// Runs the morning job with a fake mailbox (turned on only here: it also switches on sign-up codes).
async function morning() {
  const { dailyKitchenCheck } = await import("../server/kitchen/daily.js");
  sent.length = 0;
  mailer.setTestTransport(async (m) => sent.push(m));
  try {
    return await dailyKitchenCheck(await getDb());
  } finally {
    mailer.setTestTransport(null);
  }
}

describe("kitchen stock items", () => {
  it("adds, refuses duplicates, edits (unit change converts stock) and deletes", async () => {
    const c = await owner("items@k.test");
    const add = await c("POST", "/kitchen/ingredients", { name: "Kaju", category: "Dry fruits", unit: "kg", minStock: 0.5, costPerUnit: 900 });
    expect(add.status).toBe(200);
    expect((await c("POST", "/kitchen/ingredients", { name: "kaju", unit: "kg" })).status).toBe(409);
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: add.body.id, type: "purchase", qty: 2, unit: "kg" })] });

    const ed = await c("PUT", `/kitchen/ingredients/${add.body.id}`, { unit: "g" });
    expect(ed.body).toMatchObject({ unit: "g", stock: 2000, minStock: 500, costPerUnit: 0.9 });
    expect((await c("PUT", `/kitchen/ingredients/${add.body.id}`, { unit: "L" })).status).toBe(400);

    expect((await c("DELETE", `/kitchen/ingredients/${add.body.id}`)).status).toBe(200);
    expect((await c("DELETE", `/kitchen/ingredients/${add.body.id}`)).status).toBe(404);
  });

  it("won't delete an item a recipe uses", async () => {
    const c = await owner("inuse@k.test");
    const dal = (await c("GET", "/menu")).body.find((m) => m.name === "Dal Tadka");
    await c("POST", "/kitchen/recipes/standard", { itemIds: [dal.id] });
    const toor = (await c("GET", "/kitchen/ingredients")).body.ingredients.find((i) => i.name === "Toor dal");
    const r = await c("DELETE", `/kitchen/ingredients/${toor.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/used in 1 recipe/);
  });
});

describe("recipes", () => {
  it("saves a custom recipe, checks units and ingredients, and deletes it", async () => {
    const c = await owner("recipe@k.test");
    const tea = (await c("GET", "/menu")).body.find((m) => m.name === "Tea");
    await c("POST", "/kitchen/ingredients/starter", { names: ["Milk", "Sugar", "Tea leaves"] });
    const ings = (await c("GET", "/kitchen/ingredients")).body.ingredients;
    const id = (n) => ings.find((i) => i.name === n).id;
    const ok = await c("PUT", `/kitchen/recipes/${tea.id}`, {
      variants: { "": [{ ingredientId: id("Milk"), qty: 100, unit: "ml" }, { ingredientId: id("Sugar"), qty: 10, unit: "g" }] },
      steps: [{ text: "Boil milk", minutes: 3 }],
    });
    expect(ok.status).toBe(200);
    const got = (await c("GET", `/kitchen/recipes/${tea.id}`)).body.recipe;
    expect(got.steps[0].text).toBe("Boil milk");
    // Milk in kg? No: milk is kept in litres.
    expect((await c("PUT", `/kitchen/recipes/${tea.id}`, { variants: { "": [{ ingredientId: id("Milk"), qty: 1, unit: "kg" }] } })).body.error).toMatch(/kept in L/);
    // An ingredient from nowhere.
    expect((await c("PUT", `/kitchen/recipes/${tea.id}`, { variants: { "": [{ ingredientId: "6a0000000000000000000000", qty: 1, unit: "g" }] } })).status).toBe(400);
    expect((await c("DELETE", `/kitchen/recipes/${tea.id}`)).status).toBe(200);
    expect((await c("GET", `/kitchen/recipes/${tea.id}`)).body.recipe).toBeNull();
    expect((await c("DELETE", `/kitchen/recipes/${tea.id}`)).status).toBe(404);
  });
});

describe("alerts and the morning email", () => {
  it("dismisses an alert and emails the owner the morning list", async () => {
    const c = await owner("morning@k.test");
    await c("POST", "/kitchen/ingredients/starter", { names: ["Paneer"] });
    const paneer = (await c("GET", "/kitchen/ingredients")).body.ingredients[0];
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: paneer.id, type: "purchase", qty: 1, unit: "kg", cost: 400 })] });
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: paneer.id, type: "waste", qty: 0.6, unit: "kg", reason: "spoiled" })] });
    const alerts = (await c("GET", "/kitchen/alerts")).body.alerts;
    expect(alerts.some((a) => a.type === "waste")).toBe(true);

    const r = await morning();
    expect(r.emailed).toBeGreaterThanOrEqual(1);
    const mail = sent.find((m) => m.to === "morning@k.test");
    expect(mail.subject).toMatch(/Kitchen Routes/);
    expect(mail.html).toMatch(/Paneer/);
    expect(mail.html).not.toMatch(/<script/i);

    const waste = alerts.find((a) => a.type === "waste");
    await c("POST", `/kitchen/alerts/${waste.id}/dismiss`);
    expect((await c("GET", "/kitchen/alerts")).body.alerts.some((a) => a.id === waste.id)).toBe(false);
  });

  it("escapes shop and item names in the email", async () => {
    const c = client();
    await c("POST", "/auth/register", { shopName: "<b>Evil</b>", name: "Owner", phone: "9876543210", email: "xss@k.test", password: "secret12" });
    await c("POST", "/kitchen/ingredients", { name: "<img src=x onerror=alert(1)>", unit: "kg", minStock: 5 });
    const i = (await c("GET", "/kitchen/ingredients")).body.ingredients[0];
    await c("POST", "/kitchen/moves", { moves: [move({ ingredientId: i.id, type: "purchase", qty: 1, unit: "kg" })] });
    await morning();
    const mail = sent.find((m) => m.to === "xss@k.test");
    expect(mail.html).not.toMatch(/<img src=x/);
    expect(mail.html).toMatch(/&lt;img/);
  });
});
