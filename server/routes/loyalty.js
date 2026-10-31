// Loyalty streak (Settings › Loyalty streak): order on N days in a row and the next visit's dish is
// free. Visit days come from bills with the customer's mobile and accepted QR orders, so nothing
// extra is stored per visit. Each earned reward is one loyaltyRewards record, used once (by an
// order or bill `ref`) and given back if that order is cancelled.
import { ObjectId } from "mongodb";
import { z } from "zod";
import { HttpError } from "../http.js";
import { cleanMobile } from "./customers.js";
import { rateLimit, clientIp } from "../limits.js";
import { istDay } from "../../shared/hours.js";
import { addDays, streakInfo, LOYALTY_DEFAULTS } from "../../shared/loyalty.js";

const WINDOW_DAYS = 45;
const NOT_VISITS = ["new", "rejected", "unpaid"];

// The shop's rule, or null when it's off or has no free dish.
export function loyaltyRule(shop) {
  const l = { ...LOYALTY_DEFAULTS, ...(shop.loyalty || {}) };
  return l.on && ObjectId.isValid(l.dishId) ? l : null;
}

// The ways a mobile may be written on old bills and customers.
const phoneForms = (p) => [p, `+91${p}`, `+91 ${p}`, `0${p}`, `${p.slice(0, 5)} ${p.slice(5)}`, `+91 ${p.slice(0, 5)} ${p.slice(5)}`];

// Visit days of one mobile, or of every mobile (Map phone -> days) when phone is null.
async function visitDays(db, shopId, phone) {
  const since = new Date(Date.now() - WINDOW_DAYS * 864e5);
  const [bills, orders] = await Promise.all([
    db
      .collection("bills")
      .find({ shopId, status: "paid", createdAt: { $gte: since }, ...(phone ? { "customer.phone": { $in: phoneForms(phone) } } : { "customer.phone": { $nin: [null, ""] } }) }, { projection: { createdAt: 1, "customer.phone": 1 } })
      .toArray(),
    db
      .collection("orders")
      .find({ shopId, createdAt: { $gte: since }, status: { $nin: NOT_VISITS }, ...(phone ? { customerPhone: phone } : { customerPhone: { $nin: [null, ""] } }) }, { projection: { createdAt: 1, customerPhone: 1 } })
      .toArray(),
  ]);
  const map = new Map();
  const add = (p, at) => {
    const m = cleanMobile(p);
    if (!m) return;
    if (!map.has(m)) map.set(m, new Set());
    map.get(m).add(istDay(at));
  };
  for (const b of bills) add(b.customer.phone, b.createdAt);
  for (const o of orders) add(o.customerPhone, o.createdAt);
  return phone ? map.get(phone) || new Set() : map;
}

async function dishOf(db, shop, rule) {
  const m = await db.collection("menuItems").findOne({ _id: new ObjectId(rule.dishId), shopId: shop._id });
  if (!m) return null;
  const v = m.variants.find((x) => (x.label || "") === rule.variant) || m.variants[0];
  return { id: String(m._id), name: m.name, variant: v?.label || "", category: m.category || "", price: v?.price || 0 };
}

// The streak of one mobile, with any rewards it earned saved (and the one waiting, if any).
export async function loyaltyState(db, shop, phone) {
  const rule = loyaltyRule(shop);
  if (!rule || !phone) return null;
  const today = istDay();
  const rewards = db.collection("loyaltyRewards");
  const last = await rewards.findOne({ shopId: shop._id, phone }, { sort: { earnedDay: -1 } });
  const info = streakInfo(await visitDays(db, shop._id, phone), { today, need: rule.days, after: last?.earnedDay || "", since: rule.since || "" });
  for (const day of info.earned) {
    await rewards.updateOne(
      { shopId: shop._id, phone, earnedDay: day },
      { $setOnInsert: { shopId: shop._id, phone, earnedDay: day, validTo: addDays(day, rule.validDays), usedAt: null, ref: null, createdAt: new Date() } },
      { upsert: true }
    );
  }
  // The reward can't be used on the day it was earned (that visit was day N of the streak).
  const waiting = await rewards.findOne({ shopId: shop._id, phone, usedAt: null, earnedDay: { $lt: today }, validTo: { $gte: today } }, { sort: { earnedDay: 1 } });
  return { need: rule.days, count: info.count, visitedToday: info.visitedToday, reward: waiting ? { id: String(waiting._id), validTo: waiting.validTo } : null, rule };
}

