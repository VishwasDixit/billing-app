// One-time codes (OTP), reusable in any project with a MongoDB `db`.
// Only a hash of each code is stored; codes expire, are single-use, and
// sending is rate-limited per key (e.g. an email address).
import crypto from "node:crypto";

export class OtpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "OtpError";
    this.status = status;
  }
}

export const OTP_RULES = {
  ttlMs: 10 * 60 * 1000, // code valid for 10 minutes
  maxAttempts: 5, // wrong tries before the code is burned
  cooldownMs: 45 * 1000, // wait between sends to the same key
  maxPerHour: 5, // sends per key per hour
};

const COLLECTION = "otpCodes";
let indexed = false;

async function ensureIndexes(db) {
  if (indexed) return;
  await Promise.all([
    db.collection(COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(COLLECTION).createIndex({ key: 1, purpose: 1, createdAt: -1 }),
  ]);
  indexed = true;
}

const hash = (code, salt) => crypto.createHash("sha256").update(`${code}:${salt}:${process.env.JWT_SECRET || ""}`).digest("hex");

/**
 * Creates a fresh 6-digit code for `key` + `purpose`, replacing any earlier one.
 * `payload` is stored with the code and returned by verifyCode (e.g. pending sign-up details).
 * @returns {Promise<{code: string, expiresAt: Date}>}
 */
export async function createCode({ db, key, purpose, payload = null, rules = OTP_RULES, now = new Date() }) {
  await ensureIndexes(db);
  const col = db.collection(COLLECTION);
  const recent = await col
    .find({ key, purpose, createdAt: { $gt: new Date(now.getTime() - 60 * 60 * 1000) } })
    .sort({ createdAt: -1 })
    .toArray();
  if (recent[0] && now - recent[0].createdAt < rules.cooldownMs) {
    const wait = Math.ceil((rules.cooldownMs - (now - recent[0].createdAt)) / 1000);
    throw new OtpError(429, `Please wait ${wait} seconds before asking for another code.`);
  }
  if (recent.length >= rules.maxPerHour) {
    throw new OtpError(429, "Too many codes requested. Please try again in an hour.");
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = crypto.randomBytes(8).toString("hex");
  const expiresAt = new Date(now.getTime() + rules.ttlMs);
  // Older codes stop working, but their records stay for the hourly limit.
  await col.updateMany({ key, purpose, used: false }, { $set: { used: true } });
  await col.insertOne({ key, purpose, codeHash: hash(code, salt), salt, attempts: 0, used: false, payload, createdAt: now, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), validUntil: expiresAt });
  return { code, expiresAt };
}

/**
 * Checks a code. Returns the stored payload on success (the code is then used up).
 * Throws OtpError(400) with a helpful message otherwise.
 */
export async function verifyCode({ db, key, purpose, code, rules = OTP_RULES, now = new Date() }) {
  const col = db.collection(COLLECTION);
  const doc = await col.findOne({ key, purpose, used: false }, { sort: { createdAt: -1 } });
  if (!doc) throw new OtpError(400, "No active code. Please ask for a new one.");
  if (now > doc.validUntil) {
    await col.updateOne({ _id: doc._id }, { $set: { used: true } });
    throw new OtpError(400, "This code has expired. Please ask for a new one.");
  }
  const clean = String(code || "").replace(/\D/g, "");
  const ok = clean.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(clean, doc.salt)), Buffer.from(doc.codeHash));
  if (!ok) {
    const attempts = doc.attempts + 1;
    const left = rules.maxAttempts - attempts;
    await col.updateOne({ _id: doc._id }, { $set: { attempts, ...(left <= 0 ? { used: true } : {}) } });
    throw new OtpError(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Wrong code too many times. Please ask for a new one.");
  }
  // Single use: only the first successful check wins.
  const { modifiedCount } = await col.updateOne({ _id: doc._id, used: false }, { $set: { used: true, usedAt: now } });
  if (!modifiedCount) throw new OtpError(400, "This code was already used. Please ask for a new one.");
  return doc.payload;
}
