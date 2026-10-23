// Menu stock: an item can be switched Sold out by hand, and can optionally count a quantity
// that goes down as dishes are ordered (Sold out at 0) and resets to a daily amount each day.
// Table orders count when they reach the kitchen; counter bills count when they upload.
import { z } from "zod";

let clock = () => new Date();
export function setStockClock(fn) {
  clock = fn || (() => new Date());
}
// Today's date in India.
export const stockDay = () => new Date(clock().getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

export const StockIn = z.object({
  soldOut: z.boolean().optional(),
  stock: z.number().int().min(0).max(100000).nullable().optional(),
  dailyStock: z.number().int().min(1).max(100000).nullable().optional(),
});

// Items with a daily amount start each new day full again.
export async function refreshDailyStock(db, shopId) {
  const today = stockDay();
  await db.collection("menuItems").updateMany({ shopId, dailyStock: { $gt: 0 }, stockDay: { $ne: today } }, [
    { $set: { stock: "$dailyStock", soldOut: false, stockDay: today } },
  ]);
}

// Takes ordered quantities off counted items; an item that reaches 0 becomes Sold out.
export async function takeStock(db, shopId, items) {
  const byItem = new Map();
  for (const i of items || []) {
    if (!i.itemId || !/^[a-f0-9]{24}$/.test(String(i.itemId))) continue;
    byItem.set(String(i.itemId), (byItem.get(String(i.itemId)) || 0) + (i.qty || 0));
  }
  if (!byItem.size) return;
  await refreshDailyStock(db, shopId);
  const { ObjectId } = await import("mongodb");
  const ids = [...byItem.keys()].map((id) => new ObjectId(id));
  await db.collection("menuItems").bulkWrite(
    [...byItem].map(([id, qty]) => ({
      updateOne: { filter: { _id: new ObjectId(id), shopId, stock: { $type: "number" } }, update: { $inc: { stock: -qty } } },
    }))
  );
  await db.collection("menuItems").updateMany({ _id: { $in: ids }, shopId, stock: { $lte: 0 } }, { $set: { stock: 0, soldOut: true } });
}

// For a customer's order: refuses sold-out dishes and more than what's left.
export function checkAvailable(menuById, lines) {
  const want = new Map();
  for (const l of lines) want.set(l.itemId, (want.get(l.itemId) || 0) + l.qty);
  for (const [id, qty] of want) {
    const m = menuById.get(id);
    if (!m) continue;
    if (m.soldOut) return `${m.name} just sold out. Please remove it and order again.`;
    if (typeof m.stock === "number" && qty > m.stock) return `Only ${m.stock} ${m.name} left. Please order fewer.`;
  }
  return null;
}
