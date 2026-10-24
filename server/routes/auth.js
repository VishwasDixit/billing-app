import { z } from "zod";
import { HttpError, respond } from "../http.js";
import { hashPassword, checkPassword, sessionCookie, staffSessionCookie, clearCookie, publicUser, isAdminEmail, assertAuthConfigured } from "../auth.js";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { trialDays, blockedMessage, planSettings, PLANS } from "../subscription.js";
import { defaultMenu, GRILLHIVE_SHOP } from "../seed/grillhive-menu.js";
import { createCode, verifyCode } from "../otp/codes.js";
import { sendOtpEmail, emailOtpReady } from "../otp/mailer.js";
import { verifyGoogleCredential, googleClientId, googleEnabled } from "../google.js";
import { publicShop } from "./shop.js";
import { bump, hitsOf, rateLimit, clientIp } from "../limits.js";
export { clientIp };

const RESET_WINDOW_MS = 15 * 60 * 1000; // after a Google sign-in, a new password can be set without the old one

const Register = z.object({
  shopName: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(40),
  phone: z.string().trim().regex(/^[0-9+\- ]{10,15}$/, "enter a valid phone number"),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "must be at least 8 characters").max(100),
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

// Wrong-password limits: per account and per network.
export const LOGIN_LIMITS = { email: 10, ip: 50 };
const TOO_MANY = "Too many wrong tries. Please wait an hour, or use Forgot password.";

// Logs out every other device: old cookies stop working; the caller gets a fresh one.
async function newSession(db, user) {
  const r = await db.collection("users").findOneAndUpdate({ _id: user._id }, { $inc: { sessionVersion: 1 } }, { returnDocument: "after" });
  return sessionCookie(r);
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
  const user = { shopId, name: d.name, email: d.email, phone: d.phone, phoneDigits: digits(d.phone), passwordHash: d.passwordHash, emailVerified: !!d.verified, createdAt: new Date() };
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
    trialEndsAt: new Date(now.getTime() + trialDays() * 24 * 60 * 60 * 1000),
    subscription: null,
    createdAt: now,
  };
}

async function sessionPayload(db, user) {
  const shop = await db.collection("shops").findOne({ _id: user.shopId });
  if (shop?.blocked && !isAdminEmail(user.email)) throw new HttpError(403, blockedMessage(shop), { code: "BLOCKED" });
  return { user: publicUser(user), shop: publicShop(shop, isAdminEmail(user.email)) };
}

// ---------- Staff sign-in on their own phone: shop code + name + PIN ----------
const StaffCodeIn = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/, "Enter the 6-letter staff code from the owner.");
async function shopByStaffCode(db, code) {
  const shop = await db.collection("shops").findOne({ staffCode: code });
  if (!shop) throw new HttpError(404, "No shop with this staff code. Check it with the owner.");
  if (shop.blocked) throw new HttpError(403, blockedMessage(shop), { code: "BLOCKED" });
  return shop;
}

