import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { hashPassword, isAdminEmail } from "../auth.js";
import { grantPlan, subscriptionStatus, PLANS } from "../subscription.js";

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Not found.");
  return new ObjectId(id);
};

const admin = { admin: true };

export default [
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
  [
    "POST",
    "/admin/users/:id/password",
    async ({ db, params, body }) => {
      const { password } = z.object({ password: z.string().min(6, "must be at least 6 characters").max(100) }).parse(body);
      const { matchedCount } = await db.collection("users").updateOne({ _id: oid(params.id) }, { $set: { passwordHash: await hashPassword(password) } });
      if (!matchedCount) throw new HttpError(404, "User not found.");
      return { ok: true };
    },
    admin,
  ],
];
