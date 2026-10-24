// Staff: workers with a 4-digit PIN (for the shared kitchen phone), attendance marked by the
// owner, cash advances, and monthly salary worked out from attendance.
import crypto from "node:crypto";
import { z } from "zod";
import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { HttpError } from "../http.js";
import { staffToken } from "../auth.js";
import { bump, hitsOf } from "../limits.js";
import { STATUS_IDS, salaryFor } from "../../shared/salary.js";

const K = { kitchen: true };
const oid = (id, what = "Worker") => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, `${what} not found.`);
  return new ObjectId(id);
};
const ownerOnly = (user) => {
  if (user.role === "kitchen" || user.role === "manager") throw new HttpError(403, "Only the owner can do this.");
};
const Month = z.string().regex(/^\d{4}-\d{2}$/, "use YYYY-MM");
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional();

const StaffIn = z.object({
  name: z.string().trim().min(1).max(40),
  phone: z.string().trim().max(15).optional().default(""),
  role: z.enum(["cook", "helper", "waiter", "cleaner", "manager", "other"]).default("cook"),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits").optional(),
  wageType: z.enum(["monthly", "daily"]).default("monthly"),
  wage: z.number().min(0).max(1e7).default(0),
  otRate: z.number().min(0).max(1e5).default(0),
  shiftStart: Time,
  shiftEnd: Time,
  joinedAt: Ymd.optional(),
  active: z.boolean().default(true),
  // Signing in on their own phone: kitchen screens only, or billing manager (no money reports).
  access: z.enum(["none", "kitchen", "manager"]).optional(),
});

const Adjustment = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1e7, "enter an amount"), // + bonus, − deduction
  note: z.string().trim().min(2, "write a reason").max(80),
});

// The Salary expense made with a payment (linked since this version; older ones matched by details).
async function paymentExpense(db, shop, p) {
  if (p.expenseId) return db.collection("expenses").findOne({ _id: p.expenseId, shopId: shop._id });
  if (p.addExpense === false) return null;
  return db.collection("expenses").findOne({ shopId: shop._id, category: "Salary", amount: p.amount, date: p.date, note: `${p.staffName} · salary ${p.month}` });
}

export const defaultAccess = (role) => (role === "manager" || role === "waiter" ? "manager" : role === "cook" || role === "helper" ? "kitchen" : "none");
const needsPin = (access, hasPin) => {
  if (access && access !== "none" && !hasPin) throw new HttpError(400, "Give this worker a 4-digit PIN to let them sign in.");
};

// The shop's staff code (typed once on a worker's phone). A new code signs every staff phone out.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
async function setStaffCode(db, shopId, bump) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await db.collection("shops").findOneAndUpdate({ _id: shopId }, { $set: { staffCode: newCode() }, ...(bump && { $inc: { staffCodeVersion: 1 } }) }, { returnDocument: "after" });
      return r.staffCode;
    } catch (err) {
      if (err.code !== 11000) throw err; // taken by another shop: try another
    }
  }
  throw new HttpError(500, "Couldn't make a code. Try again.");
}

const publicStaff = ({ _id, shopId, pinHash, ...s }) => ({ ...s, id: String(_id), hasPin: !!pinHash });

