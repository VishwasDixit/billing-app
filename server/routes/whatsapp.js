// Auto WhatsApp: Meta's webhook (STOP / START replies, failed deliveries), the owner's settings,
// announcements, "Preview" and "Run now", and a customer's WhatsApp choice on Customers.
import { z } from "zod";
import { HttpError, respondRaw } from "../http.js";
import { cleanMobile } from "./customers.js";
import { rateLimit } from "../limits.js";
import { istDay } from "../../shared/hours.js";
import { signatureOk, verifyTokenOk, sendText, waStatus, waReady, TEMPLATES, FOOTER } from "../whatsapp.js";
import { AUTO_DEFAULTS, autoSettings, runShop, lastRuns, quietNow, toId, QUIET, GAP_DAYS } from "../marketing.js";

const STOP_RE = /^\s*(stop|unsubscribe|band karo|band|no more|stop all)\s*[.!]*\s*$/i;
const START_RE = /^\s*(start|subscribe|resume)\s*[.!]*\s*$/i;

const AutoIn = z.object({
  on: z.boolean(),
  offers: z.boolean(),
  dishes: z.boolean(),
  dishDay: z.number().int().min(0).max(6),
  news: z.boolean(),
  miss: z.boolean(),
  missDays: z.number().int().min(7).max(90),
  missCode: z.string().trim().toUpperCase().max(20).default(""),
});
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use a date like 2026-12-31");

const publicAnnouncement = ({ _id, shopId, ...a }) => ({ ...a, id: String(_id) });

async function settingsView(db, shop) {
  const [optedIn, announcements, runs] = await Promise.all([
    db.collection("waContacts").countDocuments({ shopId: shop._id, optIn: true, optOutAt: null }),
    db.collection("announcements").find({ shopId: shop._id }).sort({ createdAt: -1 }).limit(20).toArray(),
    lastRuns(db, shop._id),
  ]);
  return {
    status: waStatus(shop),
    settings: autoSettings(shop),
    optedIn,
    announcements: announcements.map(publicAnnouncement),
    runs,
    rules: { quietFrom: QUIET.from, quietTo: QUIET.to, gapDays: GAP_DAYS },
    templates: Object.values(TEMPLATES).map((t) => ({ name: t.name, body: t.body, footer: FOOTER })),
  };
}

function assertCanSend(shop, now) {
  const st = waStatus(shop);
  if (st === "env") throw new HttpError(400, "WhatsApp isn't connected yet. Add the WhatsApp keys in Vercel (see the set-up steps).");
  if (st === "shop") throw new HttpError(400, "WhatsApp sending isn't switched on for this shop yet. Add this shop's id to WHATSAPP_SHOPS in Vercel.");
  if (quietNow(now)) throw new HttpError(400, `Messages go out between ${QUIET.to} am and ${QUIET.from - 12} pm, so customers aren't disturbed. Try again then.`);
}

