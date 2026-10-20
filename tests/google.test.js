import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, maskEmail;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "google-test";
  process.env.JWT_SECRET = "google-test-secret-google-test";
  delete process.env.OTP_DEV_LOG;
  ({ closeDb, getDb } = await import("../server/db.js"));
  // Credentials in tests are "google:<email>"; anything else is rejected like a bad signature.
  const { setTestVerifier, GoogleError } = await import("../server/google.js");
  setTestVerifier(async (c) => {
    if (!c.startsWith("google:")) throw new GoogleError("Google sign-in failed. Please try again.");
    return { email: c.slice(7).toLowerCase(), name: "Google Name" };
  });
  ({ maskEmail } = await import("../server/routes/auth.js"));
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

function client(headers = {}) {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie, ...headers }, body: body && JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}

const signup = (email, phone = "9876543210") => ({ shopName: "Dhaba", name: "Owner", phone, email, password: "secret12" });

describe("Sign in with Google", () => {
  it("advertises Google in /auth/config", async () => {
    expect((await client()("GET", "/auth/config")).body.googleClientId).toBeTruthy();
  });

  it("tells the client there's no shop yet, then signs up without an email code", async () => {
    const c = client();
    const r = await c("POST", "/auth/google", { credential: "google:New@Gmail.com" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "NO_ACCOUNT", email: "new@gmail.com", name: "Google Name" });

    const reg = await c("POST", "/auth/register", { ...signup("new@gmail.com"), googleCredential: "google:new@gmail.com" });
    expect(reg.status).toBe(201);
    const user = await (await getDb()).collection("users").findOne({ email: "new@gmail.com" });
    expect(user.emailVerified).toBe(true);
  });

  it("refuses a Google credential for a different email, and a bad one", async () => {
    const c = client();
    const r = await c("POST", "/auth/register", { ...signup("mine@gmail.com"), googleCredential: "google:other@gmail.com" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("other@gmail.com");
    expect((await c("POST", "/auth/google", { credential: "forged-credential" })).status).toBe(401);
  });

  it("logs an existing user in and lets them set a new password without the old one", async () => {
    await client()("POST", "/auth/register", signup("forgot@gmail.com"));
    const c = client();
    const r = await c("POST", "/auth/google", { credential: "google:forgot@gmail.com" });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: "forgot@gmail.com", canSetPassword: true });

    expect((await c("POST", "/auth/password", { password: "brandnew1" })).status).toBe(200);
    expect((await c("GET", "/auth/me")).body.user.canSetPassword).toBe(false);
    // The window closes after one change.
    expect((await c("POST", "/auth/password", { password: "another1" })).status).toBe(400);
    expect((await client()("POST", "/auth/login", { email: "forgot@gmail.com", password: "brandnew1" })).status).toBe(200);
  });

  it("still needs the current password outside the reset window", async () => {
    const c = client();
    await c("POST", "/auth/register", signup("normal@gmail.com"));
    expect((await c("POST", "/auth/password", { password: "brandnew1" })).body.error).toMatch(/current password/i);
    await (await getDb()).collection("users").updateOne({ email: "normal@gmail.com" }, { $set: { passwordResetUntil: new Date(Date.now() - 1000) } });
    expect((await c("POST", "/auth/password", { password: "brandnew1" })).status).toBe(400);
    expect((await c("POST", "/auth/password", { current: "secret12", password: "brandnew1" })).status).toBe(200);
  });
});

describe("Forgot email", () => {
  it("masks emails", () => {
    expect(maskEmail("vishwas@gmail.com")).toBe("vis***@gmail.com");
    expect(maskEmail("ab@x.in")).toBe("ab***@x.in");
  });

  it("finds accounts by phone however it was typed", async () => {
    await client()("POST", "/auth/register", signup("phone.owner@gmail.com", "+91 91234-56789"));
    const r = await client({ "x-forwarded-for": "10.0.0.1" })("POST", "/auth/find-email", { phone: "9123456789" });
    expect(r.status).toBe(200);
    expect(r.body.accounts).toEqual([{ email: "pho***@gmail.com", shop: "Dhaba" }]);
    expect((await client({ "x-forwarded-for": "10.0.0.1" })("POST", "/auth/find-email", { phone: "9000000000" })).status).toBe(404);
    expect((await client()("POST", "/auth/find-email", { phone: "123" })).status).toBe(400);
  });

  it("limits lookups per phone", async () => {
    const c = client({ "x-forwarded-for": "10.0.0.2" });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await c("POST", "/auth/find-email", { phone: "9555555555" })).status);
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses[5]).toBe(429);
  });
});
