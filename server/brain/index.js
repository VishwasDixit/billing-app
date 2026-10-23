// Kitchen Brain: learns each kitchen's own patterns every day (and on demand) and turns them into
// plain advice: tomorrow's prep, learned reorder levels, recipe fixes, unusual waste, use-first dishes.
import { ObjectId } from "mongodb";
import { convert, fmtQty } from "../kitchen/units.js";
import { now, kitchenReport } from "../kitchen/inventory.js";
import { learnSeries, predict, stats, reorderPoint, leadTime, zScore, calibration } from "./model.js";

const DAY = 864e5;
const IST = 5.5 * 3600e3;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ymd = (t) => new Date(new Date(t).getTime() + IST).toISOString().slice(0, 10);
const weekdayOf = (key) => new Date(key + "T00:00:00Z").getUTCDay();
const addDays = (key, n) => new Date(Date.parse(key + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const SALES_DAYS = 56;
const STALE_MS = 6 * 3600e3;

function daysBetween(first, last) {
  const out = [];
  for (let k = first; k <= last; k = addDays(k, 1)) out.push(k);
  return out;
}

// Turns {day: amount} into a full daily series (zeros on days with nothing) up to `last`.
function series(byDay, first, last) {
  const keys = daysBetween(first, last);
  return { keys, y: keys.map((k) => byDay.get(k) || 0), wd: keys.map(weekdayOf) };
}

export async function learnKitchen(db, shopId) {
  const t = now();
  const today = ymd(t);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  // ---- 1. Dish demand: learn from finished days of bills ----
  const sales = await db
    .collection("bills")
    .aggregate([
      { $match: { shopId, createdAt: { $gte: new Date(t.getTime() - SALES_DAYS * DAY) }, status: { $ne: "void" } } },
      { $unwind: "$items" },
      { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "+05:30" } }, item: "$items.itemId", variant: "$items.variant" }, qty: { $sum: "$items.qty" }, name: { $first: "$items.name" } } },
    ])
    .toArray();
  const past = sales.filter((r) => r._id.day <= yesterday && /^[a-f0-9]{24}$/.test(String(r._id.item || "")));
  const firstDay = past.reduce((m, r) => (r._id.day < m ? r._id.day : m), yesterday);
  const salesDays = past.length ? daysBetween(firstDay, yesterday).length : 0;
  const dishes = new Map(); // key -> { itemId, variant, name, byDay }
  for (const r of past) {
    const key = `${r._id.item}|${r._id.variant || ""}`;
    const d = dishes.get(key) || { itemId: String(r._id.item), variant: r._id.variant || "", name: r.name, byDay: new Map(), total: 0 };
    d.byDay.set(r._id.day, (d.byDay.get(r._id.day) || 0) + r.qty);
    d.total += r.qty;
    dishes.set(key, d);
  }
  const forecast = []; // { itemId, variant, name, days: [qty for tomorrow + 6 more] }
  const models = [];
  for (const [key, d] of dishes) {
    if (d.total < 3) continue;
    const s = series(d.byDay, firstDay, yesterday);
    const m = learnSeries(s.y, s.wd);
    // Tomorrow is 2 days after the last finished day (today is still going on).
    const days = Array.from({ length: 7 }, (_, i) => round(predict(m, weekdayOf(addDays(tomorrow, i)), i + 2), 2));
    forecast.push({ itemId: d.itemId, variant: d.variant, name: d.name, days });
    models.push({ key, m });
  }

  // ---- 2. What tomorrow's dishes need from the kitchen ----
  const recipes = await db.collection("recipes").find({ shopId }).toArray();
  const recipeOf = new Map(recipes.map((r) => [r.itemId, r]));
  const ings = await db.collection("ingredients").find({ shopId }).toArray();
  const ingById = new Map(ings.map((i) => [String(i._id), i]));
  const need = new Map(); // ingredientId -> [7 days]
  for (const f of forecast) {
    const r = recipeOf.get(f.itemId);
    const parts = r?.variants?.[f.variant] || r?.variants?.[""] || Object.values(r?.variants || {})[0] || [];
    for (const p of parts) {
      const ing = ingById.get(p.ingredientId);
      const per = ing && convert(p.qty, p.unit, ing.unit);
      if (!(per > 0)) continue;
      const arr = need.get(p.ingredientId) || Array(7).fill(0);
      f.days.forEach((q, i) => (arr[i] += q * per));
      need.set(p.ingredientId, arr);
    }
  }

  // ---- 3. Usage pace, supplier delay and learned reorder levels ----
  const since28 = new Date(t.getTime() - 28 * DAY);
  const usedRows = await db
    .collection("stockMoves")
    .aggregate([
      { $match: { shopId, type: "used", at: { $gte: since28 } } },
      { $group: { _id: { ing: "$ingredientId", day: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "+05:30" } } }, qty: { $sum: { $abs: "$qty" } } } },
    ])
    .toArray();
  const usedBy = new Map();
  for (const r of usedRows) {
    if (r._id.day > yesterday) continue;
    const m = usedBy.get(r._id.ing) || new Map();
    m.set(r._id.day, r.qty);
    usedBy.set(r._id.ing, m);
  }
  const [purchases, lowAlerts] = await Promise.all([
    db.collection("stockMoves").find({ shopId, type: "purchase", at: { $gte: new Date(t.getTime() - 90 * DAY) } }, { projection: { ingredientId: 1, at: 1 } }).toArray(),
    db.collection("kitchenAlerts").find({ shopId, type: { $in: ["low", "out"] }, createdAt: { $gte: new Date(t.getTime() - 97 * DAY) } }, { projection: { ingredientId: 1, createdAt: 1 } }).toArray(),
  ]);

  const reorder = [];
  const updates = [];
  for (const ing of ings) {
    const id = String(ing._id);
    const byDay = usedBy.get(id);
    let mean = 0;
    let std = 0;
    let usageDays = 0;
    if (byDay?.size) {
      const first = [...byDay.keys()].sort()[0];
      const s = series(byDay, first, yesterday);
      ({ mean, std } = stats(s.y));
      usageDays = s.y.length;
    }
    const gaps = purchases
      .filter((p) => p.ingredientId === id)
      .map((p) => {
        const before = lowAlerts.filter((a) => a.ingredientId === id && a.createdAt < p.at && p.at - a.createdAt < 7 * DAY);
        return before.length ? (p.at - Math.max(...before.map((a) => a.createdAt.getTime()))) / DAY : 0;
      });
    const leadDays = round(leadTime(gaps), 2);
    const forecastNeed = need.get(id);
    // Prefer what tomorrow's forecast says; fall back to the recent pace.
    const perDay = forecastNeed && salesDays >= 7 ? Math.max(avg7(forecastNeed), 0) : mean;
    const learned = usageDays >= 14;
    const reorderAt = learned ? round(reorderPoint({ mean: Math.max(mean, perDay), std, leadDays })) : null;
    const brain = {
      perDay: round(perDay),
      std: round(std),
      leadDays,
      reorderAt,
      tomorrowNeed: forecastNeed ? round(forecastNeed[0]) : null,
      daysLeft: perDay > 0 ? round((ing.stock || 0) / perDay, 1) : null,
      usageDays,
      learnedAt: t,
    };
    updates.push({ updateOne: { filter: { _id: ing._id }, update: { $set: { brain } } } });
    if (ing.tracked && (perDay > 0 || reorderAt)) reorder.push({ ingredientId: id, name: ing.name, unit: ing.unit, stock: round(ing.stock || 0), ...brain, minStock: ing.minStock || 0 });
  }
  if (updates.length) await db.collection("ingredients").bulkWrite(updates);

  const prep = [...need]
    .map(([id, days]) => {
      const ing = ingById.get(id);
      return { ingredientId: id, name: ing.name, unit: ing.unit, need: round(days[0]), stock: round(ing.stock || 0), short: ing.tracked ? round(Math.max(0, days[0] - (ing.stock || 0))) : null };
    })
    .filter((p) => p.need > 0)
    .sort((a, b) => (b.short || 0) - (a.short || 0) || a.name.localeCompare(b.name));

  // ---- 4. Recipe check from stock counts ----
  await checkRecipes(db, shopId, t, ingById, recipes);

  // ---- 5. Use-first dishes for stock about to expire ----
  const specials = [];
  for (const ing of ings) {
    const soon = (ing.batches || []).filter((b) => b.qty > 0 && b.expiry && new Date(b.expiry) - t < 3 * DAY);
    if (!soon.length) continue;
    const qty = round(soon.reduce((s, b) => s + b.qty, 0));
    const inDays = Math.max(0, Math.round((Math.min(...soon.map((b) => new Date(b.expiry))) - t) / DAY));
    const uses = recipes
      .map((r) => {
        const parts = Object.values(r.variants || {})[Object.keys(r.variants || {}).length - 1] || []; // the biggest size
        const p = parts.find((x) => x.ingredientId === String(ing._id));
        const per = p && convert(p.qty, p.unit, ing.unit);
        return per > 0 ? { itemId: r.itemId, name: r.itemName, perPlate: round(per), plates: Math.ceil(qty / per) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.perPlate - a.perPlate)
      .slice(0, 3);
    specials.push({ ingredientId: String(ing._id), name: ing.name, unit: ing.unit, qty, inDays, value: Math.round(qty * (ing.costPerUnit || 0)), dishes: uses });
  }
  specials.sort((a, b) => a.inDays - b.inDays || b.value - a.value);

  // ---- 6. Plain-language findings ----
  const insights = await findInsights(db, shopId, t, { forecast, prep, specials, tomorrow });

  const tomorrowDishes = forecast
    .map((f) => ({ itemId: f.itemId, name: f.name, variant: f.variant, qty: Math.round(f.days[0]) }))
    .filter((d) => d.qty > 0)
    .sort((a, b) => b.qty - a.qty);
  const summary = {
    shopId,
    kind: "summary",
    learnedAt: t,
    salesDays,
    confidence: salesDays >= 28 ? "good" : salesDays >= 14 ? "fair" : "learning",
    tomorrow: { date: tomorrow, weekday: WEEKDAYS[weekdayOf(tomorrow)], plates: tomorrowDishes.reduce((s, d) => s + d.qty, 0), dishes: tomorrowDishes.slice(0, 20) },
    week: Array.from({ length: 7 }, (_, i) => ({ date: addDays(tomorrow, i), weekday: WEEKDAYS[weekdayOf(addDays(tomorrow, i))], plates: Math.round(forecast.reduce((s, f) => s + f.days[i], 0)) })),
    prep: prep.slice(0, 40),
    reorder: reorder.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9)).slice(0, 60),
    specials: specials.slice(0, 10),
    insights,
  };
  await db.collection("brainModels").updateOne({ shopId, kind: "summary" }, { $set: summary }, { upsert: true });
  if (models.length) {
    await db.collection("brainModels").deleteMany({ shopId, kind: "dish" });
    await db.collection("brainModels").insertMany(models.map(({ key, m }) => ({ shopId, kind: "dish", key, params: m, updatedAt: t })));
  }
  return summary;
}

