// Staff: workers with a 4-digit PIN (for the shared kitchen phone), attendance marked by the
// owner, cash advances, and monthly salary worked out from attendance.
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
  if (user.role === "kitchen") throw new HttpError(403, "Only the owner can do this.");
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
});

const publicStaff = ({ _id, shopId, pinHash, ...s }) => ({ ...s, id: String(_id), hasPin: !!pinHash });

export default [
  [
    "GET",
    "/staff",
    async ({ db, shop, user }) => {
      const list = await db.collection("staff").find({ shopId: shop._id }).sort({ active: -1, name: 1 }).toArray();
      // The kitchen phone only needs names (to pick who is using it).
      if (user.role === "kitchen") return { staff: list.filter((s) => s.active && s.pinHash).map((s) => ({ id: String(s._id), name: s.name, role: s.role })) };
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
      const doc = { ...s, shopId: shop._id, ...(pin && { pinHash: await bcrypt.hash(pin, 8) }), createdAt: new Date() };
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
      const [staff, records, advances, payments] = await Promise.all([
        db.collection("staff").find({ shopId: shop._id }).sort({ active: -1, name: 1 }).toArray(),
        db.collection("attendance").find({ shopId: shop._id, date: { $regex: `^${month}` } }).toArray(),
        db.collection("staffAdvances").find({ shopId: shop._id, date: { $regex: `^${month}` } }).sort({ date: 1 }).toArray(),
        db.collection("salaryPayments").find({ shopId: shop._id, month }).toArray(),
      ]);
      const clean = ({ _id, shopId, ...x }) => ({ ...x, id: String(_id) });
      return {
        month,
        staff: staff.map(publicStaff),
        records: records.map(clean),
        advances: advances.map(clean),
        payments: payments.map(clean),
        salary: Object.fromEntries(
          staff.map((s) => {
            const id = String(s._id);
            return [id, salaryFor(s, month, records.filter((r) => r.staffId === id), advances.filter((a) => a.staffId === id), payments.filter((p) => p.staffId === id))];
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
      await db.collection("salaryPayments").insertOne({ ...p, shopId: shop._id, staffId: params.id, staffName: s.name, createdAt: new Date() });
      if (p.addExpense) {
        await db.collection("expenses").insertOne({
          shopId: shop._id, date: p.date, category: "Salary", amount: p.amount, note: `${s.name} · salary ${p.month}`,
          paymentMode: p.mode === "bank" ? "bank" : p.mode, createdAt: new Date(),
        });
      }
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
      const $set = { ...s, updatedAt: new Date(), ...(pin && { pinHash: await bcrypt.hash(pin, 8) }) };
      const r = await db.collection("staff").findOneAndUpdate({ _id: oid(params.id), shopId: shop._id }, { $set }, { returnDocument: "after" });
      if (!r) throw new HttpError(404, "Worker not found.");
      return publicStaff(r);
    },
  ],
];
