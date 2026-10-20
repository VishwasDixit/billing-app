import { z } from "zod";
import { HttpError, respond } from "../http.js";
import { hashPassword, checkPassword, sessionCookie, clearCookie, publicUser, isAdminEmail, assertAuthConfigured } from "../auth.js";
import { TRIAL_DAYS } from "../subscription.js";
import { defaultMenu, GRILLHIVE_SHOP } from "../seed/grillhive-menu.js";
import { createCode, verifyCode } from "../otp/codes.js";
import { sendOtpEmail, emailOtpReady } from "../otp/mailer.js";
import { verifyGoogleCredential, googleClientId, googleEnabled } from "../google.js";
import { publicShop } from "./shop.js";

const RESET_WINDOW_MS = 15 * 60 * 1000; // after a Google sign-in, a new password can be set without the old one

const Register = z.object({
  shopName: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(40),
  phone: z.string().trim().regex(/^[0-9+\- ]{10,15}$/, "enter a valid phone number"),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(6, "must be at least 6 characters").max(100),
});

const Login = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const Email = z.string().trim().toLowerCase().email();
const CodeIn = z.object({ email: Email, code: z.string().trim().regex(/^\d{6}$/, "enter the 6-digit code") });

// OTP errors carry their own HTTP status (429 rate limit, 400 wrong/expired code).
async function otp(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err?.name === "OtpError") throw new HttpError(err.status, err.message);
    throw err;
  }
}

async function google(credential) {
  try {
    return await verifyGoogleCredential(credential);
  } catch (err) {
    if (err?.name === "GoogleError") throw new HttpError(401, err.message);
    throw err;
  }
}

// Allows `limit` hits per key per hour (TTL index on rateLimits.expiresAt cleans up).
async function rateLimit(db, key, limit, message) {
  const now = new Date();
  const r = await db.collection("rateLimits").findOneAndUpdate(
    { _id: key, expiresAt: { $gt: now } },
    { $inc: { hits: 1 } },
    { returnDocument: "after" }
  );
  if (r) {
    if (r.hits > limit) throw new HttpError(429, message);
    return;
  }
  await db.collection("rateLimits").replaceOne({ _id: key }, { hits: 1, expiresAt: new Date(now.getTime() + 60 * 60 * 1000) }, { upsert: true });
}

const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);
export const maskEmail = (e) => e.replace(/^([^@]{1,3})[^@]*(@.*)$/, "$1***$2");

async function assertEmailOtp() {
  if (!(await emailOtpReady())) throw new HttpError(503, "Email codes aren't working right now. Please use your password.");
}

async function assertEmailFree(db, email) {
  if (await db.collection("users").findOne({ email })) {
    throw new HttpError(409, "An account with this email already exists. Please log in.");
  }
}

// Creates the shop (with the default menu and trial) and its owner.
async function createAccount(db, d) {
  const shop = newShop({ name: d.shopName, phone: d.phone, ownerEmail: d.email });
  const { insertedId: shopId } = await db.collection("shops").insertOne(shop);
  await db.collection("menuItems").insertMany(defaultMenu(shopId));
  const user = { shopId, name: d.name, email: d.email, phone: d.phone, passwordHash: d.passwordHash, emailVerified: !!d.verified, createdAt: new Date() };
  try {
    user._id = (await db.collection("users").insertOne(user)).insertedId;
  } catch (err) {
    // Lost a race with another sign-up using the same email.
    await db.collection("shops").deleteOne({ _id: shopId });
    await db.collection("menuItems").deleteMany({ shopId });
    if (err.code === 11000) throw new HttpError(409, "An account with this email already exists. Please log in.");
    throw err;
  }
  return user;
}

export function newShop({ name, phone, ownerEmail }) {
  const now = new Date();
  const isAdmin = isAdminEmail(ownerEmail);
  return {
    name,
    logo: "",
    address: isAdmin ? GRILLHIVE_SHOP.address : "",
    phone: phone || "",
    gstin: "",
    footer: isAdmin ? GRILLHIVE_SHOP.footer : "Thank you! Visit again.",
    currency: "₹",
    gstPercent: 0,
    defaultDiscount: { type: "percent", value: 0 },
    printer: { paperSize: 58, method: "bluetooth", charsPerLine: 32, largeText: false, slowMode: false, cut: false, printLogo: false },
    deviceSeq: 0,
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
    subscription: null,
    createdAt: now,
  };
}

async function sessionPayload(db, user) {
  const shop = await db.collection("shops").findOne({ _id: user.shopId });
  return { user: publicUser(user), shop: publicShop(shop, isAdminEmail(user.email)) };
}

