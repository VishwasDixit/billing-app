import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";

export const EXPENSE_CATEGORIES = ["Raw material", "Salary", "Rent", "Gas", "Electricity", "Maintenance", "Other"];

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const Expense = z.object({
  date: ymd,
  category: z.string().trim().min(1).max(30),
  amount: z.number().positive().max(10000000),
  note: z.string().trim().max(120).optional().default(""),
  paymentMode: z.enum(["cash", "upi", "card", "bank"]).default("cash"),
});

const publicExpense = ({ _id, shopId, ...e }) => ({ ...e, id: String(_id) });

// A billing manager writes the day's expenses: recorded under their name, no salaries (private),
// dated within the last week, and they can fix or remove only their own entries for a day.
const M = { manager: true };
const MANAGER_DAYS = 7;
const isManager = (user) => user.role === "manager";
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
function checkManagerExpense(user, e) {
  if (!isManager(user)) return;
  if (e.category === "Salary") throw new HttpError(403, "Only the owner records salaries.");
  const oldest = new Date(Date.now() + 5.5 * 3600e3 - MANAGER_DAYS * 864e5).toISOString().slice(0, 10);
  if (e.date > todayIst() || e.date < oldest) throw new HttpError(400, `Choose a date in the last ${MANAGER_DAYS} days.`);
}
async function ownEntry(db, shop, user, id) {
  const e = await db.collection("expenses").findOne({ _id: oid(id), shopId: shop._id });
  if (!e) throw new HttpError(404, "Expense not found.");
  if (isManager(user) && (e.addedById !== user.staff.id || Date.now() - e.createdAt > 864e5 || e.category === "Salary")) {
    throw new HttpError(403, "Only the owner can change this expense. You can fix your own entries for 24 hours.");
  }
  return e;
}

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Expense not found.");
  return new ObjectId(id);
};

export default [
  [
    "GET",
    "/expenses",
    async ({ db, shop, query, user }) => {
      const filter = { shopId: shop._id, ...(isManager(user) && { category: { $ne: "Salary" } }) };
      if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = ymd.parse(query.from);
        if (query.to) filter.date.$lte = ymd.parse(query.to);
      }
      const list = await db.collection("expenses").find(filter).sort({ date: -1, createdAt: -1 }).limit(5000).toArray();
      return { expenses: list.map(publicExpense), categories: isManager(user) ? EXPENSE_CATEGORIES.filter((c) => c !== "Salary") : EXPENSE_CATEGORIES };
    },
    M,
  ],
  [
    "POST",
    "/expenses",
    async ({ db, shop, body, user }) => {
      const e = Expense.parse(body);
      checkManagerExpense(user, e);
      const doc = { ...e, shopId: shop._id, createdAt: new Date(), addedBy: user.name, ...(user.staff && { addedById: user.staff.id }) };
      doc._id = (await db.collection("expenses").insertOne(doc)).insertedId;
      return publicExpense(doc);
    },
    M,
  ],
  [
    "PUT",
    "/expenses/:id",
    async ({ db, shop, params, body, user }) => {
      const e = Expense.parse(body);
      const before = await ownEntry(db, shop, user, params.id);
      checkManagerExpense(user, e);
      const updated = await db
        .collection("expenses")
        .findOneAndUpdate({ _id: before._id }, { $set: { ...e, updatedAt: new Date(), updatedBy: user.name } }, { returnDocument: "after" });
      return publicExpense(updated);
    },
    M,
  ],
  [
    "DELETE",
    "/expenses/:id",
    async ({ db, shop, params, user }) => {
      const e = await ownEntry(db, shop, user, params.id);
      await db.collection("expenses").deleteOne({ _id: e._id });
      return { ok: true };
    },
    M,
  ],
];