// Takes the waiting reward for this order or bill (`ref`); the same ref twice gets the same one.
export async function useReward(db, shop, phone, ref) {
  const rewards = db.collection("loyaltyRewards");
  const had = await rewards.findOne({ shopId: shop._id, ref });
  if (had) return had;
  const st = await loyaltyState(db, shop, phone);
  if (!st?.reward) return null;
  const today = istDay();
  return rewards.findOneAndUpdate(
    { shopId: shop._id, phone, usedAt: null, earnedDay: { $lt: today }, validTo: { $gte: today } },
    { $set: { usedAt: new Date(), ref } },
    { sort: { earnedDay: 1 }, returnDocument: "after" }
  );
}

// The order was cancelled: the reward can be used again.
export async function releaseReward(db, shopId, ref) {
  await db.collection("loyaltyRewards").updateOne({ shopId, ref }, { $set: { usedAt: null, ref: null } });
}

// The free line for an order or bill.
export const freeLine = (dish) => ({ itemId: dish.id, name: dish.name, variant: dish.variant, category: dish.category, qty: 1, rate: 0, free: "loyalty" });

// What a screen shows: streak, what's needed, the free dish, and a waiting reward.
async function view(db, shop, phone) {
  const st = await loyaltyState(db, shop, phone);
  if (!st) return { on: false };
  return { on: true, count: st.count, need: st.need, visitedToday: st.visitedToday, reward: st.reward, dish: await dishOf(db, shop, st.rule) };
}

export { dishOf };

export default [
  // Billing: the chosen customer's streak and any free dish waiting.
  [
    "GET",
    "/loyalty/check/:phone",
    async ({ db, shop, params }) => {
      const phone = cleanMobile(params.phone);
      if (!phone) return { on: !!loyaltyRule(shop) };
      return view(db, shop, phone);
    },
    { manager: true },
  ],
  // Customers › Streak reminders: everyone with a mobile, closest to a reward first.
  [
    "GET",
    "/loyalty/customers",
    async ({ db, shop }) => {
      const rule = loyaltyRule(shop);
      if (!rule) throw new HttpError(400, "Turn on the loyalty streak in Settings first.");
      const today = istDay();
      const [all, customers, rewards] = await Promise.all([
        visitDays(db, shop._id, null),
        db.collection("customers").find({ shopId: shop._id }, { projection: { name: 1, phone: 1, clientId: 1 } }).limit(5000).toArray(),
        db.collection("loyaltyRewards").find({ shopId: shop._id, validTo: { $gte: addDays(today, -60) } }).toArray(),
      ]);
      const lastEarned = new Map();
      const waiting = new Map();
      for (const r of rewards) {
        if (!lastEarned.has(r.phone) || r.earnedDay > lastEarned.get(r.phone)) lastEarned.set(r.phone, r.earnedDay);
        if (!r.usedAt && r.earnedDay < today && r.validTo >= today) waiting.set(r.phone, { validTo: r.validTo });
      }
      const seen = new Set();
      const list = [];
      for (const c of customers) {
        const phone = cleanMobile(c.phone);
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        const info = streakInfo(all.get(phone) || [], { today, need: rule.days, after: lastEarned.get(phone) || "", since: rule.since || "" });
        // Earned but not saved yet (nobody looked since): it's waiting from tomorrow.
        const fresh = info.earned.filter((d) => d < today && addDays(d, rule.validDays) >= today).pop();
        const reward = waiting.get(phone) || (fresh ? { validTo: addDays(fresh, rule.validDays) } : null);
        list.push({ clientId: c.clientId, name: c.name, phone, count: info.count, reward });
      }
      list.sort((a, z) => !!z.reward - !!a.reward || z.count - a.count || a.name.localeCompare(z.name));
      return { customers: list, need: rule.days, dish: await dishOf(db, shop, rule) };
    },
  ],
  // The QR cart: this mobile's streak, and whether a free dish will be added.
  [
    "POST",
    "/public/shop/:token/loyalty",
    async ({ db, params, body, req }) => {
      const shop = /^[A-Za-z0-9_-]{16,40}$/.test(params.token || "") && (await db.collection("shops").findOne({ orderToken: params.token }, { projection: { qrImage: 0 } }));
      if (!shop) throw new HttpError(404, "This QR code isn't valid any more. Please ask the staff.");
      const phone = cleanMobile(z.object({ phone: z.string().max(20) }).parse(body).phone);
      if (!phone || !loyaltyRule(shop)) return { on: !!loyaltyRule(shop) };
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `loyalty-try:ip:${ip}`, 60, "Too many tries. Please try again later.");
      const v = await view(db, shop, phone);
      return { on: v.on, count: v.count, need: v.need, visitedToday: v.visitedToday, reward: !!v.reward, dish: v.dish && { name: v.dish.name, variant: v.dish.variant } };
    },
    { auth: false },
  ],
];
