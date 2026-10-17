import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { HttpError, parseCookies, cookie } from "./http.js";

const COOKIE = "bt";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error("JWT_SECRET must be set (16+ characters)");
  return s;
}

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return admins.includes(String(email).toLowerCase());
}

export function sessionCookie(user) {
  const token = jwt.sign({ uid: String(user._id), sid: String(user.shopId) }, secret(), { expiresIn: MAX_AGE });
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
  user.role = isAdminEmail(user.email) ? "admin" : "owner";
  return user;
}

export function publicUser(u) {
  return { id: String(u._id), name: u.name, email: u.email, phone: u.phone, role: isAdminEmail(u.email) ? "admin" : "owner" };
}
