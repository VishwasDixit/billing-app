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

// kitchen: a kitchen-phone login (kitchen screens only; no sales, money or settings).
export function sessionCookie(user, { kitchen = false } = {}) {
  // sv: bumped on password change / "log out other devices", which invalidates older cookies.
  const token = jwt.sign({ uid: String(user._id), sid: String(user.shopId), sv: user.sessionVersion || 0, ...(kitchen && { k: 1 }) }, secret(), { expiresIn: MAX_AGE });
  return cookie(COOKIE, token, { maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
}

export function clearCookie() {
  return cookie(COOKIE, "", { maxAge: 0, secure: process.env.NODE_ENV === "production" });
}

// A worker signing in on their own phone (shop code + name + PIN): kitchen-only or billing manager.
// pv/cv: changing the worker's PIN or access, or making a new shop staff code, signs them out.
export function staffSessionCookie(user, staff, shop) {
  const token = jwt.sign(
    { uid: String(user._id), sid: String(user.shopId), sv: user.sessionVersion || 0, st: String(staff._id), r: staff.access, pv: staff.pinVersion || 0, cv: shop.staffCodeVersion || 0 },
    secret(),
    { expiresIn: MAX_AGE }
  );
  return cookie(COOKIE, token, { maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
}

const STAFF_OUT = "Your staff login has ended. Ask the owner, then sign in again with your PIN.";

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
  if (payload.st) {
    const [staff, shop] = await Promise.all([
      ObjectId.isValid(payload.st) ? db.collection("staff").findOne({ _id: new ObjectId(payload.st), shopId: user.shopId }) : null,
      db.collection("shops").findOne({ _id: user.shopId }, { projection: { staffCodeVersion: 1 } }),
    ]);
    if (!staff?.active || !staff.pinHash || staff.access !== payload.r || (staff.pinVersion || 0) !== payload.pv || (shop?.staffCodeVersion || 0) !== payload.cv) {
      throw new HttpError(401, STAFF_OUT, { code: "STAFF_OUT" });
    }
    user.role = payload.r === "manager" ? "manager" : "kitchen";
    user.staff = { id: String(staff._id), name: staff.name, role: staff.role };
    user.ownerName = user.name;
    user.name = staff.name; // edits, deletes and stock entries are recorded under the worker's name
    return user;
  }
  user.role = payload.k ? "kitchen" : isAdminEmail(user.email) ? "admin" : "owner";
  return user;
}

// Short-lived proof that a staff member entered their PIN on this device (sent as x-staff-token).
export const staffToken = (staff) => jwt.sign({ st: String(staff._id), sid: String(staff.shopId), n: staff.name }, secret(), { expiresIn: 12 * 3600 });
export function readStaffToken(req, shopId) {
  const t = req.headers["x-staff-token"];
  if (!t) return null;
  try {
    const p = jwt.verify(String(t), secret());
    return p.sid === String(shopId) ? { id: p.st, name: p.n } : null;
  } catch {
    return null;
  }
}

export function publicUser(u) {
  if (u.staff) return { id: String(u._id), name: u.name, role: u.role, staff: u.staff };
  return { id: String(u._id), name: u.name, email: u.email, phone: u.phone, role: u.role === "kitchen" ? "kitchen" : isAdminEmail(u.email) ? "admin" : "owner", canSetPassword: u.passwordResetUntil > new Date() };
}
