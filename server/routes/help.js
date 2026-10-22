// Help messages between shop owners and the admin. Each conversation is a thread;
// new messages email the other side (admin: ADMIN_EMAIL, shop: the owner's email).
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { rateLimit } from "../limits.js";
import { sendEmail, emailOtpReady, senderName } from "../otp/mailer.js";
import { appUrl } from "../reminders.js";

const MAX_IMAGE = 110 * 1024; // data-URL characters (~80 KB screenshot)
const Text = z.string().trim().min(2, "please write a little more").max(2000);
const Image = z
  .string()
  .max(MAX_IMAGE, "screenshot is too large")
  .refine((s) => /^data:image\/(jpeg|webp|png);base64,/.test(s), "screenshot must be a photo")
  .optional();

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Not found.");
  return new ObjectId(id);
};

export function publicThread({ _id, shopId, ...t }, { withMessages = true } = {}) {
  return {
    ...t,
    id: String(_id),
    shopId: String(shopId),
    messages: withMessages ? t.messages : undefined,
    last: t.messages.at(-1)?.text.slice(0, 120) || "",
    count: t.messages.length,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Best effort: a failed email never loses the message.
async function notify(to, subject, text, link) {
  if (!to) return;
  try {
    if (!(await emailOtpReady())) return;
    await sendEmail({
      to,
      subject,
      text: `${text}\n\nOpen: ${link}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2025"><p style="white-space:pre-wrap">${esc(text)}</p><p><a href="${link}" style="color:#0f766e">Open in ${esc(senderName())}</a></p></div>`,
      kind: "help",
    });
  } catch (err) {
    console.warn("Help email failed:", err?.message || err);
  }
}

const adminEmail = () => (process.env.ADMIN_EMAIL || "").split(",")[0].trim();

export default [
  // Shop side
  ["GET", "/help/config", async () => ({ whatsapp: (process.env.SUPPORT_WHATSAPP || "").replace(/\D/g, "") || null })],
  [
    "GET",
    "/help/threads",
    async ({ db, shop }) => {
      const list = await db.collection("helpThreads").find({ shopId: shop._id }).sort({ updatedAt: -1 }).limit(50).toArray();
      return { threads: list.map((t) => publicThread(t)) };
    },
  ],
  [
    "POST",
    "/help/threads",
    async ({ db, shop, user, body }) => {
      const input = z.object({ subject: z.string().trim().min(3, "add a short subject").max(100), text: Text, image: Image }).parse(body);
      await rateLimit(db, `help:shop:${shop._id}`, 10, "You've sent a lot of new messages. Please reply in an existing one, or try again later.");
      const now = new Date();
      const doc = {
        shopId: shop._id,
        shopName: shop.name,
        ownerName: user.name,
        ownerEmail: user.email,
        ownerPhone: user.phone,
        subject: input.subject,
        status: "open",
        messages: [{ from: "shop", text: input.text, ...(input.image && { image: input.image }), at: now }],
        unreadByAdmin: true,
        unreadByShop: false,
        createdAt: now,
        updatedAt: now,
      };
      doc._id = (await db.collection("helpThreads").insertOne(doc)).insertedId;
      await notify(adminEmail(), `Help request: ${shop.name} – ${input.subject}`, `${user.name} (${shop.name}, ${user.phone}) wrote:\n\n${input.text}`, `${appUrl()}/admin`);
      return publicThread(doc);
    },
  ],
  [
    "POST",
    "/help/threads/:id/messages",
    async ({ db, shop, user, params, body }) => {
      const input = z.object({ text: Text, image: Image }).parse(body);
      await rateLimit(db, `help-msg:shop:${shop._id}`, 60, "Too many messages. Please try again later.");
      const t = await db.collection("helpThreads").findOneAndUpdate(
        { _id: oid(params.id), shopId: shop._id },
        {
          $push: { messages: { from: "shop", text: input.text, ...(input.image && { image: input.image }), at: new Date() } },
          $set: { status: "open", unreadByAdmin: true, updatedAt: new Date() },
        },
        { returnDocument: "after" }
      );
      if (!t) throw new HttpError(404, "Message not found.");
      await notify(adminEmail(), `Help reply: ${shop.name} – ${t.subject}`, `${user.name} (${shop.name}) wrote:\n\n${input.text}`, `${appUrl()}/admin`);
      return publicThread(t);
    },
  ],
  [
    "POST",
    "/help/threads/:id/read",
    async ({ db, shop, params }) => {
      await db.collection("helpThreads").updateOne({ _id: oid(params.id), shopId: shop._id }, { $set: { unreadByShop: false } });
      return { ok: true };
    },
  ],

  // Admin side
  [
    "GET",
    "/admin/help",
    async ({ db, query }) => {
      const filter = query.status && query.status !== "all" ? { status: query.status } : {};
      const list = await db.collection("helpThreads").find(filter).sort({ unreadByAdmin: -1, updatedAt: -1 }).limit(200).toArray();
      const unread = await db.collection("helpThreads").countDocuments({ unreadByAdmin: true });
      return { threads: list.map((t) => publicThread(t, { withMessages: false })), unread };
    },
    { admin: true },
  ],
  [
    "GET",
    "/admin/help/:id",
    async ({ db, params }) => {
      const t = await db.collection("helpThreads").findOneAndUpdate({ _id: oid(params.id) }, { $set: { unreadByAdmin: false } }, { returnDocument: "after" });
      if (!t) throw new HttpError(404, "Message not found.");
      return publicThread(t);
    },
    { admin: true },
  ],
  [
    "POST",
    "/admin/help/:id/reply",
    async ({ db, params, body }) => {
      const { text, close } = z.object({ text: Text, close: z.boolean().optional() }).parse(body);
      const t = await db.collection("helpThreads").findOneAndUpdate(
        { _id: oid(params.id) },
        {
          $push: { messages: { from: "admin", text, at: new Date() } },
          $set: { status: close ? "closed" : "answered", unreadByShop: true, unreadByAdmin: false, updatedAt: new Date() },
        },
        { returnDocument: "after" }
      );
      if (!t) throw new HttpError(404, "Message not found.");
      await notify(t.ownerEmail, `Reply from support: ${t.subject}`, `Hello ${t.ownerName},\n\n${text}`, `${appUrl()}/help`);
      return publicThread(t);
    },
    { admin: true },
  ],
  [
    "POST",
    "/admin/help/:id/status",
    async ({ db, params, body }) => {
      const { status } = z.object({ status: z.enum(["open", "answered", "closed"]) }).parse(body);
      const t = await db.collection("helpThreads").findOneAndUpdate({ _id: oid(params.id) }, { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" });
      if (!t) throw new HttpError(404, "Message not found.");
      return publicThread(t);
    },
    { admin: true },
  ],
];
