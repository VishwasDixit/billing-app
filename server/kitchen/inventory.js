// Kitchen stock: ingredients kept in batches (used first-expiring-first), recipes that use them
// up as dishes are ordered, a log of every change, alerts, the shopping list and the report.
import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { convert, fmtQty } from "./units.js";

const DAY = 864e5;
const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
let clock = () => new Date();
export const setKitchenClock = (fn) => (clock = fn || (() => new Date()));
export const now = () => clock();

export const EXPIRY_WARN_DAYS = 2;

const sortFefo = (batches) =>
  [...batches].sort((a, b) => (a.expiry ? new Date(a.expiry) : Infinity) - (b.expiry ? new Date(b.expiry) : Infinity) || new Date(a.receivedAt) - new Date(b.receivedAt));

// Takes `qty` out of the batches, soonest expiry first. Returns the batches left.
export function drawBatches(batches, qty) {
  let need = qty;
  const out = [];
  for (const b of sortFefo(batches || [])) {
    if (need <= 0) {
      out.push(b);
      continue;
    }
    const take = Math.min(b.qty, need);
    need -= take;
    if (b.qty - take > 1e-9) out.push({ ...b, qty: round(b.qty - take) });
  }
  return out;
}

export function publicIngredient({ _id, shopId, ...i }) {
  const t = now();
  const nextExpiry = sortFefo(i.batches || []).find((b) => b.expiry && b.qty > 0)?.expiry || null;
  return {
    ...i,
    id: String(_id),
    stock: round(i.stock),
    nextExpiry,
    expiringQty: round((i.batches || []).filter((b) => b.expiry && new Date(b.expiry) - t < EXPIRY_WARN_DAYS * DAY).reduce((s, b) => s + b.qty, 0)),
  };
}

async function logMoves(db, moves) {
  if (moves.length) await db.collection("stockMoves").insertMany(moves.map((m) => ({ at: now(), ...m })));
}

// ---------- Using ingredients when dishes are ordered ----------
// items: [{ itemId, variant, qty }]. ref: { orderId?, billId? }.
export async function useIngredients(db, shopId, items, ref = {}) {
  const lines = (items || []).filter((i) => /^[a-f0-9]{24}$/.test(String(i.itemId || "")) && i.qty > 0);
  if (!lines.length) return;
  const recipes = await db
    .collection("recipes")
    .find({ shopId, itemId: { $in: [...new Set(lines.map((l) => String(l.itemId)))] } })
    .toArray();
  if (!recipes.length) return;
  const byItem = new Map(recipes.map((r) => [r.itemId, r]));
  const need = new Map(); // ingredientId -> [{ qty, unit }]
  for (const l of lines) {
    const r = byItem.get(String(l.itemId));
    if (!r) continue;
    const parts = r.variants?.[l.variant || ""] || r.variants?.[""] || Object.values(r.variants || {})[0] || [];
    for (const p of parts) {
      if (!p.ingredientId || !(p.qty > 0)) continue;
      const list = need.get(p.ingredientId) || [];
      list.push({ qty: p.qty * l.qty, unit: p.unit, dish: r.itemName });
      need.set(p.ingredientId, list);
    }
  }
  if (!need.size) return;
  const ings = await db
    .collection("ingredients")
    .find({ shopId, _id: { $in: [...need.keys()].filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) } })
    .toArray();
  const moves = [];
  for (const ing of ings) {
    const qty = round(need.get(String(ing._id)).reduce((s, n) => s + (convert(n.qty, n.unit, ing.unit) ?? 0), 0));
    if (!(qty > 0)) continue;
    await db.collection("ingredients").updateOne(
      { _id: ing._id },
      { $set: { stock: round((ing.stock || 0) - qty), batches: drawBatches(ing.batches, qty), updatedAt: now() } }
    );
    moves.push({ shopId, ingredientId: String(ing._id), name: ing.name, unit: ing.unit, type: "used", qty: -qty, cost: money(qty * (ing.costPerUnit || 0)), ...ref });
  }
  await logMoves(db, moves);
  await checkLowStock(db, shopId, ings.map((i) => i._id));
}

