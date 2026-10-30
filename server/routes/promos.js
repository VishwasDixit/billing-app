// Promo codes (Settings › Promo codes). The owner manages them; staff apply them at Billing;
// customers type them when ordering from a table QR. Every use is one promoUses record, so a
// limit holds under load and a retried upload never counts twice.
import { ObjectId } from "mongodb";
import { z } from "zod";
import { HttpError } from "../http.js";
import { checkPromo, cleanCode, CODE_RE, tablesText } from "../../shared/promo.js";
import { cleanMobile } from "./customers.js";

// Mobiles a code was sent to (Customers › Send offer): cleaned to 10 digits, bad ones dropped.
const Phones = z.array(z.string().max(20)).max(5000).transform((l) => [...new Set(l.map(cleanMobile).filter(Boolean))]);

const Day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "use a date like 2026-12-31");
const Time = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "use a time like 15:00");
const PromoIn = z
  .object({
    code: z.string().transform(cleanCode).refine((c) => CODE_RE.test(c), "Use 3–20 letters or numbers for the code, like WELCOME10."),
    description: z.string().trim().max(80).default(""),
    type: z.enum(["percent", "flat"]),
    value: z.number().positive("enter the discount"),
    maxDiscount: z.number().min(0).max(1e6).default(0),
    minOrder: z.number().min(0).max(1e7).default(0),
    validFrom: Day.default(""),
    validTo: Day.default(""),
    active: z.boolean().default(true),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    timeFrom: Time.default(""),
    timeTo: Time.default(""),
    maxUses: z.number().int().min(0).max(1e6).default(0),
    onePerPhone: z.boolean().default(false),
    where: z.enum(["both", "qr", "billing"]).default("both"),
    showOnMenu: z.boolean().default(false),
    // Only at these tables (empty = everywhere).
    tables: z.array(z.string().max(20)).max(1000).default([]),
    // Only these customers can use it (empty = anyone with the code).
    phones: Phones.default([]),
  })
  .refine((p) => p.type === "flat" || p.value <= 100, { message: "A percentage can't be more than 100.", path: ["value"] })
  .refine((p) => p.type === "percent" || p.value <= 1e6, { message: "That discount is too big.", path: ["value"] })
  .refine((p) => !p.validFrom || !p.validTo || p.validFrom <= p.validTo, { message: "The end date is before the start date.", path: ["validTo"] })
  .refine((p) => !p.timeFrom === !p.timeTo, { message: "Set both the start and end time, or neither.", path: ["timeTo"] })
  // A code for invited customers isn't advertised on the menu.
  .transform((p) => ({ ...p, days: [...new Set(p.days)].sort(), tables: [...new Set(p.tables)], showOnMenu: p.showOnMenu && !p.phones.length }));

function checkTables(shop, p) {
  const ids = new Set((shop.tables || []).map((t) => t.id));
  const bad = p.tables.filter((t) => !ids.has(t));
  if (bad.length) throw new HttpError(400, `These tables aren't set up: ${bad.slice(0, 5).join(", ")}. Save your tables first.`);
}

export const publicPromo = ({ _id, shopId, ...p }) => ({ ...p, id: String(_id), uses: p.uses || 0, discountGiven: p.discountGiven || 0 });

export async function findPromo(db, shopId, code) {
  const c = cleanCode(code);
  const p = CODE_RE.test(c) ? await db.collection("promos").findOne({ shopId, code: c, archived: { $ne: true } }) : null;
  if (!p) throw new HttpError(404, `“${c.slice(0, 20) || "This"}” isn't a valid code.`, { code: "PROMO" });
  return p;
}

const usedByPhone = async (db, p, phone) => !!(p.onePerPhone && phone && (await db.collection("promoUses").findOne({ promoId: p._id, phone })));

// The discount a code gives, or a 400 with the reason.
export async function promoDiscount(db, shop, code, { subtotal, where, phone, table = "" }) {
  const p = await findPromo(db, shop._id, code);
  const r = checkPromo(p, { subtotal, where, table, tableNames: tablesText(p.tables, shop.tables), usedByPhone: await usedByPhone(db, p, phone), cur: shop.currency || "₹", phone });
  if (!r.ok) throw new HttpError(400, r.reason, { code: "PROMO" });
  return { promo: p, amount: r.amount };
}

// Counts one use for `ref` (an order or bill client id). Within limits unless `force`
// (a bill made offline already gave the discount). Idempotent per ref.
export async function reservePromo(db, p, { ref, phone = "", amount, force = false }) {
  const inc = await db
    .collection("promoUses")
    .findOne({ promoId: p._id, ref }, { projection: { _id: 1 } });
  if (inc) return false;
  const limit = !force && p.maxUses > 0 ? { uses: { $lt: p.maxUses } } : {};
  const r = await db.collection("promos").updateOne({ _id: p._id, ...limit }, { $inc: { uses: 1, discountGiven: amount } });
  if (!r.modifiedCount) throw new HttpError(400, "This code has been fully used.", { code: "PROMO" });
  try {
    await db.collection("promoUses").insertOne({
      shopId: p.shopId, promoId: p._id, code: p.code, ref, amount, at: new Date(),
      ...(phone && { phone }),
      // Unique per code while "once per mobile" is on (the index only covers this field).
      ...(p.onePerPhone && phone && !force && { phoneKey: phone }),
    });
    return true;
  } catch (err) {
    await db.collection("promos").updateOne({ _id: p._id }, { $inc: { uses: -1, discountGiven: -amount } });
    if (err?.code !== 11000) throw err;
    if (/phoneKey/.test(err.message)) throw new HttpError(400, "This code was already used on this mobile number.", { code: "PROMO" });
    return false; // same ref sent twice
  }
}