const avg7 = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Compares counted stock with what recipes say was used since the first count in the last 30 days.
// A steady gap means the recipe is off (or stock goes missing): suggest a fix the owner can accept.
async function checkRecipes(db, shopId, t, ingById, recipes) {
  const since = new Date(t.getTime() - 30 * DAY);
  const counts = await db.collection("stockMoves").find({ shopId, type: "count", at: { $gte: since } }).sort({ at: 1 }).toArray();
  const byIng = new Map();
  for (const c of counts) byIng.set(c.ingredientId, [...(byIng.get(c.ingredientId) || []), c]);
  for (const [id, list] of byIng) {
    const ing = ingById.get(id);
    if (!ing || list.length < 3) continue; // a baseline count and at least two checks
    const start = list[0].at;
    const later = list.slice(1);
    const missing = -later.reduce((s, c) => s + c.qty, 0);
    const used = (
      await db.collection("stockMoves").aggregate([{ $match: { shopId, ingredientId: id, type: "used", at: { $gt: start, $lte: list.at(-1).at } } }, { $group: { _id: null, q: { $sum: { $abs: "$qty" } } } }]).toArray()
    )[0]?.q;
    const cal = calibration(missing, used);
    const key = `calibrate:${id}`;
    const existing = await db.collection("brainSuggestions").findOne({ shopId, key });
    // Same direction in most checks, and at least 8% off: not just counting noise.
    const sameWay = later.filter((c) => Math.sign(c.qty) === -Math.sign(missing)).length >= Math.ceil(later.length * 0.6);
    if (!cal || Math.abs(cal.ratio) < 0.08 || !sameWay) {
      if (existing?.status === "open") await db.collection("brainSuggestions").updateOne({ _id: existing._id }, { $set: { status: "settled", updatedAt: t } });
      continue;
    }
    if (existing && existing.status !== "open" && existing.status !== "settled" && t - existing.updatedAt < 14 * DAY) continue; // answered recently
    const dishes = recipes.filter((r) => Object.values(r.variants || {}).some((v) => v.some((p) => p.ingredientId === id))).map((r) => r.itemName);
    if (!dishes.length) continue;
    const pct = Math.round(Math.abs(cal.ratio) * 100);
    const more = cal.ratio > 0;
    const example = recipes.find((r) => r.itemName === dishes[0]);
    const part = Object.values(example.variants).flat().find((p) => p.ingredientId === id);
    const message = more
      ? `${dishes.length === 1 ? dishes[0] : `${dishes.length} dishes`} seem to use about ${pct}% more ${ing.name} than the recipe says (${fmtQty(missing, ing.unit)} less than expected over ${later.length} counts). Update the recipes${part ? `, e.g. ${dishes[0]} ${part.qty} → ${round(part.qty * cal.factor, 1)} ${part.unit}` : ""}? If the recipe is right, check for spills or stock going missing.`
      : `Counts show ${fmtQty(-missing, ing.unit)} more ${ing.name} than expected: recipes may use about ${pct}% less than written. Update ${dishes.length === 1 ? dishes[0] : `${dishes.length} dishes`}${part ? `, e.g. ${part.qty} → ${round(part.qty * cal.factor, 1)} ${part.unit}` : ""}?`;
    await db.collection("brainSuggestions").updateOne(
      { shopId, key },
      { $set: { type: "calibrate", ingredientId: id, name: ing.name, factor: round(cal.factor, 3), ratio: round(cal.ratio, 3), dishes, message, status: "open", updatedAt: t }, $setOnInsert: { createdAt: t } },
      { upsert: true }
    );
  }
}