// ---------- Cook entries: received / waste / expired / count / adjust ----------
export async function applyMove(db, shopId, m, staff) {
  const ing = await db.collection("ingredients").findOne({ _id: new ObjectId(m.ingredientId), shopId });
  if (!ing) return { ok: false, error: "Item not found in kitchen stock." };
  const unit = m.unit || ing.unit;
  const qty = convert(m.qty, unit, ing.unit);
  if (qty === null) return { ok: false, error: `Use ${ing.unit} for ${ing.name}.` };
  const who = staff ? { staffId: staff.id, staffName: staff.name } : { staffName: "Owner" };
  const base = { shopId, clientId: m.clientId, ingredientId: String(ing._id), name: ing.name, unit: ing.unit, note: m.note || "", ...who };
  const t = now();
  let stock = ing.stock || 0;
  let batches = ing.batches || [];
  let move;
  const alerts = [];

  if (m.type === "purchase") {
    const expiry = m.expiry ? new Date(m.expiry) : ing.shelfLifeDays ? new Date(t.getTime() + ing.shelfLifeDays * DAY) : null;
    batches = [...batches, { id: crypto.randomUUID(), qty: round(qty), expiry, receivedAt: t }];
    stock = round(stock + qty);
    const costPerUnit = m.cost > 0 && qty > 0 ? money(m.cost / qty) : ing.costPerUnit || 0;
    move = { ...base, type: "purchase", qty: round(qty), cost: money(m.cost || qty * costPerUnit), expiry };
    await db.collection("ingredients").updateOne(
      { _id: ing._id },
      { $set: { stock, batches, tracked: true, costPerUnit, lastPurchaseAt: t, updatedAt: t } }
    );
    // A restock settles "running out" alerts for this item.
    await db.collection("kitchenAlerts").updateMany({ shopId, ingredientId: String(ing._id), type: { $in: ["low", "out"] }, resolvedAt: null }, { $set: { resolvedAt: t } });
  } else if (m.type === "waste" || m.type === "expired") {
    let take = qty;
    if (m.type === "expired" && m.batchId) {
      const b = batches.find((x) => x.id === m.batchId);
      take = b ? b.qty : 0;
      batches = batches.filter((x) => x.id !== m.batchId);
    } else batches = drawBatches(batches, take);
    stock = round(stock - take);
    const cost = money(take * (ing.costPerUnit || 0));
    move = { ...base, type: m.type, qty: -round(take), reason: m.reason || (m.type === "expired" ? "expired" : "other"), photo: m.photo || undefined, cost };
    await db.collection("ingredients").updateOne({ _id: ing._id }, { $set: { stock, batches, updatedAt: t } });
    alerts.push({
      type: "waste",
      level: cost >= 200 ? "high" : "info",
      message: `${fmtQty(take, ing.unit)} ${ing.name} ${m.type === "expired" ? "expired" : m.reason === "spilled" ? "spilled" : `wasted (${m.reason || "other"})`} · ₹${cost} · by ${who.staffName}`,
    });
  } else if (m.type === "count") {
    const counted = round(qty);
    const diff = round(counted - stock);
    batches = diff < 0 ? drawBatches(batches, -diff) : diff > 0 ? [...batches, { id: crypto.randomUUID(), qty: diff, expiry: null, receivedAt: t }] : batches;
    move = { ...base, type: "count", qty: diff, expected: round(stock), counted, cost: money(diff * (ing.costPerUnit || 0)) };
    // Small differences (5%, or a pinch) are normal kitchen noise.
    const pinch = { kg: 0.05, L: 0.05, g: 50, ml: 50, pcs: 1, dozen: 0.1, packet: 1 }[ing.unit] ?? 0;
    const tolerance = Math.max(Math.abs(stock) * 0.05, pinch);
    if (ing.tracked && diff < 0 && Math.abs(diff) > tolerance) {
      alerts.push({
        type: "variance",
        level: Math.abs(move.cost) >= 200 ? "high" : "warn",
        message: `${ing.name}: expected ${fmtQty(stock, ing.unit)}, counted ${fmtQty(counted, ing.unit)} (${fmtQty(-diff, ing.unit)} missing, ₹${Math.abs(move.cost)}) · by ${who.staffName}`,
      });
    }
    stock = counted;
    await db.collection("ingredients").updateOne({ _id: ing._id }, { $set: { stock, batches, tracked: true, lastCountAt: t, updatedAt: t } });
  } else {
    return { ok: false, error: "Unknown entry type." };
  }

  try {
    await logMoves(db, [move]);
  } catch (err) {
    if (err.code === 11000) return { ok: true, duplicate: true }; // already recorded (sent twice)
    throw err;
  }
  for (const a of alerts) await raiseAlert(db, shopId, { ...a, ingredientId: String(ing._id), key: `${a.type}:${String(ing._id)}:${t.getTime()}` });
  await checkLowStock(db, shopId, [ing._id]);
  return { ok: true };
}