export default [
  // Which sign-in options the login screen should show.
  [
    "GET",
    "/auth/config",
    async () => ({ emailOtp: await emailOtpReady(), googleClientId: googleClientId() || (googleEnabled() ? "test" : "") }),
    { auth: false },
  ],

  // Direct sign-up, only while email codes aren't set up (otherwise use register/start + verify).
  [
    "POST",
    "/auth/register",
    async ({ db, body }) => {
      const input = Register.parse(body);
      assertAuthConfigured();
      // A Google sign-in proves the email, so no code is needed.
      let verified = false;
      if (body?.googleCredential) {
        const g = await google(body.googleCredential);
        if (g.email !== input.email) throw new HttpError(400, `Google signed you in as ${g.email}. Use that email, or sign up without Google.`);
        verified = true;
      } else if (await emailOtpReady()) {
        throw new HttpError(400, "Please verify your email to sign up.", { code: "VERIFY_EMAIL" });
      }
      await assertEmailFree(db, input.email);
      const user = await createAccount(db, { ...input, passwordHash: await hashPassword(input.password), verified });
      return respond(201, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  // Sign-up step 1: check the details and email a code. The details wait with the code.
  [
    "POST",
    "/auth/register/start",
    async ({ db, body }) => {
      const input = Register.parse(body);
      assertAuthConfigured();
      await assertEmailOtp();
      await assertEmailFree(db, input.email);
      const { password, ...rest } = input;
      const { code } = await otp(createCode({ db, key: input.email, purpose: "register", payload: { ...rest, passwordHash: await hashPassword(password) } }));
      await sendOtpEmail({ to: input.email, code, purpose: "register", appName: input.shopName });
      return { sent: true, email: input.email };
    },
    { auth: false },
  ],
  // Sign-up step 2: the right code creates the shop and logs in.
  [
    "POST",
    "/auth/register/verify",
    async ({ db, body }) => {
      const { email, code } = CodeIn.parse(body);
      const details = await otp(verifyCode({ db, key: email, purpose: "register", code }));
      await assertEmailFree(db, email);
      const user = await createAccount(db, { ...details, verified: true });
      return respond(201, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  // Email a password-reset code. Same reply whether or not the account exists.
  [
    "POST",
    "/auth/otp/send",
    async ({ db, body }) => {
      const { email, purpose } = z.object({ email: Email, purpose: z.literal("reset").default("reset") }).parse(body);
      await assertEmailOtp();
      const user = await db.collection("users").findOne({ email });
      if (user) {
        const { code } = await otp(createCode({ db, key: email, purpose }));
        const shop = await db.collection("shops").findOne({ _id: user.shopId }, { projection: { name: 1 } });
        await sendOtpEmail({ to: email, code, purpose, appName: shop?.name });
      }
      return { sent: true, message: "If this email has an account, we've sent a 6-digit code to it." };
    },
    { auth: false },
  ],
  [
    "POST",
    "/auth/password/reset",
    async ({ db, body }) => {
      const { email, code, password } = CodeIn.extend({ password: z.string().min(6, "must be at least 6 characters").max(100) }).parse(body);
      await otp(verifyCode({ db, key: email, purpose: "reset", code }));
      const user = await db.collection("users").findOne({ email });
      if (!user) throw new HttpError(400, "No account found for this email.");
      await db.collection("users").updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password), passwordResetAt: new Date() } });
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  [
    "POST",
    "/auth/login",
    async ({ db, body }) => {
      const input = Login.parse(body);
      const user = await db.collection("users").findOne({ email: input.email });
      if (!user || !(await checkPassword(input.password, user.passwordHash))) {
        throw new HttpError(401, "Wrong email or password.");
      }
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  // Sign in with Google. Also the no-email-code way to recover a forgotten password.
  [
    "POST",
    "/auth/google",
    async ({ db, body }) => {
      const { credential } = z.object({ credential: z.string().min(10) }).parse(body);
      assertAuthConfigured();
      const g = await google(credential);
      const user = await db.collection("users").findOne({ email: g.email });
      if (!user) throw new HttpError(404, `No shop is registered with ${g.email}.`, { code: "NO_ACCOUNT", email: g.email, name: g.name });
      user.passwordResetUntil = new Date(Date.now() + RESET_WINDOW_MS);
      await db.collection("users").updateOne({ _id: user._id }, { $set: { emailVerified: true, passwordResetUntil: user.passwordResetUntil } });
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
    },
    { auth: false },
  ],
  // Forgot which email you signed up with: look it up by phone (masked).
  [
    "POST",
    "/auth/find-email",
    async ({ db, body, req }) => {
      const phone = digits(z.object({ phone: z.string() }).parse(body).phone);
      if (phone.length !== 10) throw new HttpError(400, "Enter the 10-digit phone number you registered with.");
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
      const wait = "Too many lookups. Please try again in an hour.";
      await rateLimit(db, `find-email:ip:${ip}`, 20, wait);
      await rateLimit(db, `find-email:phone:${phone}`, 5, wait);
      const users = await db.collection("users").find({}, { projection: { email: 1, phone: 1, shopId: 1 } }).toArray();
      const found = users.filter((u) => digits(u.phone) === phone);
      if (!found.length) throw new HttpError(404, "No shop is registered with this phone number.");
      const shops = await db.collection("shops").find({ _id: { $in: found.map((u) => u.shopId) } }, { projection: { name: 1 } }).toArray();
      const shopName = Object.fromEntries(shops.map((s) => [String(s._id), s.name]));
      return { accounts: found.map((u) => ({ email: maskEmail(u.email), shop: shopName[String(u.shopId)] || "" })) };
    },
    { auth: false },
  ],
  ["POST", "/auth/logout", async () => respond(200, { ok: true }, { "Set-Cookie": clearCookie() }), { auth: false }],
  ["GET", "/auth/me", async ({ db, user }) => sessionPayload(db, user)],
  [
    "POST",
    "/auth/password",
    async ({ db, user, body }) => {
      const { current, password } = z
        .object({ current: z.string().optional(), password: z.string().min(6, "must be at least 6 characters").max(100) })
        .parse(body);
      const resetting = user.passwordResetUntil > new Date();
      if (!resetting && !(current && (await checkPassword(current, user.passwordHash)))) {
        throw new HttpError(400, current ? "Current password is wrong." : "Enter your current password.");
      }
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(password), ...(resetting && { passwordResetAt: new Date() }) }, $unset: { passwordResetUntil: "" } }
      );
      return { ok: true };
    },
  ],
];