export default [
  [
    "GET",
    "/staff/code",
    async ({ db, shop, user }) => {
      ownerOnly(user);
      return { code: shop.staffCode || (await setStaffCode(db, shop._id, false)) };
    },
  ],
  [
    "POST",
    "/staff/code",
    async ({ db, shop, user }) => {
      ownerOnly(user);
      return { code: await setStaffCode(db, shop._id, true) };
    },
  ],
  [
    "GET",
    "/staff",
    async ({ db, shop, user }) => {
      const list = await db.collection("staff").find({ shopId: shop._id }).sort({ active: -1, name: 1 }).toArray();
      // The kitchen phone only needs names (to pick who is using it).
      if (user.role === "kitchen" || user.role === "manager") return { staff: list.filter((s) => s.active && s.pinHash).map((s) => ({ id: String(s._id), name: s.name, role: s.role })) };
      return { staff: list.map(publicStaff) };
    },
    K,
  ],
  [
    "POST",
    "/staff",
    async ({ db, shop, user, body }) => {
      ownerOnly(user);
      const { pin, ...s } = StaffIn.parse(body);
      s.access = s.access ?? (pin ? defaultAccess(s.role) : "none");
      needsPin(s.access, !!pin);
      const doc = { ...s, shopId: shop._id, ...(pin && { pinHash: await bcrypt.hash(pin, 8) }), pinVersion: 0, createdAt: new Date() };
      doc._id = (await db.collection("staff").insertOne(doc)).insertedId;
      return publicStaff(doc);
    },
  ],
  // "This is me": checks a worker's PIN on the shared phone and returns a token for 12 hours.
  [
    "POST",
    "/staff/verify-pin",
    async ({ db, shop, body }) => {
      const { staffId, pin } = z.object({ staffId: z.string(), pin: z.string().regex(/^\d{4}$/, "enter your 4-digit PIN") }).parse(body);
      const key = `pin:${shop._id}:${staffId}`;
      if ((await hitsOf(db, key)) >= 8) throw new HttpError(429, "Too many wrong PINs. Ask the owner, or try again in an hour.");
      const s = await db.collection("staff").findOne({ _id: oid(staffId), shopId: shop._id, active: true });
      if (!s?.pinHash || !(await bcrypt.compare(pin, s.pinHash))) {
        await bump(db, key);
        throw new HttpError(401, "Wrong PIN.");
      }
      await db.collection("rateLimits").deleteOne({ _id: key });
      return { token: staffToken(s), staff: { id: String(s._id), name: s.name, role: s.role } };
    },
    K,
  ],

  // ---------- Attendance (owner marks) ----------
  [
    "GET",
    "/staff/attendance",
    async ({ db, shop, user, query }) => {
      ownerOnly(user);
      const month = Month.parse(query.month);
      const [staff, records, advances, payments, adjustments] = await Promise.all([
        db.collection("staff").find({ shopId: shop._id }).sort({ active: -1, name: 1 }).toArray(),
        db.collection("attendance").find({ shopId: shop._id, date: { $regex: `^${month}` } }).toArray(),
        db.collection("staffAdvances").find({ shopId: shop._id, date: { $regex: `^${month}` } }).sort({ date: 1 }).toArray(),
        db.collection("salaryPayments").find({ shopId: shop._id, month }).sort({ date: 1 }).toArray(),
        db.collection("salaryAdjustments").find({ shopId: shop._id, month }).sort({ createdAt: 1 }).toArray(),
      ]);
      const clean = ({ _id, shopId, ...x }) => ({ ...x, id: String(_id) });
      return {
        month,
        staff: staff.map(publicStaff),
        records: records.map(clean),
        advances: advances.map(clean),
        payments: payments.map(clean),
        adjustments: adjustments.map(clean),
        salary: Object.fromEntries(
          staff.map((s) => {
            const id = String(s._id);
            const mine = (list) => list.filter((x) => x.staffId === id);
            return [id, salaryFor(s, month, mine(records), mine(advances), mine(payments), mine(adjustments))];
          })
        ),
      };
    },
  ],
  // Mark one day for one worker ("none" clears it). Works offline from the app's queue.
  [
    "PUT",
    "/staff/attendance",
    async ({ db, shop, user, body }) => {
      ownerOnly(user);
      const a = z
        .object({
          staffId: z.string(),
          date: Ymd,
          status: z.enum([...STATUS_IDS, "none"]),
          inTime: Time,
          outTime: Time,
          otHours: z.number().min(0).max(24).optional().default(0),
          note: z.string().trim().max(80).optional().default(""),
        })
        .parse(body);
      if (!(await db.collection("staff").findOne({ _id: oid(a.staffId), shopId: shop._id }))) throw new HttpError(404, "Worker not found.");
      const filter = { shopId: shop._id, staffId: a.staffId, date: a.date };
      if (a.status === "none") {
        await db.collection("attendance").deleteOne(filter);
        return { ok: true };
      }
      const { staffId, date, ...rest } = a;
      await db.collection("attendance").updateOne(filter, { $set: { ...rest, markedBy: user.name, updatedAt: new Date() } }, { upsert: true });
      return { ok: true };
    },
  ],

  // Many days at once: from–to for one or more workers (keeps in/out times already entered).
  [
    "PUT",
    "/staff/attendance/bulk",
    async ({ db, shop, user, body }) => {
      ownerOnly(user);
      const b = z
        .object({
          staffIds: z.array(z.string()).min(1, "choose at least one worker").max(100),
          from: Ymd,
          to: Ymd,
          status: z.enum([...STATUS_IDS, "none"]),
          skipSundays: z.boolean().optional().default(false),
          onlyEmpty: z.boolean().optional().default(false),
        })
        .parse(body);
      if (b.to < b.from) throw new HttpError(400, "The end date is before the start date.");
      const dates = [];
      for (let t = Date.parse(b.from + "T00:00:00Z"); t <= Date.parse(b.to + "T00:00:00Z"); t += 864e5) {
        if (b.skipSundays && new Date(t).getUTCDay() === 0) continue;
        dates.push(new Date(t).toISOString().slice(0, 10));
      }
      if (dates.length > 62) throw new HttpError(400, "Mark up to 62 days at a time.");
      const ids = b.staffIds.filter((id) => ObjectId.isValid(id));
      const workers = await db.collection("staff").find({ shopId: shop._id, _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { _id: 1 } }).toArray();
      if (workers.length !== b.staffIds.length) throw new HttpError(404, "Worker not found.");
      const existing = b.onlyEmpty
        ? new Set((await db.collection("attendance").find({ shopId: shop._id, staffId: { $in: ids }, date: { $in: dates } }, { projection: { staffId: 1, date: 1 } }).toArray()).map((r) => `${r.staffId}|${r.date}`))
        : new Set();
      const ops = [];
      for (const staffId of ids)
        for (const date of dates) {
          if (existing.has(`${staffId}|${date}`)) continue;
          const filter = { shopId: shop._id, staffId, date };
          ops.push(
            b.status === "none"
              ? { deleteOne: { filter } }
              : { updateOne: { filter, update: { $set: { status: b.status, markedBy: user.name, updatedAt: new Date() } }, upsert: true } }
          );
        }
      if (ops.length) await db.collection("attendance").bulkWrite(ops, { ordered: false });
      return { ok: true, marked: ops.length, skipped: ids.length * dates.length - ops.length };
    },
  ],

  // ---------- Advances and salary ----------
  [
    "POST",
    "/staff/:id/advances",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const a = z
        .object({ amount: z.number().positive().max(1e7), date: Ymd, note: z.string().trim().max(80).optional().default(""), mode: z.enum(["cash", "upi", "bank"]).default("cash") })
        .parse(body);
      const s = await db.collection("staff").findOne({ _id: oid(params.id), shopId: shop._id });
      if (!s) throw new HttpError(404, "Worker not found.");
      const doc = { ...a, shopId: shop._id, staffId: params.id, staffName: s.name, createdAt: new Date() };
      doc._id = (await db.collection("staffAdvances").insertOne(doc)).insertedId;
      return { ok: true, id: String(doc._id) };
    },
  ],
  [
    "DELETE",
    "/staff/advances/:id",
    async ({ db, shop, user, params }) => {
      ownerOnly(user);
      const { deletedCount } = await db.collection("staffAdvances").deleteOne({ _id: oid(params.id, "Advance"), shopId: shop._id });
      if (!deletedCount) throw new HttpError(404, "Advance not found.");
      return { ok: true };
    },
  ],
  [
    "PUT",
    "/staff/advances/:id",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const a = z
        .object({ amount: z.number().positive().max(1e7), date: Ymd, note: z.string().trim().max(80).optional().default(""), mode: z.enum(["cash", "upi", "bank"]).default("cash") })
        .parse(body);
      const r = await db.collection("staffAdvances").findOneAndUpdate({ _id: oid(params.id, "Advance"), shopId: shop._id }, { $set: { ...a, updatedAt: new Date() } });
      if (!r) throw new HttpError(404, "Advance not found.");
      return { ok: true };
    },
  ],
  // Bonus (+) or deduction (−) for a month, with a reason.
  [
    "POST",
    "/staff/:id/adjustments",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const a = Adjustment.parse(body);
      const s = await db.collection("staff").findOne({ _id: oid(params.id), shopId: shop._id });
      if (!s) throw new HttpError(404, "Worker not found.");
      const doc = { ...a, shopId: shop._id, staffId: params.id, staffName: s.name, createdAt: new Date() };
      doc._id = (await db.collection("salaryAdjustments").insertOne(doc)).insertedId;
      return { ok: true, id: String(doc._id) };
    },
  ],
  [
    "PUT",
    "/staff/adjustments/:id",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const { month, ...a } = Adjustment.parse(body);
      const r = await db.collection("salaryAdjustments").findOneAndUpdate({ _id: oid(params.id, "Adjustment"), shopId: shop._id }, { $set: { ...a, updatedAt: new Date() } });
      if (!r) throw new HttpError(404, "Adjustment not found.");
      return { ok: true };
    },
  ],
  [
    "DELETE",
    "/staff/adjustments/:id",
    async ({ db, shop, user, params }) => {
      ownerOnly(user);
      const { deletedCount } = await db.collection("salaryAdjustments").deleteOne({ _id: oid(params.id, "Adjustment"), shopId: shop._id });
      if (!deletedCount) throw new HttpError(404, "Adjustment not found.");
      return { ok: true };
    },
  ],
  // Fix or remove a salary payment; its Salary expense follows.
  [
    "PUT",
    "/staff/payments/:id",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const p = z.object({ amount: z.number().positive().max(1e7), date: Ymd, mode: z.enum(["cash", "upi", "bank"]).default("cash") }).parse(body);
      const before = await db.collection("salaryPayments").findOne({ _id: oid(params.id, "Payment"), shopId: shop._id });
      if (!before) throw new HttpError(404, "Payment not found.");
      await db.collection("salaryPayments").updateOne({ _id: before._id }, { $set: { ...p, updatedAt: new Date() } });
      const exp = await paymentExpense(db, shop, before);
      if (exp) await db.collection("expenses").updateOne({ _id: exp._id }, { $set: { amount: p.amount, date: p.date, paymentMode: p.mode, updatedAt: new Date() } });
      return { ok: true, expenseUpdated: !!exp };
    },
  ],
  [
    "DELETE",
    "/staff/payments/:id",
    async ({ db, shop, user, params }) => {
      ownerOnly(user);
      const before = await db.collection("salaryPayments").findOne({ _id: oid(params.id, "Payment"), shopId: shop._id });
      if (!before) throw new HttpError(404, "Payment not found.");
      const exp = await paymentExpense(db, shop, before);
      await db.collection("salaryPayments").deleteOne({ _id: before._id });
      if (exp) await db.collection("expenses").deleteOne({ _id: exp._id });
      return { ok: true, expenseRemoved: !!exp };
    },
  ],
  // Records a salary payment for the month; optionally adds it to Expenses so profit includes it.
  [
    "POST",
    "/staff/:id/salary-paid",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const p = z
        .object({ month: Month, amount: z.number().positive().max(1e7), date: Ymd, mode: z.enum(["cash", "upi", "bank"]).default("cash"), addExpense: z.boolean().default(true) })
        .parse(body);
      const s = await db.collection("staff").findOne({ _id: oid(params.id), shopId: shop._id });
      if (!s) throw new HttpError(404, "Worker not found.");
      let expenseId;
      if (p.addExpense) {
        expenseId = (
          await db.collection("expenses").insertOne({
            shopId: shop._id, date: p.date, category: "Salary", amount: p.amount, note: `${s.name} · salary ${p.month}`,
            paymentMode: p.mode === "bank" ? "bank" : p.mode, createdAt: new Date(), addedBy: user.name,
          })
        ).insertedId;
      }
      await db.collection("salaryPayments").insertOne({ ...p, shopId: shop._id, staffId: params.id, staffName: s.name, createdAt: new Date(), ...(expenseId && { expenseId }) });
      return { ok: true };
    },
  ],
  // Kept last so /staff/attendance and friends match their own routes first.
  [
    "PUT",
    "/staff/:id",
    async ({ db, shop, user, params, body }) => {
      ownerOnly(user);
      const { pin, ...s } = StaffIn.partial().parse(body);
      const before = await db.collection("staff").findOne({ _id: oid(params.id), shopId: shop._id });
      if (!before) throw new HttpError(404, "Worker not found.");
      needsPin(s.access ?? before.access, !!(pin || before.pinHash));
      const $set = { ...s, updatedAt: new Date(), ...(pin && { pinHash: await bcrypt.hash(pin, 8) }) };
      // A new PIN, less access or leaving the job ends that worker's sign-in on their phone.
      const signOut = !!pin || (s.access !== undefined && s.access !== before.access) || s.active === false;
      const r = await db.collection("staff").findOneAndUpdate({ _id: before._id }, { $set, ...(signOut && { $inc: { pinVersion: 1 } }) }, { returnDocument: "after" });
      if (!r) throw new HttpError(404, "Worker not found.");
      return publicStaff(r);
    },
  ],
];