// ---------- Alerts ----------
export async function raiseAlert(db, shopId, a) {
  await db.collection("kitchenAlerts").updateOne(
    { shopId, key: a.key, resolvedAt: null },
    { $set: { ...a, shopId, updatedAt: now() }, $setOnInsert: { createdAt: now(), resolvedAt: null } },
    { upsert: true }
  );
}

// Average use per day over the last `days` days (from the log).
export async function dailyUse(db, shopId, ids, days = 14) {
  const since = new Date(now().getTime() - days * DAY);
  const rows = await db
    .collection("stockMoves")
    .aggregate([
      { $match: { shopId, type: "used", at: { $gte: since }, ...(ids && { ingredientId: { $in: ids.map(String) } }) } },
      { $group: { _id: "$ingredientId", used: { $sum: { $abs: "$qty" } }, first: { $min: "$at" } } },
    ])
    .toArray();
  return new Map(
    rows.map((r) => {
      const span = Math.max(1, Math.min(days, (now() - new Date(r.first)) / DAY));
      return [r._id, r.used / span];
    })
  );
}

// Low / out of stock: below the minimum, or less than ~1.5 days left at the usual pace.
export async function checkLowStock(db, shopId, ids) {
  const ings = await db.collection("ingredients").find({ shopId, _id: { $in: ids }, tracked: true }).toArray();
  const use = await dailyUse(db, shopId, ings.map((i) => i._id));
  for (const ing of ings) {
    const perDay = use.get(String(ing._id)) || 0;
    const daysLeft = perDay > 0 ? ing.stock / perDay : Infinity;
    const out = ing.stock <= 0;
    const low = out || (ing.minStock > 0 && ing.stock <= ing.minStock) || daysLeft < 1.5;
    const key = `stock:${String(ing._id)}`;
    if (!low) {
      await db.collection("kitchenAlerts").updateMany({ shopId, key, resolvedAt: null }, { $set: { resolvedAt: now() } });
      continue;
    }
    const buy = suggestQty(ing, perDay);
    const left = out ? "finished" : `${fmtQty(ing.stock, ing.unit)} left${perDay > 0 ? `, enough for ~${daysLeft < 1 ? `${Math.max(1, Math.round(daysLeft * 24))} hours` : `${Math.round(daysLeft * 10) / 10} days`}` : ""}`;
    await raiseAlert(db, shopId, {
      key,
      type: out ? "out" : "low",
      level: out ? "high" : "warn",
      ingredientId: String(ing._id),
      message: `${ing.name}: ${left}. Please arrange ${fmtQty(buy, ing.unit)}.`,
      data: { stock: ing.stock, perDay, buy },
    });
  }
}

// How much to buy: enough for `coverDays` at the usual pace plus the minimum, rounded nicely.
export function suggestQty(ing, perDay, coverDays = 3) {
  const target = perDay * coverDays + (ing.minStock || 0);
  let need = Math.max(target - Math.max(ing.stock, 0), ing.minStock || 0, 0);
  if (!(need > 0)) need = perDay > 0 ? perDay * coverDays : ing.minStock || 1;
  const step = ["g", "ml"].includes(ing.unit) ? 100 : ["pcs", "packet"].includes(ing.unit) ? 1 : need < 2 ? 0.25 : need < 10 ? 0.5 : 1;
  return Math.ceil(need / step) * step;
}

// Expiring-soon and expired batches (run when alerts are opened and in the daily job).
export async function checkExpiry(db, shopId) {
  const t = now();
  const ings = await db.collection("ingredients").find({ shopId, "batches.expiry": { $ne: null } }).toArray();
  const dishes = await db.collection("recipes").find({ shopId }, { projection: { itemName: 1, variants: 1 } }).toArray();
  for (const ing of ings) {
    for (const b of ing.batches || []) {
      if (!b.expiry || !(b.qty > 0)) continue;
      const days = (new Date(b.expiry) - t) / DAY;
      if (days > EXPIRY_WARN_DAYS) continue;
      const uses = dishes.filter((d) => Object.values(d.variants || {}).some((v) => v.some((p) => p.ingredientId === String(ing._id)))).map((d) => d.itemName).slice(0, 3);
      await raiseAlert(db, shopId, {
        key: `expiry:${b.id}`,
        type: days < 0 ? "expired" : "expiring",
        level: days < 1 ? "high" : "warn",
        ingredientId: String(ing._id),
        batchId: b.id,
        message:
          days < 0
            ? `${fmtQty(b.qty, ing.unit)} ${ing.name} has expired. Remove it and mark it Expired.`
            : `${fmtQty(b.qty, ing.unit)} ${ing.name} expires ${days < 1 ? "today" : "tomorrow"}.${uses.length ? ` Use it first in ${uses.join(", ")}.` : ""}`,
      });
    }
  }
}

