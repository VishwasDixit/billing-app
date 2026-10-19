import { z } from "zod";
import { HttpError, respond } from "../http.js";
import { hashPassword, checkPassword, sessionCookie, clearCookie, publicUser, isAdminEmail, assertAuthConfigured } from "../auth.js";
import { TRIAL_DAYS } from "../subscription.js";
import { defaultMenu, GRILLHIVE_SHOP } from "../seed/grillhive-menu.js";
import { createCode, verifyCode } from "../otp/codes.js";
import { sendOtpEmail, emailOtpReady } from "../otp/mailer.js";
import { publicShop } from "./shop.js";

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
  ["GET", "/auth/config", async () => ({ emailOtp: await emailOtpReady() }), { auth: false }],

  // Direct sign-up, only while email codes aren't set up (otherwise use register/start + verify).
  [
    "POST",
    "/auth/register",
    async ({ db, body }) => {
      const input = Register.parse(body);
      assertAuthConfigured();
      if (await emailOtpReady()) throw new HttpError(400, "Please verify your email to sign up.", { code: "VERIFY_EMAIL" });
      await assertEmailFree(db, input.email);
      const user = await createAccount(db, { ...input, passwordHash: await hashPassword(input.password) });
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
  // Email a login or password-reset code. Same reply whether or not the account exists.
  [
    "POST",
    "/auth/otp/send",
    async ({ db, body }) => {
      const { email, purpose } = z.object({ email: Email, purpose: z.enum(["login", "reset"]) }).parse(body);
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
    "/auth/otp/login",
    async ({ db, body }) => {
      const { email, code } = CodeIn.parse(body);
      await otp(verifyCode({ db, key: email, purpose: "login", code }));
      const user = await db.collection("users").findOne({ email });
      if (!user) throw new HttpError(400, "No account found for this email.");
      return respond(200, await sessionPayload(db, user), { "Set-Cookie": sessionCookie(user) });
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
  ["POST", "/auth/logout", async () => respond(200, { ok: true }, { "Set-Cookie": clearCookie() }), { auth: false }],
  ["GET", "/auth/me", async ({ db, user }) => sessionPayload(db, user)],
  [
    "POST",
    "/auth/password",
    async ({ db, user, body }) => {
      const { current, password } = z
        .object({ current: z.string().min(1), password: z.string().min(6, "must be at least 6 characters").max(100) })
        .parse(body);
      if (!(await checkPassword(current, user.passwordHash))) throw new HttpError(400, "Current password is wrong.");
      await db.collection("users").updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
      return { ok: true };
    },
  ],
];
