// Free mobile check for QR orders (no SMS): a number is trusted on a phone once the shop has
// accepted an order from that number on that phone. Until then the order is marked for the staff
// ("new number": confirm at the table), and only one order at a time can wait for them, so typing
// made-up numbers can't flood the kitchen.
import crypto from "node:crypto";
import { HttpError } from "./http.js";

const COLLECTION = "trustedDevices";
// Accepted (or later) orders: someone on the shop's side saw the number's order go ahead.
const WENT_AHEAD = ["accepted", "preparing", "ready", "served", "billed"];
export const DEVICE_RE = /^[A-Za-z0-9_-]{12,40}$/;

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  await db.collection(COLLECTION).createIndex({ shopId: 1, phone: 1, device: 1 }, { unique: true });
  indexed = true;
}

// Only a hash of the phone's key is kept (the key itself also opens its help requests).
export const deviceHash = (key) => (DEVICE_RE.test(key || "") ? crypto.createHash("sha256").update(`device:${key}`).digest("base64url").slice(0, 24) : "");

/**
 * How well the shop knows this mobile on this phone:
 * - "trusted": an order from this number on this phone was accepted before
 * - "known":   the number had accepted orders (or bills) here, but from another phone
 * - "new":     never seen
 */
export async function phoneCheck(db, shopId, phone, device) {
  if (device && (await db.collection(COLLECTION).findOne({ shopId, phone, device }))) return "trusted";
  const before = await db.collection("orders").findOne({ shopId, customerPhone: phone, status: { $in: WENT_AHEAD } }, { projection: { _id: 1 } });
  if (before) return "known";
  const billed = await db.collection("bills").findOne({ shopId, "customer.phone": { $in: [phone, `+91${phone}`, `+91 ${phone}`, `0${phone}`] } }, { projection: { _id: 1 } });
  return billed ? "known" : "new";
}

// Not trusted yet: one order waiting for the staff at a time, per number and per phone.
export async function oneWaitingOrder(db, shopId, phone, device) {
  const or = [{ customerPhone: phone }, ...(device ? [{ deviceHash: device }] : [])];
  const waiting = await db.collection("orders").findOne({ shopId, status: "new", $or: or }, { projection: { _id: 1 } });
  if (waiting) throw new HttpError(409, "Your first order is waiting for the staff to confirm it. You can order more as soon as they accept it.", { code: "VERIFY_WAIT" });
}

// The shop accepted this order: its number is trusted on that phone from now on.
export async function trustOrderDevice(db, order) {
  if (!order?.deviceHash || !order.customerPhone || order.phoneCheck === "trusted") return;
  await ensureIndexes(db);
  await db.collection(COLLECTION).updateOne(
    { shopId: order.shopId, phone: order.customerPhone, device: order.deviceHash },
    { $setOnInsert: { createdAt: new Date(), orderId: order.clientId } },
    { upsert: true }
  );
}
