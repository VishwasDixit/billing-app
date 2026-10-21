import { HttpError } from "./http.js";

// Hourly counters in rateLimits (a TTL index on expiresAt cleans them up).
export async function bump(db, key) {
  const now = new Date();
  const r = await db.collection("rateLimits").findOneAndUpdate({ _id: key, expiresAt: { $gt: now } }, { $inc: { hits: 1 } }, { returnDocument: "after" });
  if (r) return r.hits;
  await db.collection("rateLimits").replaceOne({ _id: key }, { hits: 1, expiresAt: new Date(now.getTime() + 60 * 60 * 1000) }, { upsert: true });
  return 1;
}
export async function hitsOf(db, key) {
  return (await db.collection("rateLimits").findOne({ _id: key, expiresAt: { $gt: new Date() } }))?.hits || 0;
}
// Allows `limit` calls per key per hour.
export async function rateLimit(db, key, limit, message) {
  if (/:ip:$/.test(key)) return;
  if ((await bump(db, key)) > limit) throw new HttpError(429, message);
}

// Vercel always sets x-forwarded-for; without it (local dev, tests) per-network limits are skipped.
export const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
