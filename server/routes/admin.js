import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { hashPassword, isAdminEmail } from "../auth.js";
import { grantPlan, subscriptionStatus, plansFor, PLANS } from "../subscription.js";
import { recheckPendingLinks } from "./pay.js";
import { dueReminders, runReminders, lastRuns, REMIND_DAYS, reminderCooldownHours } from "../reminders.js";
import { emailOtpReady } from "../otp/mailer.js";

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Not found.");
  return new ObjectId(id);
};

const admin = { admin: true };

// The free MongoDB Atlas tier holds 512 MB (data + indexes). DB_LIMIT_MB overrides after an upgrade.
export const DB_LIMIT_MB = () => Number(process.env.DB_LIMIT_MB) || 512;

export default [
  [
    "GET",
    "/admin/storage",
    async ({ db }) => {
      const s = await db.stats();
      const coll = async (n) => {
        try {
          const c = await db.command({ collStats: n });
          return { count: c.count, bytes: (c.size || 0) + (c.totalIndexSize || 0), avg: c.avgObjSize || 0 };
        } catch {
          return { count: 0, bytes: 0, avg: 0 };
        }
      };
      const [bills, menuImages, shops] = await Promise.all([coll("bills"), coll("menuImages"), db.collection("shops").countDocuments()]);
      const used = (s.dataSize || 0) + (s.indexSize || 0);
      const limit = DB_LIMIT_MB() * 1024 * 1024;
      return {
        usedBytes: used,
        limitBytes: limit,
        percent: Math.round((used / limit) * 1000) / 10,
        shops,
        perShopBytes: shops ? Math.round(used / shops) : 0,
        bills: { count: bills.count, bytes: bills.bytes, perBillBytes: Math.round(bills.avg) },
        photos: menuImages,
      };
    },
    admin,
  ],
  // Who would get a plan reminder now, and the last few runs.
  [
    "GET",
    "/admin/reminders",
    async ({ db }) => {
      const due = await dueReminders(db);
      return {
        remindDays: REMIND_DAYS,
        cooldownHours: reminderCooldownHours,
        emailReady: await emailOtpReady(),
        auto: !!process.env.CRON_SECRET,
        due: due.map((d) => ({
          shopId: String(d.shop._id),
          shop: d.shop.name,
          owner: d.owner.name,
          email: d.owner.email,
          stage: d.stage,
          daysLeft: d.status.daysLeft,
          endsAt: d.status.endsAt,
          lastSentAt: d.shop.reminders?.lastAt || null,
          canSend: !d.recentlySent,
        })),
        runs: await lastRuns(db),
      };
    },
    admin,
  ],
  [
    "POST",
    "/admin/reminders/send",
    async ({ db, body }) => {
      const { shopIds } = z.object({ shopIds: z.array(z.string()).max(500).optional() }).parse(body || {});
      if (!(await emailOtpReady())) throw new HttpError(503, "Email isn't working right now (check the Gmail App password).");
      return runReminders(db, { trigger: "manual", shopIds: shopIds ?? null });
    },
    admin,
  ],
  [
    "GET",
    "/admin/shops",
    async ({ db }) => {
      const [shops, users, sales] = await Promise.all([
        db.collection("shops").find({}, { projection: { logo: 0 } }).sort({ createdAt: -1 }).toArray(),
        db.collection("users").find({}, { projection: { passwordHash: 0 } }).toArray(),
        db
          .collection("bills")
          .aggregate([{ $match: { status: "paid" } }, { $group: { _id: "$shopId", sales: { $sum: "$total" }, bills: { $sum: 1 }, lastBillAt: { $max: "$createdAt" } } }])
          .toArray(),
      ]);
      const owners = new Map(users.map((u) => [String(u.shopId), u]));
      const stats = new Map(sales.map((s) => [String(s._id), s]));
      return {
        shops: shops.map((s) => {
          const u = owners.get(String(s._id));
          const st = stats.get(String(s._id));
          return {
            id: String(s._id),
            name: s.name,
            createdAt: s.createdAt,
            owner: u ? { id: String(u._id), name: u.name, email: u.email, phone: u.phone } : null,
            status: subscriptionStatus(s, { isAdmin: !!u && isAdminEmail(u.email) }),
            sales: st?.sales || 0,
            bills: st?.bills || 0,
            lastBillAt: st?.lastBillAt || null,
            blocked: s.blocked || null,
            prices: { monthly: plansFor(s).monthly.amount, yearly: plansFor(s).yearly.amount, custom: !!(s.prices?.monthly != null || s.prices?.yearly != null) },
          };
        }),
      };
    },
    admin,
  ],
  [
    "GET",
    "/admin/payments",
    async ({ db, query }) => {
      const filter = query.status ? { status: query.status } : { status: { $ne: "created" } };
      const list = await db.collection("payments").find(filter).sort({ createdAt: -1 }).limit(200).toArray();
      const shops = await db
        .collection("shops")
        .find({ _id: { $in: [...new Set(list.map((p) => String(p.shopId)))].map((id) => new ObjectId(id)) } }, { projection: { name: 1 } })
        .toArray();
      const names = new Map(shops.map((s) => [String(s._id), s.name]));
      return { payments: list.map(({ _id, shopId, ...p }) => ({ ...p, id: String(_id), shopId: String(shopId), shopName: names.get(String(shopId)) || "?" })) };
    },
    admin,
  ],
  // Asks Razorpay about every pending payment-link entry and approves the paid ones.
  [
    "POST",
    "/admin/payments/recheck",
    async ({ db }) => {
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new HttpError(400, "Add your Razorpay API keys in Vercel first, then the app can check payments itself.");
      }
      return { approved: await recheckPendingLinks(db, {}, 100) };
    },
    admin,
  ],
  [
    "POST",
    "/admin/payments/:id/approve",
    async ({ db, params, user }) => {
      const p = await db
        .collection("payments")
        .findOneAndUpdate(
          { _id: oid(params.id), status: "pending" },
          { $set: { status: "approved", approvedAt: new Date(), approvedBy: user.email } },
          { returnDocument: "after" }
        );
      if (!p) throw new HttpError(404, "Payment not found or already handled.");
      const end = await grantPlan(db, p.shopId, p.plan);
      return { ok: true, currentPeriodEnd: end };
    },
    admin,
  ],
  [
    "POST",
    "/admin/payments/:id/reject",
    async ({ db, params, body, user }) => {
      const { reason } = z.object({ reason: z.string().trim().max(120).optional().default("") }).parse(body);
      const p = await db
        .collection("payments")
        .findOneAndUpdate(
          { _id: oid(params.id), status: "pending" },
          { $set: { status: "rejected", rejectReason: reason, rejectedAt: new Date(), rejectedBy: user.email } },
          { returnDocument: "after" }
        );
      if (!p) throw new HttpError(404, "Payment not found or already handled.");
      return { ok: true };
    },
    admin,
  ],
  [
    "POST",
    "/admin/shops/:id/extend",
    async ({ db, params, body }) => {
      const { plan, days } = z
        .object({ plan: z.enum(["monthly", "yearly"]).default("monthly"), days: z.number().int().min(1).max(3650).optional() })
        .parse(body);
      const shopId = oid(params.id);
      if (!(await db.collection("shops").findOne({ _id: shopId }))) throw new HttpError(404, "Shop not found.");
      const end = await grantPlan(db, shopId, plan, days ?? PLANS[plan].days);
      return { ok: true, currentPeriodEnd: end };
    },
    admin,
  ],
  // Block or unblock a shop. Blocked shops are logged out everywhere and can't log in.
  [
    "POST",
    "/admin/shops/:id/block",
    async ({ db, params, body, user }) => {
      const { blocked, reason } = z.object({ blocked: z.boolean(), reason: z.string().trim().max(160).optional().default("") }).parse(body);
      const shopId = oid(params.id);
      if (String(shopId) === String(user.shopId)) throw new HttpError(400, "You can't block your own admin shop.");
      const update = blocked ? { $set: { blocked: { at: new Date(), by: user.email, reason } } } : { $unset: { blocked: "" } };
      const { matchedCount } = await db.collection("shops").updateOne({ _id: shopId }, update);
      if (!matchedCount) throw new HttpError(404, "Shop not found.");
      // Blocking ends every session of that shop for good (unblocking needs a fresh login).
      if (blocked) await db.collection("users").updateMany({ shopId }, { $inc: { sessionVersion: 1 } });
      return { ok: true };
    },
    admin,
  ],
  // Per-shop plan prices. null (or the standard price) goes back to the standard price.
  [
    "PUT",
    "/admin/shops/:id/prices",
    async ({ db, params, body }) => {
      const Price = z.number().int().min(1, "price must be at least ₹1").max(100000).nullable().optional();
      const input = z.object({ monthly: Price, yearly: Price }).parse(body);
      const $set = {};
      const $unset = {};
      for (const id of Object.keys(PLANS)) {
        if (input[id] === undefined) continue;
        if (input[id] === null || input[id] === PLANS[id].amount) $unset[`prices.${id}`] = "";
        else $set[`prices.${id}`] = input[id];
      }
      const shopId = oid(params.id);
      const update = { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
      if (Object.keys(update).length) {
        const { matchedCount } = await db.collection("shops").updateOne({ _id: shopId }, update);
        if (!matchedCount) throw new HttpError(404, "Shop not found.");
      }
      const shop = await db.collection("shops").findOne({ _id: shopId }, { projection: { prices: 1 } });
      if (!shop) throw new HttpError(404, "Shop not found.");
      const plans = plansFor(shop);
      return { monthly: plans.monthly.amount, yearly: plans.yearly.amount };
    },
    admin,
  ],
  [
    "POST",
    "/admin/users/:id/password",
    async ({ db, params, body }) => {
      const { password } = z.object({ password: z.string().min(6, "must be at least 6 characters").max(100) }).parse(body);
      const { matchedCount } = await db.collection("users").updateOne({ _id: oid(params.id) }, { $set: { passwordHash: await hashPassword(password) }, $inc: { sessionVersion: 1 } });
      if (!matchedCount) throw new HttpError(404, "User not found.");
      return { ok: true };
    },
    admin,
  ],
];
