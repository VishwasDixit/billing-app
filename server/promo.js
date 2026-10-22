// Promo codes for plan payments, managed by the admin. A code takes a percent or a
// flat amount off the shop's plan price (after any special price the admin set).
// Uses are counted from payments that are pending or approved.
import { HttpError } from "./http.js";

export const normalizeCode = (c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "");
const USED = ["pending", "approved"];

export const discountFor = (promo, amount) => {
  const off = promo.type === "percent" ? Math.round((amount * promo.value) / 100) : Math.round(promo.value);
  return Math.min(off, amount - 1); // payments need at least ₹1
};

export function describePromo(p) {
  const what = p.type === "percent" ? `${p.value}% off` : `₹${p.value} off`;
  const plans = p.plans.length === 2 ? "" : ` the ${p.plans[0]} plan`;
  return `${what}${plans}`;
}

export async function promoUses(db, code) {
  return db.collection("payments").countDocuments({ promoCode: code, status: { $in: USED } });
}

// Checks a code for this shop. Returns the promo, or throws a friendly 400.
export async function findPromo(db, shop, rawCode, planId = null, now = new Date()) {
  const code = normalizeCode(rawCode);
  if (!code) throw new HttpError(400, "Enter a promo code.");
  const p = await db.collection("promoCodes").findOne({ _id: code });
  if (!p || !p.active) throw new HttpError(400, "This promo code isn't valid.");
  if (p.validFrom && new Date(p.validFrom) > now) throw new HttpError(400, "This promo code isn't active yet.");
  if (p.validUntil && new Date(p.validUntil) < now) throw new HttpError(400, "This promo code has expired.");
  if (planId && !p.plans.includes(planId)) throw new HttpError(400, `This promo code is only for the ${p.plans.join(" / ")} plan.`);
  if (p.maxUses && (await promoUses(db, code)) >= p.maxUses) throw new HttpError(400, "This promo code has been fully used.");
  if (p.onePerShop !== false && (await db.collection("payments").findOne({ shopId: shop._id, promoCode: code, status: { $in: USED } }))) {
    throw new HttpError(400, "You've already used this promo code.");
  }
  return p;
}

// The plan with the promo applied: { ...plan, amount, promo: { code, off, label } }.
export function applyPromo(plan, promo) {
  if (!promo || !promo.plans.includes(plan.id)) return plan;
  const off = discountFor(promo, plan.amount);
  if (off <= 0) return plan;
  return { ...plan, amount: plan.amount - off, beforePromo: plan.amount, promo: { code: promo._id, off, label: describePromo(promo) } };
}
