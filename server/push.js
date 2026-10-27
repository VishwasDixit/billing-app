// Web Push: staff phones get order alerts even when locked or the app is closed.
// Needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT) in the environment;
// without them nothing is sent and the Alerts panel doesn't offer it.
import webpush from "web-push";

const STAFF = ["owner", "admin", "manager", "kitchen"];
export const MONEY_ROLES = ["owner", "admin", "manager"]; // bills and payments: not the kitchen
const GAP_MS = 30e3; // the same thing (table + kind) at most once per 30 seconds
const MAX_PER_SHOP = 50;

export const pushReady = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const pushPublicKey = () => (pushReady() ? process.env.VAPID_PUBLIC_KEY : "");

function vapid() {
  const admin = (process.env.ADMIN_EMAIL || "").split(",")[0].trim();
  return {
    subject: process.env.VAPID_SUBJECT || (admin ? `mailto:${admin}` : process.env.APP_URL || "mailto:support@example.com"),
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
}

// Saves this device (one row per endpoint; a phone moving to another shop moves with it).
export async function saveSubscription(db, { shop, user, staff }, sub) {
  const now = new Date();
  const existing = await db.collection("pushSubs").findOne({ endpoint: sub.endpoint }, { projection: { shopId: 1 } });
  if (!existing || String(existing.shopId) !== String(shop._id)) {
    const n = await db.collection("pushSubs").countDocuments({ shopId: shop._id });
    if (n >= MAX_PER_SHOP) {
      // Make room: the device that was set up longest ago goes.
      const old = await db.collection("pushSubs").find({ shopId: shop._id }).sort({ updatedAt: 1 }).limit(n - MAX_PER_SHOP + 1).toArray();
      await db.collection("pushSubs").deleteMany({ _id: { $in: old.map((o) => o._id) } });
    }
  }
  await db.collection("pushSubs").updateOne(
    { endpoint: sub.endpoint },
    {
      $set: {
        shopId: shop._id,
        userId: user._id,
        staffId: staff?.id || null,
        name: staff?.name || user.name || "",
        role: user.role,
        keys: sub.keys,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export const removeSubscription = (db, shopId, endpoint) => db.collection("pushSubs").deleteOne({ shopId, endpoint });

// True the first time a key is seen in GAP_MS (atomic: a second caller hits the unique _id).
async function firstInGap(db, key) {
  const now = new Date();
  try {
    await db.collection("rateLimits").updateOne({ _id: key, expiresAt: { $lte: now } }, { $set: { expiresAt: new Date(now.getTime() + GAP_MS) } }, { upsert: true });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

// Sends one alert to one device (the Alerts panel's "Send a test alert"). Returns true or throws.
export async function pushToEndpoint(sub, { title, body, url = "/orders" }) {
  const payload = JSON.stringify({ title, body, url, tag: "orders" });
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { vapidDetails: vapid(), TTL: 60, urgency: "high", timeout: 5000 });
  return true;
}

// Sends one alert to the shop's subscribed devices with one of `roles`. Never throws: an order
// must not fail because a phone couldn't be reached. Returns how many devices were reached.
export async function pushToShop(db, shopId, { title, body, roles = STAFF, key, url = "/orders" }) {
  if (!pushReady()) return 0;
  try {
    if (key && !(await firstInGap(db, `push:${shopId}:${key}`))) return 0;
    const subs = await db.collection("pushSubs").find({ shopId, role: { $in: roles } }).toArray();
    if (!subs.length) return 0;
    const payload = JSON.stringify({ title, body, url, tag: "orders" });
    // topic: an undelivered alert (phone offline) is replaced by the newer one, not piled up.
    const opts = { vapidDetails: vapid(), TTL: 15 * 60, urgency: "high", topic: "orders", timeout: 5000 };
    const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, opts)));
    const dead = subs.filter((s, i) => [404, 410].includes(results[i].reason?.statusCode)).map((s) => s._id);
    if (dead.length) await db.collection("pushSubs").deleteMany({ _id: { $in: dead } });
    return results.filter((r) => r.status === "fulfilled").length;
  } catch (err) {
    console.error("Push failed:", err.message);
    return 0;
  }
}
