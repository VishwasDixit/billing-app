import { MongoClient } from "mongodb";
import { HttpError } from "./http.js";

// Reuse one client across serverless invocations (and hot reloads in dev).
const g = globalThis;

export async function getDb() {
  if (!g.__billingDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new HttpError(500, "Server setup problem: MONGODB_URI is not set in Vercel → Settings → Environment Variables.");
    g.__billingDb = (async () => {
      const client = new MongoClient(uri, { maxPoolSize: Number(process.env.MONGODB_POOL) || 10 });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "billing");
      await ensureIndexes(db);
      g.__billingClient = client;
      return db;
    })().catch((err) => {
      g.__billingDb = null;
      if (err instanceof HttpError) throw err;
      console.error("MongoDB connection failed:", err);
      throw new HttpError(500, "Can't connect to the database. Check MONGODB_URI (password) and Atlas Network Access (0.0.0.0/0).", {
        detail: describeDbError(err),
      });
    });
  }
  return g.__billingDb;
}

export async function closeDb() {
  if (g.__billingClient) await g.__billingClient.close();
  g.__billingClient = null;
  g.__billingDb = null;
}

async function ensureIndexes(db) {
  await backfillPhoneDigits(db);
  await Promise.all([
    db.collection("users").createIndex({ phoneDigits: 1 }),
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("users").createIndex({ shopId: 1 }),
    db.collection("rateLimits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("helpThreads").createIndex({ shopId: 1, updatedAt: -1 }),
    db.collection("orders").createIndex({ shopId: 1, clientId: 1 }, { unique: true }),
    db.collection("orders").createIndex({ shopId: 1, status: 1, createdAt: 1 }),
    db.collection("orders").createIndex({ shopId: 1, updatedAt: -1 }),
    db.collection("ingredients").createIndex({ shopId: 1, nameKey: 1 }, { unique: true }),
    db.collection("recipes").createIndex({ shopId: 1, itemId: 1 }, { unique: true }),
    db.collection("recipes").createIndex({ shopId: 1, ingredientIds: 1 }),
    db.collection("stockMoves").createIndex({ shopId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: "string" } } }),
    db.collection("stockMoves").createIndex({ shopId: 1, at: -1 }),
    db.collection("stockMoves").createIndex({ shopId: 1, type: 1, ingredientId: 1, at: -1 }),
    db.collection("kitchenAlerts").createIndex({ shopId: 1, key: 1, resolvedAt: 1 }),
    db.collection("brainModels").createIndex({ shopId: 1, kind: 1 }),
    db.collection("brainSuggestions").createIndex({ shopId: 1, key: 1 }, { unique: true }),
    db.collection("staff").createIndex({ shopId: 1, active: 1 }),
    db.collection("shops").createIndex({ staffCode: 1 }, { unique: true, partialFilterExpression: { staffCode: { $type: "string" } } }),
    db.collection("attendance").createIndex({ shopId: 1, staffId: 1, date: 1 }, { unique: true }),
    db.collection("attendance").createIndex({ shopId: 1, date: 1 }),
    db.collection("staffAdvances").createIndex({ shopId: 1, staffId: 1, date: 1 }),
    db.collection("salaryPayments").createIndex({ shopId: 1, staffId: 1, month: 1 }),
    db.collection("salaryAdjustments").createIndex({ shopId: 1, staffId: 1, month: 1 }),
    db.collection("staffLoans").createIndex({ shopId: 1, staffId: 1 }),
    db.collection("salaryMonths").createIndex({ shopId: 1, month: 1 }, { unique: true }),
    db.collection("counters").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("shops").createIndex({ orderToken: 1 }, { unique: true, partialFilterExpression: { orderToken: { $type: "string" } } }),
    db.collection("helpThreads").createIndex({ unreadByAdmin: -1, updatedAt: -1 }),
    db.collection("imageSearch").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("menuItems").createIndex({ shopId: 1, sort: 1 }),
    db.collection("menuImages").createIndex({ shopId: 1, itemId: 1 }),
    db.collection("bills").createIndex({ shopId: 1, clientId: 1 }, { unique: true }),
    db.collection("bills").createIndex({ shopId: 1, createdAt: -1 }),
    // Deleted bills leave the bin by themselves 30 days later.
    db.collection("bills").createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("billAudit").createIndex({ shopId: 1, at: -1 }),
    db.collection("expenses").createIndex({ shopId: 1, date: -1 }),
    db.collection("customers").createIndex({ shopId: 1, clientId: 1 }, { unique: true }),
    db.collection("customers").createIndex({ shopId: 1, name: 1 }),
    db.collection("customers").createIndex({ shopId: 1, phone: 1 }),
    db.collection("promos").createIndex({ shopId: 1, code: 1 }, { unique: true }),
    db.collection("pushSubs").createIndex({ endpoint: 1 }, { unique: true }),
    db.collection("pushSubs").createIndex({ shopId: 1, role: 1 }),
    db.collection("tableHelp").createIndex({ shopId: 1, status: 1, createdAt: 1 }),
    db.collection("tableHelp").createIndex({ shopId: 1, deviceKey: 1, createdAt: -1 }),
    db.collection("tableHelp").createIndex({ createdAt: 1 }, { expireAfterSeconds: 2 * 86400 }),
    db.collection("promoUses").createIndex({ promoId: 1, ref: 1 }, { unique: true }),
    db.collection("promoUses").createIndex({ shopId: 1, ref: 1 }),
    db.collection("promoUses").createIndex({ promoId: 1, phone: 1 }),
    db.collection("promoUses").createIndex({ promoId: 1, phoneKey: 1 }, { unique: true, partialFilterExpression: { phoneKey: { $type: "string" } } }),
    db.collection("customers").createIndex({ shopId: 1, phoneKey: 1 }, { unique: true, partialFilterExpression: { phoneKey: { $type: "string" } } }),
    db.collection("customerPayments").createIndex({ shopId: 1, customerClientId: 1, createdAt: 1 }),
    db.collection("bills").createIndex({ shopId: 1, "customer.clientId": 1, createdAt: 1 }),
    db.collection("payments").createIndex({ shopId: 1, createdAt: -1 }),
    db.collection("payments").createIndex({ status: 1, createdAt: -1 }),
    db.collection("payments").createIndex(
      { razorpayPaymentId: 1 },
      { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } }
    ),
  ]);
}

// Older accounts: the searchable last-10-digits phone used by "Forgot email".
async function backfillPhoneDigits(db) {
  const users = await db.collection("users").find({ phoneDigits: { $exists: false } }, { projection: { phone: 1 } }).limit(5000).toArray();
  if (!users.length) return;
  await db.collection("users").bulkWrite(
    users.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: { phoneDigits: String(u.phone || "").replace(/\D/g, "").slice(-10) } } } }))
  );
}

// Short, secret-free reason for a failed connection (shown on /api/health).
export function describeDbError(err) {
  return String(err?.message || err)
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, "[connection string]")
    .slice(0, 200);
}
