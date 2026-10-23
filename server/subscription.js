// Standard prices, plan lengths and the free trial. The admin changes them in Admin › Pricing;
// they live in settings { _id: "plans" } and are loaded (cached briefly) on every request.
import { PLAN_IDS } from "../shared/plans.js";

export const DEFAULT_PLAN_SETTINGS = Object.freeze({
  monthly: { amount: 49, days: 30 },
  halfyearly: { amount: 249, days: 180 },
  yearly: { amount: 400, days: 365 },
  trialDays: 3,
  yearlyBadge: "Best value",
});

export const PLANS = {
  monthly: { id: "monthly", name: "Monthly", amount: 49, days: 30 },
  halfyearly: { id: "halfyearly", name: "6 months", amount: 249, days: 180 },
  yearly: { id: "yearly", name: "Yearly", amount: 400, days: 365 },
};

let current = structuredClone(DEFAULT_PLAN_SETTINGS);
let loadedAt = 0;
const CACHE_MS = 30 * 1000;

function applySettings(doc) {
  const d = DEFAULT_PLAN_SETTINGS;
  current = {
    monthly: { ...d.monthly, ...(doc?.monthly || {}) },
    halfyearly: { ...d.halfyearly, ...(doc?.halfyearly || {}) },
    yearly: { ...d.yearly, ...(doc?.yearly || {}) },
    trialDays: doc?.trialDays ?? d.trialDays,
    yearlyBadge: doc?.yearlyBadge ?? d.yearlyBadge,
  };
  for (const id of PLAN_IDS) Object.assign(PLANS[id], current[id]);
}

export async function loadPlanSettings(db, { force = false } = {}) {
  if (force || Date.now() - loadedAt > CACHE_MS) {
    applySettings(await db.collection("settings").findOne({ _id: "plans" }));
    loadedAt = Date.now();
  }
  return current;
}

export const planSettings = () => current;
export const trialDays = () => current.trialDays;

const DAY = 24 * 60 * 60 * 1000;

// The plans with this shop's own prices (set by the admin) in place of the defaults.
export function plansFor(shop) {
  const custom = shop?.prices || {};
  return Object.fromEntries(
    Object.values(PLANS).map((p) => [p.id, { ...p, amount: custom[p.id] ?? p.amount, ...(custom[p.id] != null && custom[p.id] !== p.amount && { standardAmount: p.amount }) }])
  );
}

// Dashboard, profit & loss and report downloads are for paid plans (and the admin).
export const hasPaidFeatures = (status) => status?.state === "paid" || status?.state === "admin";

export const blockedMessage = (shop) =>
  `This shop has been blocked by the admin${shop.blocked?.reason ? `: ${shop.blocked.reason}` : ""}. Please contact support.`;

// The moment the shop's access ends: trial end or paid period end, whichever is later.
export function accessEndsAt(shop) {
  const trial = shop.trialEndsAt ? new Date(shop.trialEndsAt).getTime() : 0;
  const paid = shop.subscription?.currentPeriodEnd ? new Date(shop.subscription.currentPeriodEnd).getTime() : 0;
  return new Date(Math.max(trial, paid));
}

export function subscriptionStatus(shop, { isAdmin = false, now = new Date() } = {}) {
  const endsAt = accessEndsAt(shop);
  const paidEnd = shop.subscription?.currentPeriodEnd ? new Date(shop.subscription.currentPeriodEnd) : null;
  const onPaid = !!paidEnd && paidEnd > now;
  const active = isAdmin || endsAt > now;
  return {
    active,
    state: isAdmin ? "admin" : onPaid ? "paid" : active ? "trial" : "expired",
    plan: onPaid ? shop.subscription.plan : null,
    trialEndsAt: shop.trialEndsAt,
    endsAt,
    daysLeft: Math.max(0, Math.ceil((endsAt - now) / DAY)),
  };
}

// Extends the shop by `days` on top of any time still left (trial or paid).
export async function grantPlan(db, shopId, plan, days = PLANS[plan].days) {
  const shop = await db.collection("shops").findOne({ _id: shopId });
  const base = Math.max(Date.now(), accessEndsAt(shop).getTime());
  const end = new Date(base + days * DAY);
  await db.collection("shops").updateOne(
    { _id: shopId },
    { $set: { subscription: { plan, status: "active", currentPeriodEnd: end } } }
  );
  return end;
}