async function findInsights(db, shopId, t, { prep, specials, tomorrow }) {
  const out = [];
  const since = new Date(t.getTime() - SALES_DAYS * DAY);
  const waste = await db.collection("stockMoves").find({ shopId, type: { $in: ["waste", "expired"] }, at: { $gte: since } }).toArray();
  const weekAgo = t.getTime() - 7 * DAY;

  // Unusual waste per item this week, against its own weekly history.
  const byIng = new Map();
  for (const w of waste) {
    const week = Math.floor((t - w.at) / (7 * DAY)); // 0 = this week
    const r = byIng.get(w.ingredientId) || { name: w.name, weeks: Array(8).fill(0) };
    if (week < 8) r.weeks[week] += w.cost || 0;
    byIng.set(w.ingredientId, r);
  }
  for (const r of byIng.values()) {
    const [now7, ...before] = r.weeks;
    if (now7 < 150) continue;
    const z = zScore(now7, before);
    const usual = before.reduce((s, x) => s + x, 0) / before.length;
    if (z >= 2.5) {
      out.push({ icon: "🗑️", level: "warn", impact: Math.round(now7 - usual), text: `${r.name} waste cost ${rupees(now7)} this week${usual > 0 ? `, ${Math.round(now7 / usual)}× the usual ${rupees(usual)}` : ", much more than usual"}. Check storage and portions.` });
    }
  }

  // Which weekday wastes most (8 weeks).
  const wdCost = Array(7).fill(0);
  for (const w of waste) wdCost[new Date(w.at.getTime() + IST).getUTCDay()] += w.cost || 0;
  const top = wdCost.indexOf(Math.max(...wdCost));
  const others = (wdCost.reduce((s, x) => s + x, 0) - wdCost[top]) / 6;
  if (wdCost[top] >= 300 && wdCost[top] >= 2 * Math.max(others, 1)) {
    const items = new Map();
    for (const w of waste.filter((x) => new Date(x.at.getTime() + IST).getUTCDay() === top)) items.set(w.name, (items.get(w.name) || 0) + (w.cost || 0));
    const worst = [...items].sort((a, b) => b[1] - a[1])[0];
    out.push({ icon: "📅", level: "info", impact: Math.round(wdCost[top] - others), text: `Most waste happens on ${WEEKDAYS[top]}s (${rupees(wdCost[top])} in 8 weeks, ${others > 0 ? `${Math.round(wdCost[top] / others)}×` : "far more than"} other days)${worst ? `, mostly ${worst[0]}` : ""}. Buy or prepare less the day before.` });
  }

  // One person behind most of the waste (only when several people log entries).
  const recent = waste.filter((w) => w.at >= new Date(t.getTime() - 28 * DAY) && w.staffName);
  const byStaff = new Map();
  for (const w of recent) {
    const s = byStaff.get(w.staffName) || { cost: 0, n: 0 };
    s.cost += w.cost || 0;
    s.n += 1;
    byStaff.set(w.staffName, s);
  }
  const total = [...byStaff.values()].reduce((s, x) => s + x.cost, 0);
  if (byStaff.size >= 2 && total >= 300) {
    const [name, s] = [...byStaff].sort((a, b) => b[1].cost - a[1].cost)[0];
    if (s.cost / total >= 0.6 && s.n >= 3) out.push({ icon: "👤", level: "info", impact: Math.round(s.cost), text: `${Math.round((s.cost / total) * 100)}% of waste in the last 4 weeks was logged by ${name} (${s.n} entries, ${rupees(s.cost)}). A quick word on handling may help.` });
  }

  // Stock missing in counts this week.
  const missing = await db.collection("stockMoves").find({ shopId, type: "count", qty: { $lt: 0 }, at: { $gte: new Date(weekAgo) } }).toArray();
  const missingCost = missing.reduce((s, m) => s + -(m.cost || 0), 0);
  if (missingCost >= 300) {
    const worst = missing.sort((a, b) => a.cost - b.cost)[0];
    out.push({ icon: "🔍", level: "warn", impact: Math.round(missingCost), text: `Counts found ${rupees(missingCost)} of stock missing this week (most: ${worst.name}). Check recipes, portions and storage.` });
  }

  // Food cost this week vs last week.
  const [thisWeek, lastWeek] = await Promise.all([
    kitchenReport(db, shopId, new Date(weekAgo), t),
    kitchenReport(db, shopId, new Date(weekAgo - 7 * DAY), new Date(weekAgo)),
  ]);
  const a = thisWeek.totals.foodCostPct;
  const b = lastWeek.totals.foodCostPct;
  if (a != null && b != null && Math.abs(a - b) >= 3) {
    out.push({ icon: a > b ? "📈" : "📉", level: a > b ? "warn" : "good", impact: Math.round(Math.abs(a - b) * (thisWeek.totals.sales || 0) / 100), text: `Food cost is ${a}% of sales this week (${b}% last week).${a > b ? " Check prices, portions and waste." : " Nice work."}` });
  } else if (a != null && a > 40) {
    out.push({ icon: "📈", level: "warn", impact: 0, text: `Food cost is ${a}% of sales this week. Most dhabas aim for 30–35%.` });
  }

  // Tomorrow: what to arrange today.
  const short = prep.filter((p) => p.short > 0);
  if (short.length) {
    out.push({ icon: "🛒", level: "warn", impact: 0, text: `For ${WEEKDAYS[weekdayOf(tomorrow)]} you'll likely need more ${short.slice(0, 4).map((p) => `${p.name} (${fmtQty(p.short, p.unit)} short)`).join(", ")}. Arrange it today.` });
  }
  if (specials[0]?.dishes[0] && specials[0].inDays <= 1) {
    const s = specials[0];
    out.push({ icon: "⭐", level: "info", impact: s.value, text: `Today's special idea: ${s.dishes[0].name}. It uses up ${fmtQty(s.qty, s.unit)} ${s.name} that expires ${s.inDays === 0 ? "today" : s.inDays === 1 ? "tomorrow" : `in ${s.inDays} days`} (~${s.dishes[0].plates} plates).` });
  }
  return out.sort((x, y) => (y.level === "warn") - (x.level === "warn") || y.impact - x.impact);
}

