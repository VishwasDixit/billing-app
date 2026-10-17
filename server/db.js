import { MongoClient } from "mongodb";

// Reuse one client across serverless invocations (and hot reloads in dev).
const g = globalThis;

export async function getDb() {
  if (!g.__billingDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    g.__billingDb = (async () => {
      const client = new MongoClient(uri, { maxPoolSize: 5 });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || "billing");
      await ensureIndexes(db);
      g.__billingClient = client;
      return db;
    })().catch((err) => {
      g.__billingDb = null;
      throw err;
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
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("users").createIndex({ shopId: 1 }),
    db.collection("menuItems").createIndex({ shopId: 1, sort: 1 }),
    db.collection("bills").createIndex({ shopId: 1, clientId: 1 }, { unique: true }),
    db.collection("bills").createIndex({ shopId: 1, createdAt: -1 }),
    db.collection("expenses").createIndex({ shopId: 1, date: -1 }),
    db.collection("payments").createIndex({ shopId: 1, createdAt: -1 }),
    db.collection("payments").createIndex({ status: 1, createdAt: -1 }),
    db.collection("payments").createIndex(
      { razorpayPaymentId: 1 },
      { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } }
    ),
  ]);
}