export default [
  // Meta's set-up check: echo the challenge when the verify token matches.
  [
    "GET",
    "/whatsapp/webhook",
    async ({ query }) => {
      if (query["hub.mode"] !== "subscribe" || !verifyTokenOk(query["hub.verify_token"])) throw new HttpError(403, "Not allowed.");
      return respondRaw(200, Buffer.from(String(query["hub.challenge"] || "")), { "Content-Type": "text/plain" });
    },
    { auth: false },
  ],
  [
    "POST",
    "/whatsapp/webhook",
    async ({ db, req, raw, body }) => {
      if (!signatureOk(raw, req.headers["x-hub-signature-256"])) throw new HttpError(401, "Bad signature.");
      const now = new Date();
      for (const entry of body.entry || []) {
        for (const ch of entry.changes || []) {
          const v = ch.value || {};
          for (const m of v.messages || []) {
            const phone = cleanMobile(m.from);
            const text = m.type === "text" ? m.text?.body || "" : m.type === "button" ? m.button?.text || "" : "";
            if (!phone || !text) continue;
            if (STOP_RE.test(text)) {
              await db.collection("waContacts").updateMany({ phone }, { $set: { optIn: false, optOutAt: now, updatedAt: now } });
              await sendText(phone, "Done ✅ You won't get offers from us on WhatsApp any more. Reply START if you change your mind.").catch(() => {});
            } else if (START_RE.test(text)) {
              const r = await db.collection("waContacts").updateMany({ phone }, { $set: { optIn: true, optInAt: now, optOutAt: null, updatedAt: now } });
              if (r.matchedCount) await sendText(phone, "Welcome back 🎉 You'll get our offers and new dishes again. Reply STOP any time.").catch(() => {});
            }
          }
          for (const st of v.statuses || []) {
            if (st.status !== "failed") continue;
            const phone = cleanMobile(st.recipient_id);
            const e = st.errors?.[0] || {};
            if (phone) await db.collection("waContacts").updateMany({ phone }, { $set: { lastError: { code: e.code || 0, title: String(e.title || e.message || "failed").slice(0, 120), at: now } } });
          }
        }
      }
      return { ok: true };
    },
    { auth: false },
  ],

  ["GET", "/auto-msg", async ({ db, shop }) => settingsView(db, shop)],
  [
    "PUT",
    "/auto-msg",
    async ({ db, shop, body }) => {
      const s = AutoIn.parse(body);
      await db.collection("shops").updateOne({ _id: shop._id }, { $set: { autoMsg: s, updatedAt: new Date() } });
      return settingsView(db, { ...shop, autoMsg: s });
    },
  ],
  // Who would get what today (sends nothing; works before WhatsApp is connected).
  [
    "POST",
    "/auto-msg/preview",
    async ({ db, shop, body }) => {
      const s = body && Object.keys(body).length ? { ...AUTO_DEFAULTS, ...AutoIn.parse(body) } : autoSettings(shop);
      return runShop(db, shop, { dryRun: true, settings: s });
    },
  ],
  [
    "POST",
    "/auto-msg/run",
    async ({ db, shop }) => {
      const now = new Date();
      assertCanSend(shop, now);
      if (!autoSettings(shop).on) throw new HttpError(400, "Turn on Auto WhatsApp and save first.");
      await rateLimit(db, `auto-msg:run:${shop._id}`, 6, "That's a lot of runs this hour. Please wait a bit.");
      return { run: await runShop(db, shop, { now, trigger: "manual" }), ...(await settingsView(db, shop)) };
    },
  ],

  [
    "POST",
    "/announcements",
    async ({ db, shop, body }) => {
      const a = z.object({ text: z.string().trim().min(5, "Write the announcement (at least a few words).").max(300, "Keep it under 300 letters."), sendOn: Day }).parse(body);
      if (a.sendOn < istDay()) throw new HttpError(400, "Choose today or a later date.");
      if ((await db.collection("announcements").countDocuments({ shopId: shop._id, status: "scheduled" })) >= 10) throw new HttpError(400, "You can have up to 10 announcements waiting.");
      const now = new Date();
      const doc = { shopId: shop._id, text: a.text, sendOn: a.sendOn, status: "scheduled", sent: 0, createdAt: now, updatedAt: now };
      doc._id = (await db.collection("announcements").insertOne(doc)).insertedId;
      return { announcement: publicAnnouncement(doc) };
    },
  ],
  [
    "DELETE",
    "/announcements/:id",
    async ({ db, shop, params }) => {
      const r = await db.collection("announcements").deleteOne({ _id: toId(params.id), shopId: shop._id, status: "scheduled", sent: 0 });
      if (!r.deletedCount) throw new HttpError(400, "This announcement has already started going out.");
      return { ok: true };
    },
  ],
  // "Send now": today's date, and only announcements go out in this run.
  [
    "POST",
    "/announcements/:id/send",
    async ({ db, shop, params }) => {
      const now = new Date();
      assertCanSend(shop, now);
      const r = await db.collection("announcements").updateOne({ _id: toId(params.id), shopId: shop._id, status: "scheduled" }, { $set: { sendOn: istDay(now), updatedAt: now } });
      if (!r.matchedCount) throw new HttpError(404, "Announcement not found, or it has already gone out.");
      await rateLimit(db, `auto-msg:run:${shop._id}`, 6, "That's a lot of runs this hour. Please wait a bit.");
      const settings = { ...autoSettings(shop), news: true };
      return { run: await runShop(db, shop, { now, trigger: "manual", only: "news", settings }), ...(await settingsView(db, shop)) };
    },
  ],

  // A customer's WhatsApp offers choice (Customers › customer).
  [
    "GET",
    "/wa-contacts/:phone",
    async ({ db, shop, params }) => {
      const phone = cleanMobile(params.phone);
      const c = phone ? await db.collection("waContacts").findOne({ shopId: shop._id, phone }) : null;
      return { ready: waReady(shop), optIn: !!(c?.optIn && !c.optOutAt), optedOut: !!c?.optOutAt, lastSentAt: c?.lastSentAt || null, lastError: c?.lastError || null };
    },
    { manager: true },
  ],
  [
    "PUT",
    "/wa-contacts/:phone",
    async ({ db, shop, params, body }) => {
      const phone = cleanMobile(params.phone);
      if (!phone) throw new HttpError(400, "This customer has no valid mobile number.");
      const { optIn } = z.object({ optIn: z.literal(false) }).parse(body); // staff can only turn it off; turning on is the customer's choice
      const now = new Date();
      await db.collection("waContacts").updateOne({ shopId: shop._id, phone }, { $set: { optIn, optOutAt: now, updatedAt: now }, $setOnInsert: { shopId: shop._id, phone, createdAt: now } }, { upsert: true });
      return { optIn: false, optedOut: true };
    },
    { manager: true },
  ],
];