// The latest findings; recomputed when older than a few hours (or when asked).
export async function brainSummary(db, shopId, { fresh = false } = {}) {
  const s = await db.collection("brainModels").findOne({ shopId, kind: "summary" });
  const summary = !fresh && s && now() - s.learnedAt < STALE_MS ? s : await learnKitchen(db, shopId);
  const suggestions = await db.collection("brainSuggestions").find({ shopId, status: "open" }).sort({ updatedAt: -1 }).toArray();
  const { _id, shopId: _s, ...rest } = summary;
  return { ...rest, suggestions: suggestions.map(({ _id, shopId, ...x }) => ({ ...x, id: String(_id) })) };
}

// Owner accepted a recipe fix: scale that ingredient in every recipe that uses it.
export async function applySuggestion(db, shopId, id, by = "Owner") {
  const s = await db.collection("brainSuggestions").findOne({ _id: new ObjectId(id), shopId, status: "open" });
  if (!s) return { ok: false };
  const recipes = await db.collection("recipes").find({ shopId, ingredientIds: s.ingredientId }).toArray();
  for (const r of recipes) {
    const variants = Object.fromEntries(
      Object.entries(r.variants || {}).map(([k, parts]) => [
        k,
        parts.map((p) => (p.ingredientId === s.ingredientId ? { ...p, qty: round(p.qty * s.factor, ["kg", "L"].includes(p.unit) ? 3 : 1) } : p)),
      ])
    );
    await db.collection("recipes").updateOne({ _id: r._id }, { $set: { variants, updatedAt: now(), updatedBy: `${by} (Kitchen Brain)` } });
  }
  await db.collection("brainSuggestions").updateOne({ _id: s._id }, { $set: { status: "applied", updatedAt: now() } });
  return { ok: true, recipes: recipes.length };
}
