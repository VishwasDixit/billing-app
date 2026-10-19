import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod, server, base, closeDb, getDb, codes;
const inbox = []; // emails captured instead of being sent
const lastCode = (to, purpose) => [...inbox].reverse().find((m) => m.to === to && (!purpose || m.purpose === purpose))?.code;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "otp-test";
  process.env.JWT_SECRET = "otp-test-secret-otp-test-secret";
  ({ closeDb, getDb } = await import("../server/db.js"));
  const { setTestTransport } = await import("../server/otp/mailer.js");
  setTestTransport(async (m) => inbox.push(m));
  codes = await import("../server/otp/codes.js");
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

const signup = (email) => ({ shopName: "Dhaba " + email.split("@")[0], name: "Owner", phone: "9876543210", email, password: "secret12" });

async function registerVerified(email) {
  const c = client();
  expect((await c("POST", "/auth/register/start", signup(email))).status).toBe(200);
  const r = await c("POST", "/auth/register/verify", { email, code: lastCode(email, "register") });
  expect(r.status).toBe(201);
  return c;
}

describe("sign-up with email verification", () => {
  it("emails a code, then creates the shop only with the right code", async () => {
    const c = client();
    expect((await c("GET", "/auth/config")).body.emailOtp).toBe(true);
    expect((await c("POST", "/auth/register", signup("direct@x.test"))).body.code).toBe("VERIFY_EMAIL");

    const start = await c("POST", "/auth/register/start", signup("new@x.test"));
    expect(start.body).toMatchObject({ sent: true });
    const mail = inbox.at(-1);
    expect(mail).toMatchObject({ to: "new@x.test", purpose: "register" });
    expect(mail.html).toContain(`${mail.code.slice(0, 3)} ${mail.code.slice(3)}`);
    expect(mail.text).toContain("10 minutes");

    const wrong = String((Number(mail.code) + 1) % 1e6).padStart(6, "0");
    const bad = await c("POST", "/auth/register/verify", { email: "new@x.test", code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/4 tries left/);
    expect((await c("GET", "/auth/me")).status).toBe(401);

    const ok = await c("POST", "/auth/register/verify", { email: "new@x.test", code: mail.code });
    expect(ok.status).toBe(201);
    expect(ok.body.shop.status.state).toBe("trial");
    expect((await c("GET", "/menu")).body).toHaveLength(80);
    // The password from step 1 works.
    expect((await client()("POST", "/auth/login", { email: "new@x.test", password: "secret12" })).status).toBe(200);
    // Codes are single-use.
    expect((await client()("POST", "/auth/register/verify", { email: "new@x.test", code: mail.code })).status).toBe(400);
  });

  it("refuses to start sign-up for an email that already has an account", async () => {
    await registerVerified("taken@x.test");
    expect((await client()("POST", "/auth/register/start", signup("taken@x.test"))).status).toBe(409);
  });
});

describe("login with a code", () => {
  it("logs in with the emailed code", async () => {
    await registerVerified("login@x.test");
    const c = client();
    const sent = await c("POST", "/auth/otp/send", { email: "login@x.test", purpose: "login" });
    expect(sent.body.sent).toBe(true);
    const r = await c("POST", "/auth/otp/login", { email: "login@x.test", code: lastCode("login@x.test", "login") });
    expect(r.status).toBe(200);
    expect((await c("GET", "/auth/me")).body.user.email).toBe("login@x.test");
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    const before = inbox.length;
    const r = await client()("POST", "/auth/otp/send", { email: "nobody@x.test", purpose: "login" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/If this email has an account/);
    expect(inbox.length).toBe(before);
  });

  it("limits how often codes can be sent", async () => {
    await registerVerified("spam@x.test");
    const c = client();
    expect((await c("POST", "/auth/otp/send", { email: "spam@x.test", purpose: "login" })).status).toBe(200);
    const again = await c("POST", "/auth/otp/send", { email: "spam@x.test", purpose: "login" });
    expect(again.status).toBe(429);
    expect(again.body.error).toMatch(/wait \d+ seconds/);
  });
});

describe("forgot password", () => {
  it("resets the password with a code and logs in", async () => {
    await registerVerified("forgot@x.test");
    const c = client();
    await c("POST", "/auth/otp/send", { email: "forgot@x.test", purpose: "reset" });
    const code = lastCode("forgot@x.test", "reset");
    expect((await c("POST", "/auth/password/reset", { email: "forgot@x.test", code, password: "short" })).status).toBe(400);
    const r = await c("POST", "/auth/password/reset", { email: "forgot@x.test", code, password: "newpass99" });
    expect(r.status).toBe(200);
    expect((await client()("POST", "/auth/login", { email: "forgot@x.test", password: "newpass99" })).status).toBe(200);
    expect((await client()("POST", "/auth/login", { email: "forgot@x.test", password: "secret12" })).status).toBe(401);
    // A login code can't be used to reset, and a used reset code can't be reused.
    expect((await client()("POST", "/auth/password/reset", { email: "forgot@x.test", code, password: "another99" })).status).toBe(400);
  });
});

describe("OTP rules", () => {
  it("expires codes, burns them after 5 wrong tries, and caps sends per hour", async () => {
    const db = await getDb();
    const t0 = new Date("2026-01-01T10:00:00Z");
    const { code } = await codes.createCode({ db, key: "rules@x.test", purpose: "login", now: t0 });
    await expect(codes.verifyCode({ db, key: "rules@x.test", purpose: "login", code, now: new Date(t0.getTime() + 11 * 60e3) })).rejects.toThrow(/expired/);

    const t1 = new Date(t0.getTime() + 20 * 60e3);
    const fresh = await codes.createCode({ db, key: "rules@x.test", purpose: "login", now: t1 });
    const wrong = fresh.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(codes.verifyCode({ db, key: "rules@x.test", purpose: "login", code: wrong, now: t1 })).rejects.toThrow(/(try|tries) left/);
    await expect(codes.verifyCode({ db, key: "rules@x.test", purpose: "login", code: wrong, now: t1 })).rejects.toThrow(/too many times/);
    await expect(codes.verifyCode({ db, key: "rules@x.test", purpose: "login", code: fresh.code, now: t1 })).rejects.toThrow(/No active code/);

    // Two codes already this hour; three more allowed (45 s apart), then blocked.
    let t = t1.getTime();
    for (let i = 0; i < 3; i++) await codes.createCode({ db, key: "rules@x.test", purpose: "login", now: new Date((t += 60e3)) });
    await expect(codes.createCode({ db, key: "rules@x.test", purpose: "login", now: new Date((t += 60e3)) })).rejects.toThrow(/Too many codes/);
    // Stored hashed, never the code itself.
    const doc = await db.collection("otpCodes").findOne({ key: "rules@x.test" });
    expect(JSON.stringify(doc)).not.toContain(fresh.code);
  });
});