export default [
  [
    "GET",
    "/auth/staff-names",
    async ({ db, query, req }) => {
      const code = StaffCodeIn.parse(query.code || "");
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `staffnames:ip:${ip}`, 30, "Too many tries. Please wait and try again.");
      const shop = await shopByStaffCode(db, code);
      const staff = await db.collection("staff").find({ shopId: shop._id, active: true, access: { $in: ["kitchen", "manager"] }, pinHash: { $exists: true } }).sort({ name: 1 }).toArray();
      return { shop: { name: shop.name }, staff: staff.map((s) => ({ id: String(s._id), name: s.name, access: s.access })) };
    },
    { auth: false },
  ],
  [
    "POST",
    "/auth/staff-login",
    async ({ db, body }) => {
      const { code, staffId, pin } = z.object({ code: StaffCodeIn, staffId: z.string(), pin: z.string().regex(/^\d{4}$/, "Enter your 4-digit PIN.") }).parse(body);
      const shop = await shopByStaffCode(db, code);
      if (!ObjectId.isValid(staffId)) throw new HttpError(404, "Pick your name again.");
      const key = `pin:${shop._id}:${staffId}`;
      if ((await hitsOf(db, key)) >= 8) throw new HttpError(429, "Too many wrong PINs. Ask the owner, or try again in an hour.");
      const staff = await db.collection("staff").findOne({ _id: new ObjectId(staffId), shopId: shop._id, active: true });
      if (!staff || !["kitchen", "manager"].includes(staff.access)) throw new HttpError(403, "You don't have app access. Ask the owner.");
      if (!staff.pinHash || !(await bcrypt.compare(pin, staff.pinHash))) {
        await bump(db, key);
        throw new HttpError(401, "Wrong PIN.");
      }
      await db.collection("rateLimits").deleteOne({ _id: key });
      const owner = await db.collection("users").findOne({ shopId: shop._id }, { sort: { createdAt: 1 } });
      if (!owner) throw new HttpError(404, "Shop not found.");
      const user = { ...owner, role: staff.access === "manager" ? "manager" : "kitchen", staff: { id: String(staff._id), name: staff.name, role: staff.role }, name: staff.name };
      return respond(200, { user: publicUser(user), shop: publicShop(shop) }, { "Set-Cookie": staffSessionCookie(owner, staff, shop) });
    },
    { auth: false },
  ],
  // Which sign-in options the login screen should show.
  [
    "GET",
    "/auth/config",
    async () => ({
      emailOtp: await emailOtpReady(),
      googleClientId: googleClientId() || (googleEnabled() ? "test" : ""),
      // Standard prices for sign-up and marketing text (shops may have their own price).
      plans: Object.values(PLANS).map(({ id, name, amount, days }) => ({ id, name, amount, days })),
      trialDays: trialDays(),
      yearlyBadge: planSettings().yearlyBadge,
    }),
    { auth: false },
  ],

  // Direct sign-up, only while email codes aren't set up (otherwise use register/start + verify).
  [
    "POST",
    "/auth/register",
    async ({ db, body, req }) => {
      const input = Register.parse(body);
      await rateLimit(db, `signup:ip:${clientIp(req)}`, 20, "Too many sign-ups from this network. Please try again in an hour.");

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
    async ({ db, body, req }) => {
      const input = Register.parse(body);
      await rateLimit(db, `signup:ip:${clientIp(req)}`, 20, "Too many sign-ups from this network. Please try again in an hour.");

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
    async ({ db, body, req }) => {
      const { email, purpose } = z.object({ email: Email, purpose: z.literal("reset").default("reset") }).parse(body);
      await rateLimit(db, `otp:ip:${clientIp(req)}`, 30, "Too many codes requested from this network. Please try again in an hour.");
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
      const { email, code, password } = CodeIn.extend({ password: z.string().min(8, "must be at least 8 characters").max(100) }).parse(body);
      await otp(verifyCode({ db, key: email, purpose: "reset", code }));
      const user = await db.collection("users").findOne({ email });
      if (!user) throw new HttpError(400, "No account found for this email.");
      await db.collection("users").updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password), passwordResetAt: new Date() } });
      await db.collection("rateLimits").deleteOne({ _id: `login:email:${email}` }); // proved it's theirs
      const cookie = await newSession(db, user);
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": cookie });
    },
    { auth: false },
  ],
  [
    "POST",
    "/auth/login",
    async ({ db, body, req }) => {
      const input = Login.parse(body);
      const ip = clientIp(req);
      const keys = { email: `login:email:${input.email}`, ip: ip && `login:ip:${ip}` };
      if ((await hitsOf(db, keys.email)) >= LOGIN_LIMITS.email || (keys.ip && (await hitsOf(db, keys.ip)) >= LOGIN_LIMITS.ip)) throw new HttpError(429, TOO_MANY);
      const user = await db.collection("users").findOne({ email: input.email });
      if (!user || !(await checkPassword(input.password, user.passwordHash))) {
        await Promise.all([bump(db, keys.email), keys.ip && bump(db, keys.ip)]);
        throw new HttpError(401, "Wrong email or password.");
      }
      await db.collection("rateLimits").deleteOne({ _id: keys.email });
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
      const ip = clientIp(req);
      const wait = "Too many lookups. Please try again in an hour.";
      await rateLimit(db, `find-email:ip:${ip}`, 20, wait);
      await rateLimit(db, `find-email:phone:${phone}`, 5, wait);
      const found = await db.collection("users").find({ phoneDigits: phone }, { projection: { email: 1, shopId: 1 } }).toArray();
      if (!found.length) throw new HttpError(404, "No shop is registered with this phone number.");
      const shops = await db.collection("shops").find({ _id: { $in: found.map((u) => u.shopId) } }, { projection: { name: 1 } }).toArray();
      const shopName = Object.fromEntries(shops.map((s) => [String(s._id), s.name]));
      return { accounts: found.map((u) => ({ email: maskEmail(u.email), shop: shopName[String(u.shopId)] || "" })) };
    },
    { auth: false },
  ],
  ["POST", "/auth/logout", async () => respond(200, { ok: true }, { "Set-Cookie": clearCookie() }), { auth: false, kitchen: true }],
  ["GET", "/auth/me", async ({ db, user }) => sessionPayload(db, user), { kitchen: true }],
  // Turns this device into a kitchen phone: kitchen screens only, no sales, money or settings.
  // Leaving it needs the owner's normal log in.
  [
    "POST",
    "/auth/kitchen-mode",
    async ({ db, user, body }) => {
      if (user.role === "kitchen") throw new HttpError(400, "This phone is already a kitchen phone.");
      const { password } = z.object({ password: z.string().min(1, "enter your password") }).parse(body);
      if (!(await checkPassword(password, user.passwordHash))) throw new HttpError(400, "Wrong password.");
      const payload = await sessionPayload(db, user);
      return respond(200, { ...payload, user: { ...payload.user, role: "kitchen" } }, { "Set-Cookie": sessionCookie(user, { kitchen: true }) });
    },
  ],
  [
    "POST",
    "/auth/password",
    async ({ db, user, body }) => {
      const { current, password } = z
        .object({ current: z.string().optional(), password: z.string().min(8, "must be at least 8 characters").max(100) })
        .parse(body);
      const resetting = user.passwordResetUntil > new Date();
      if (!resetting) {
        const key = `password:user:${user._id}`;
        if ((await hitsOf(db, key)) >= LOGIN_LIMITS.email) throw new HttpError(429, TOO_MANY);
        if (!(current && (await checkPassword(current, user.passwordHash)))) {
          if (current) await bump(db, key);
          throw new HttpError(400, current ? "Current password is wrong." : "Enter your current password.");
        }
      }
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(password), ...(resetting && { passwordResetAt: new Date() }) }, $unset: { passwordResetUntil: "" } }
      );
      // Other devices are logged out; this one stays logged in.
      return respond(200, { ok: true }, { "Set-Cookie": await newSession(db, user) });
    },
  ],
  [
    "POST",
    "/auth/logout-others",
    async ({ db, user }) => respond(200, { ok: true }, { "Set-Cookie": await newSession(db, user) }),
  ],
];
