import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { HttpError, parseCookies, cookie } from "./http.js";
import { blockedMessage } from "./subscription.js";

const COOKIE = "bt";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const jwtSecretOk = () => (process.env.JWT_SECRET || "").trim().length >= 16;

function secret() {
  if (!jwtSecretOk()) {
    throw new HttpError(
      500,
      "Server setup problem: JWT_SECRET is missing or shorter than 16 characters. Add it in Vercel → Settings → Environment Variables, then redeploy."
    );
  }
  return process.env.JWT_SECRET.trim();
}

// Call before creating anything, so a setup problem never leaves a half-made account.
export const assertAuthConfigured = () => void secret();

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(String(email).toLowerCase());
}

export function sessionCookie(user) {
  // sv: bumped on password change / "log out other devices", which invalidates older cookies.
  const token = jwt.sign({ uid: String(user._id), sid: String(user.shopId), sv: user.sessionVersion || 0 }, secret(), { expiresIn: MAX_AGE });
  return cookie(COOKIE, token, { maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
}

export function clearCookie() {
  return cookie(COOKIE, "", { maxAge: 0, secure: process.env.NODE_ENV === "production" });
}

// Resolves the logged-in user, or throws 401.
export async function requireUser(req, db) {
  const token = parseCookies(req)[COOKIE];
  if (!token) throw new HttpError(401, "Please log in.");
  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    throw new HttpError(401, "Your session expired. Please log in again.");
  }
  const user = await db.collection("users").findOne({ _id: new ObjectId(payload.uid) });
  if (!user) throw new HttpError(401, "Please log in.");
  if ((payload.sv || 0) !== (user.sessionVersion || 0)) {
    // Say why when the shop was blocked (blocking also ends its sessions).
    const shop = await db.collection("shops").findOne({ _id: user.shopId }, { projection: { blocked: 1 } });
    if (shop?.blocked) throw new HttpError(401, blockedMessage(shop), { code: "BLOCKED" });
    throw new HttpError(401, "You were logged out of this device. Please log in again.");
  }
  user.role = isAdminEmail(user.email) ? "admin" : "owner";
  return user;
}

export function publicUser(u) {
  return { id: String(u._id), name: u.name, email: u.email, phone: u.phone, role: isAdminEmail(u.email) ? "admin" : "owner", canSetPassword: u.passwordResetUntil > new Date() };
}
