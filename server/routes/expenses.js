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

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Expense not found.");
  return new ObjectId(id);
};

export default [
  [
    "GET",
    "/expenses",
    async ({ db, shop, query }) => {
      const filter = { shopId: shop._id };
      if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = ymd.parse(query.from);
        if (query.to) filter.date.$lte = ymd.parse(query.to);
      }
      const list = await db.collection("expenses").find(filter).sort({ date: -1, createdAt: -1 }).limit(5000).toArray();
      return { expenses: list.map(publicExpense), categories: EXPENSE_CATEGORIES };
    },
  ],
  [
    "POST",
    "/expenses",
    async ({ db, shop, body }) => {
      const doc = { ...Expense.parse(body), shopId: shop._id, createdAt: new Date() };
      doc._id = (await db.collection("expenses").insertOne(doc)).insertedId;
      return publicExpense(doc);
    },
  ],
  [
    "PUT",
    "/expenses/:id",
    async ({ db, shop, params, body }) => {
      const updated = await db
        .collection("expenses")
        .findOneAndUpdate({ _id: oid(params.id), shopId: shop._id }, { $set: { ...Expense.parse(body), updatedAt: new Date() } }, { returnDocument: "after" });
      if (!updated) throw new HttpError(404, "Expense not found.");
      return publicExpense(updated);
    },
  ],
  [
    "DELETE",
    "/expenses/:id",
    async ({ db, shop, params }) => {
      const { deletedCount } = await db.collection("expenses").deleteOne({ _id: oid(params.id), shopId: shop._id });
      if (!deletedCount) throw new HttpError(404, "Expense not found.");
      return { ok: true };
    },
  ],
];
