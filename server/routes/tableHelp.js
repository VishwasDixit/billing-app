// Customers ask the restaurant from the table QR page: call a waiter, water, the bill, cutlery, or a
// written question. Staff see them on the Orders screen (with GET /orders) and reply.
import { ObjectId } from "mongodb";
import { z } from "zod";
import { HttpError } from "../http.js";
import { rateLimit, clientIp } from "../limits.js";
import { shopByToken, tableById } from "./orders.js";

export const HELP_KINDS = ["waiter", "water", "bill", "cutlery", "question"];
const DeviceKey = z.string().regex(/^[A-Za-z0-9_-]{16,40}$/, "Please reload the page.");
const MERGE_MS = 2 * 60e3;

// What the customer sees about their own requests.
const forCustomer = ({ _id, kind, text, status, reply, createdAt, repliedAt }) => ({ id: String(_id), kind, text, status, reply: reply || "", createdAt, repliedAt: repliedAt || null });
// What staff see (no device key).
export const forStaff = ({ _id, shopId, deviceKey, ...r }) => ({ ...r, id: String(_id) });

export default [
  [
    "POST",
    "/public/shop/:token/help",
    async ({ db, params, body, req }) => {
      const shop = await shopByToken(db, params.token);
      const input = z
        .object({
          table: z.string().max(20),
          deviceKey: DeviceKey,
          kind: z.enum(HELP_KINDS),
          text: z.string().trim().max(200, "Please keep it under 200 letters.").optional().default(""),
          name: z.string().trim().max(40).optional().default(""),
        })
        .parse(body);
      if (input.kind === "question" && !input.text) throw new HttpError(400, "Please write your question.");
      if (shop.blocked || !shop.qrOrdering) throw new HttpError(403, "Please ask the staff directly.");
      const table = tableById(shop, input.table);
      if (!table) throw new HttpError(400, "This table isn't set up. Please ask the staff.");
      const now = new Date();
      // The same quick ask again soon (an impatient second tap): one request, counted twice.
      if (input.kind !== "question") {
        const again = await db
          .collection("tableHelp")
          .findOneAndUpdate(
            { shopId: shop._id, table: table.id, kind: input.kind, status: "open", createdAt: { $gt: new Date(now - MERGE_MS) } },
            { $inc: { count: 1 }, $set: { updatedAt: now } },
            { returnDocument: "after" }
          );
        if (again) return forCustomer(again);
      }
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `help:ip:${ip}`, 20, "Too many requests from this phone. Please call the staff.");
      await rateLimit(db, `help:table:${shop._id}:${table.id}`, 15, "This table has sent many requests. Please call the staff.");
      const doc = {
        shopId: shop._id, table: table.id, tableName: table.name, kind: input.kind, text: input.text, name: input.name,
        deviceKey: input.deviceKey, status: "open", count: 1, createdAt: now, updatedAt: now,
      };
      doc._id = (await db.collection("tableHelp").insertOne(doc)).insertedId;
      return forCustomer(doc);
    },
    { auth: false },
  ],
  // This phone's own requests (by its random device key), with the staff's replies.
  [
    "GET",
    "/public/shop/:token/help",
    async ({ db, params, query }) => {
      const shop = await shopByToken(db, params.token);
      const deviceKey = DeviceKey.parse(query.d);
      const list = await db.collection("tableHelp").find({ shopId: shop._id, deviceKey }).sort({ createdAt: -1 }).limit(20).toArray();
      return { requests: list.map(forCustomer) };
    },
    { auth: false },
  ],
  // Staff answer, or mark it done.
  [
    "POST",
    "/orders/help/:id",
    async ({ db, shop, params, body, user, staff }) => {
      if (!ObjectId.isValid(params.id)) throw new HttpError(404, "Request not found.");
      const { reply, done } = z.object({ reply: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }).parse(body);
      const now = new Date();
      const by = staff?.name || user.name;
      const $set = { updatedAt: now };
      if (reply) Object.assign($set, { reply, status: "replied", repliedAt: now, repliedBy: by });
      if (done) Object.assign($set, { status: "done", doneAt: now, doneBy: by });
      if (!reply && !done) throw new HttpError(400, "Write a reply or mark it done.");
      const r = await db.collection("tableHelp").findOneAndUpdate({ _id: new ObjectId(params.id), shopId: shop._id }, { $set }, { returnDocument: "after" });
      if (!r) throw new HttpError(404, "Request not found.");
      return forStaff(r);
    },
    { kitchen: true },
  ],
];