// ---------- Shopping list ----------
export async function shoppingList(db, shopId, { coverDays = 3 } = {}) {
  const ings = await db.collection("ingredients").find({ shopId, tracked: true }).toArray();
  const use = await dailyUse(db, shopId, null);
  const list = [];
  for (const ing of ings) {
    const perDay = use.get(String(ing._id)) || 0;
    const daysLeft = perDay > 0 ? ing.stock / perDay : Infinity;
    const below = ing.stock <= 0 || (ing.minStock > 0 && ing.stock <= ing.minStock) || daysLeft < coverDays;
    if (!below) continue;
    const qty = suggestQty(ing, perDay, coverDays);
    list.push({
      ingredientId: String(ing._id),
      name: ing.name,
      category: ing.category || "Other",
      unit: ing.unit,
      stock: round(ing.stock),
      perDay: round(perDay),
      daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft * 10) / 10 : null,
      qty,
      cost: money(qty * (ing.costPerUnit || 0)),
      urgent: ing.stock <= 0 || daysLeft < 1,
    });
  }
  list.sort((a, b) => a.category.localeCompare(b.category) || (b.urgent - a.urgent) || a.name.localeCompare(b.name));
  return { coverDays, items: list, total: money(list.reduce((s, i) => s + i.cost, 0)) };
}

// ---------- Report ----------
export async function kitchenReport(db, shopId, start, end) {
  const moves = await db.collection("stockMoves").find({ shopId, at: { $gte: start, $lt: end } }).toArray();
  const byIng = new Map();
  const add = (m) => {
    const r = byIng.get(m.ingredientId) || { name: m.name, unit: m.unit, used: 0, usedCost: 0, purchased: 0, purchaseCost: 0, wasted: 0, wasteCost: 0, missing: 0, missingCost: 0 };
    if (m.type === "used") (r.used += -m.qty), (r.usedCost += m.cost || 0);
    if (m.type === "purchase") (r.purchased += m.qty), (r.purchaseCost += m.cost || 0);
    if (m.type === "waste" || m.type === "expired") (r.wasted += -m.qty), (r.wasteCost += m.cost || 0);
    if (m.type === "count" && m.qty < 0) (r.missing += -m.qty), (r.missingCost += -(m.cost || 0));
    byIng.set(m.ingredientId, r);
  };
  moves.forEach(add);
  const rows = [...byIng.values()].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? round(v, 2) : v])));
  const [sales] = await db
    .collection("bills")
    .aggregate([{ $match: { shopId, status: "paid", createdAt: { $gte: start, $lt: end } } }, { $group: { _id: null, total: { $sum: "$total" } } }])
    .toArray();
  const usedCost = money(rows.reduce((s, r) => s + r.usedCost, 0));
  const wasteCost = money(rows.reduce((s, r) => s + r.wasteCost, 0));
  const missingCost = money(rows.reduce((s, r) => s + r.missingCost, 0));
  const salesTotal = money(sales?.total || 0);
  const wasteEntries = moves
    .filter((m) => m.type === "waste" || m.type === "expired")
    .map((m) => ({ at: m.at, name: m.name, qty: -m.qty, unit: m.unit, reason: m.reason, cost: m.cost, by: m.staffName || "Owner" }));
  return {
    rows: rows.sort((a, b) => b.usedCost - a.usedCost),
    totals: {
      sales: salesTotal,
      usedCost,
      wasteCost,
      missingCost,
      purchaseCost: money(rows.reduce((s, r) => s + r.purchaseCost, 0)),
      foodCostPct: salesTotal > 0 ? Math.round(((usedCost + wasteCost) / salesTotal) * 1000) / 10 : null,
    },
    waste: wasteEntries,
  };
}

// Cost to make one plate of each variant, from ingredient prices.
export function plateCost(recipe, ingById) {
  const out = {};
  for (const [label, parts] of Object.entries(recipe.variants || {})) {
    out[label] = money(
      parts.reduce((s, p) => {
        const ing = ingById.get(p.ingredientId);
        const q = ing ? convert(p.qty, p.unit, ing.unit) : null;
        return s + (q && ing.costPerUnit ? q * ing.costPerUnit : 0);
      }, 0)
    );
  }
  return out;
}