// Gives the use back (the order was rejected).
export async function releasePromo(db, shopId, ref) {
  const u = await db.collection("promoUses").findOneAndDelete({ shopId, ref });
  if (u) await db.collection("promos").updateOne({ _id: u.promoId }, { $inc: { uses: -1, discountGiven: -(u.amount || 0) } });
}

// Codes advertised on the customer menu that can be used today or later (day and time rules
// are shown with the offer rather than hiding it).
export async function menuOffers(db, shop) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const list = await db.collection("promos").find({ shopId: shop._id, showOnMenu: true, active: true, archived: { $ne: true }, where: { $ne: "billing" }, "phones.0": { $exists: false } }).limit(10).toArray();
  return list
    .filter((p) => (!p.validFrom || p.validFrom <= today) && (!p.validTo || p.validTo >= today) && !(p.maxUses > 0 && p.uses >= p.maxUses))
    .map((p) => ({ code: p.code, description: p.description, type: p.type, value: p.value, maxDiscount: p.maxDiscount, minOrder: p.minOrder, days: p.days, timeFrom: p.timeFrom, timeTo: p.timeTo, onePerPhone: p.onePerPhone, tables: p.tables || [] }));
}

const byId = (db, shop, id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Code not found.");
  return db.collection("promos").findOne({ _id: new ObjectId(id), shopId: shop._id, archived: { $ne: true } });
};

export default [
  ["GET", "/promos", async ({ db, shop }) => ({ promos: (await db.collection("promos").find({ shopId: shop._id, archived: { $ne: true } }).sort({ createdAt: -1 }).toArray()).map(publicPromo) })],
  [
    "POST",
    "/promos",
    async ({ db, shop, body }) => {
      const p = PromoIn.parse(body);
      checkTables(shop, p);
      if (await db.collection("promos").countDocuments({ shopId: shop._id, archived: { $ne: true } }) >= 200) throw new HttpError(400, "You can have up to 200 codes. Delete old ones first.");
      const doc = { shopId: shop._id, ...p, uses: 0, discountGiven: 0, createdAt: new Date(), updatedAt: new Date() };
      try {
        doc._id = (await db.collection("promos").insertOne(doc)).insertedId;
      } catch (err) {
        if (err?.code === 11000) throw new HttpError(409, `You already have a code ${p.code}.`);
        throw err;
      }
      return { promo: publicPromo(doc) };
    },
  ],
  [
    "PUT",
    "/promos/:id",
    async ({ db, shop, params, body }) => {
      const cur = await byId(db, shop, params.id);
      if (!cur) throw new HttpError(404, "Code not found.");
      const p = PromoIn.parse(body);
      checkTables(shop, p);
      try {
        const u = await db.collection("promos").findOneAndUpdate({ _id: cur._id }, { $set: { ...p, updatedAt: new Date() } }, { returnDocument: "after" });
        return { promo: publicPromo(u) };
      } catch (err) {
        if (err?.code === 11000) throw new HttpError(409, `You already have a code ${p.code}.`);
        throw err;
      }
    },
  ],
  [
    "DELETE",
    "/promos/:id",
    async ({ db, shop, params }) => {
      const cur = await byId(db, shop, params.id);
      if (!cur) throw new HttpError(404, "Code not found.");
      // Used codes stay (archived) so old bills still make sense; the code itself is freed.
      if (cur.uses > 0) await db.collection("promos").updateOne({ _id: cur._id }, { $set: { archived: true, active: false, code: `${cur.code}~${cur._id}`, archivedCode: cur.code, updatedAt: new Date() } });
      else await db.collection("promos").deleteOne({ _id: cur._id });
      return { ok: true };
    },
  ],
  // Customers › Send offer with an existing code: more customers can use an invite-only code.
  [
    "POST",
    "/promos/:id/invite",
    async ({ db, shop, params, body }) => {
      const cur = await byId(db, shop, params.id);
      if (!cur) throw new HttpError(404, "Code not found.");
      const { phones } = z.object({ phones: Phones }).parse(body);
      if (!cur.phones?.length) return { promo: publicPromo(cur) }; // already open to everyone
      if (new Set([...cur.phones, ...phones]).size > 5000) throw new HttpError(400, "A code can be sent to up to 5000 customers.");
      const u = await db.collection("promos").findOneAndUpdate({ _id: cur._id }, { $addToSet: { phones: { $each: phones } }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
      return { promo: publicPromo(u) };
    },
  ],
  // Staff at Billing: what this code takes off this subtotal.
  [
    "POST",
    "/promos/check",
    async ({ db, shop, body }) => {
      const { code, subtotal, table, phone } = z.object({ code: z.string().max(40), subtotal: z.number().min(0).max(1e8), table: z.string().max(20).optional().default(""), phone: z.string().max(20).optional().default("") }).parse(body);
      const { promo, amount } = await promoDiscount(db, shop, code, { subtotal, where: "billing", table, phone: cleanMobile(phone) || "" });
      return { code: promo.code, amount, description: promo.description };
    },
    { manager: true },
  ],
];
