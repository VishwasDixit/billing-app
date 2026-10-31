// Automatic WhatsApp reminders (Settings › Auto WhatsApp): running coupons, new dishes, the owner's
// announcements and "we miss you". Runs every morning with the daily cron and from "Run now".
// Only customers who ticked "Send me offers on WhatsApp" when ordering get them, never after they
// reply STOP, at most one message every GAP_DAYS (an announcement may come sooner), and each
// message once: every send is remembered on the contact by its key.
import { ObjectId } from "mongodb";
import { istDay } from "../shared/hours.js";
import { addDays } from "../shared/loyalty.js";
import { promoSummary } from "../shared/promo.js";
import { visitDays } from "./routes/loyalty.js";
import { appUrl } from "./reminders.js";
import { renderTemplate, sendTemplate, waReady } from "./whatsapp.js";

export const AUTO_DEFAULTS = { on: false, offers: true, dishes: true, dishDay: 5, news: true, miss: true, missDays: 21, missCode: "" };
export const GAP_DAYS = 3;
export const QUIET = { from: 21, to: 10 }; // no messages from 9 pm to 10 am (IST)
const MAX_PER_RUN = 150; // keeps a run inside the function's time limit
const KEEP_SENT = 60; // sends remembered per contact
const ORDER = ["news", "offer", "dishes", "miss"]; // which message wins when several are due

export const autoSettings = (shop) => ({ ...AUTO_DEFAULTS, ...(shop.autoMsg || {}) });
const istHour = (now) => new Date(now.getTime() + 5.5 * 3600e3).getUTCHours();
export const quietNow = (now = new Date()) => istHour(now) >= QUIET.from || istHour(now) < QUIET.to;
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
const dateText = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// The order page, with a code filled in when there is one.
function orderLink(shop, code = "") {
  if (!shop.qrOrdering || !shop.orderToken) return shop.phone ? `call us on ${shop.phone}` : "visit us";
  return `${appUrl()}/order/${shop.orderToken}${code ? `?code=${code}` : ""}`;
}

// Public codes worth reminding about today: active, open to everyone, not used up.
async function liveCodes(db, shop, today) {
  const list = await db
    .collection("promos")
    .find({ shopId: shop._id, active: true, archived: { $ne: true }, source: { $nin: ["dice", "insta"] }, "phones.0": { $exists: false } })
    .toArray();
  return list.filter((p) => (!p.validFrom || p.validFrom <= today) && (!p.validTo || p.validTo >= today) && !(p.maxUses > 0 && p.uses >= p.maxUses));
}

// Everything that could go out for this shop today, before choosing per customer.
async function dueToday(db, shop, s, now, only) {
  const today = istDay(now);
  const cur = shop.currency || "₹";
  const want = (k) => (!only || only === k) && s[k === "offer" ? "offers" : k];
  const due = { news: [], offer: [], dishes: null, miss: null };

  if (want("news")) {
    due.news = await db.collection("announcements").find({ shopId: shop._id, status: "scheduled", sendOn: { $lte: today } }).sort({ sendOn: 1 }).toArray();
  }
  if (want("offer")) {
    const tomorrow = addDays(today, 1);
    for (const p of await liveCodes(db, shop, today)) {
      const stage = p.validTo === tomorrow || p.validTo === today ? "ending" : "start";
      const when = p.validTo === today ? "Ends today." : p.validTo === tomorrow ? "Ends tomorrow." : p.validTo ? `Valid till ${dateText(p.validTo)}.` : "Valid for a limited time.";
      due.offer.push({ promo: p, key: `offer:${p._id}:${stage}`, offer: `use code ${p.code} for ${promoSummary(p, cur)}`, when });
    }
  }
  if (want("dishes") && new Date(today + "T00:00:00Z").getUTCDay() === Number(s.dishDay)) {
    const since = new Date(now.getTime() - 7 * 864e5);
    const fresh = await db.collection("menuItems").find({ shopId: shop._id, createdAt: { $gte: since }, active: { $ne: false }, soldOut: { $ne: true } }).sort({ createdAt: -1 }).limit(20).toArray();
    if (fresh.length) {
      const names = fresh.slice(0, 3).map((m) => m.name);
      const list = names.join(", ") + (fresh.length > 3 ? ` and ${fresh.length - 3} more` : "");
      due.dishes = { key: `dishes:${addDays(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7))}`, list };
    }
  }
  if (want("miss")) {
    const code = s.missCode ? (await liveCodes(db, shop, today)).find((p) => p.code === s.missCode) : null;
    due.miss = { visits: await visitDays(db, shop._id, null), line: code ? `Use code ${code.code} for ${promoSummary(code, cur)} on your next order.` : "Your favourites are waiting for you.", code: code?.code || "" };
  }
  return due;
}

// The one message for this customer today (or null), as { kind, key, params, ref }.
async function pick(db, shop, c, due, today, now) {
  const sentKeys = new Set((c.sent || []).map((x) => x.key));
  const recent = c.lastSentAt && now - new Date(c.lastSentAt) < GAP_DAYS * 864e5;
  const name = firstName(c.name);
  for (const kind of ORDER) {
    if (kind === "news") {
      const a = due.news.find((x) => !sentKeys.has(`news:${x._id}`));
      if (a) return { kind, key: `news:${a._id}`, params: [name, shop.name, a.text, orderLink(shop)], ref: a._id };
    }
    if (recent) continue; // the rest wait for the gap
    if (kind === "offer") {
      for (const o of due.offer.sort((a, b) => (a.key.endsWith("ending") ? -1 : 1) - (b.key.endsWith("ending") ? -1 : 1))) {
        if (sentKeys.has(o.key)) continue;
        if (await db.collection("promoUses").findOne({ promoId: o.promo._id, phone: c.phone }, { projection: { _id: 1 } })) continue;
        return { kind, key: o.key, params: [name, shop.name, o.offer, o.when, orderLink(shop, o.promo.code)] };
      }
    }
    if (kind === "dishes" && due.dishes && !sentKeys.has(due.dishes.key)) {
      return { kind, key: due.dishes.key, params: [name, shop.name, due.dishes.list, orderLink(shop)] };
    }
    if (kind === "miss" && due.miss) {
      const days = [...(due.miss.visits.get(c.phone) || [])].sort();
      const last = [days.at(-1), c.lastOrderAt && istDay(new Date(c.lastOrderAt))].filter(Boolean).sort().at(-1);
      if (last && last <= addDays(today, -Number(due.miss.days || 21)) && !sentKeys.has(`miss:${last}`)) {
        return { kind, key: `miss:${last}`, params: [name, shop.name, due.miss.line, orderLink(shop, due.miss.code)] };
      }
    }
  }
  return null;
}

// Plans (and unless dryRun, sends) today's messages for one shop.
export async function runShop(db, shop, { now = new Date(), dryRun = false, only = null, trigger = "auto", settings = null } = {}) {
  const s = settings || autoSettings(shop);
  const today = istDay(now);
  const due = await dueToday(db, shop, s, now, only);
  if (due.miss) due.miss.days = s.missDays;
  const contacts = await db.collection("waContacts").find({ shopId: shop._id, optIn: true, optOutAt: null }).toArray();
  const plan = [];
  for (const c of contacts) {
    const m = await pick(db, shop, c, due, today, now);
    if (m) plan.push({ c, ...m });
  }
  plan.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const batch = plan.slice(0, MAX_PER_RUN);
  const view = (p) => ({ name: p.c.name || "", phone: p.c.phone, kind: p.kind, text: renderTemplate(p.kind, p.params) });
  if (dryRun) return { dryRun: true, total: plan.length, contacts: contacts.length, list: batch.map(view) };

  const sent = [];
  const failed = [];
  for (let i = 0; i < batch.length; i += 5) {
    await Promise.all(
      batch.slice(i, i + 5).map(async (p) => {
        try {
          await sendTemplate(p.c.phone, p.kind, p.params);
          await db.collection("waContacts").updateOne({ _id: p.c._id }, { $push: { sent: { $each: [{ kind: p.kind, key: p.key, at: now }], $slice: -KEEP_SENT } }, $set: { lastSentAt: now } });
          sent.push(p);
        } catch (err) {
          failed.push({ ...view(p), error: String(err?.message || err).slice(0, 160) });
        }
      })
    );
  }
  // An announcement is done once every customer who can get it has it.
  for (const a of due.news) {
    const got = sent.filter((p) => p.key === `news:${a._id}`).length;
    const left = plan.slice(MAX_PER_RUN).some((p) => p.key === `news:${a._id}`) || failed.some((f) => f.kind === "news");
    await db.collection("announcements").updateOne({ _id: a._id }, { $inc: { sent: got }, $set: { ...(left ? {} : { status: "sent", sentAt: now }), updatedAt: now } });
  }
  const byKind = Object.fromEntries(ORDER.map((k) => [k, sent.filter((p) => p.kind === k).length]));
  const run = { shopId: shop._id, at: now, trigger, sent: sent.length, failed: failed.length, waiting: plan.length - batch.length, byKind, failures: failed.slice(0, 20) };
  await db.collection("marketingRuns").insertOne(run);
  return run;
}

// Every switched-on shop (the daily cron). Quiet hours are skipped.
export async function runMarketing(db, { now = new Date(), trigger = "auto" } = {}) {
  if (quietNow(now)) return { skipped: "quiet hours" };
  const shops = await db.collection("shops").find({ "autoMsg.on": true, blocked: { $exists: false } }, { projection: { logo: 0, qrImage: 0 } }).toArray();
  const out = [];
  for (const shop of shops) {
    if (!waReady(shop)) continue;
    try {
      const r = await runShop(db, shop, { now, trigger });
      out.push({ shop: shop.name, sent: r.sent, failed: r.failed });
    } catch (err) {
      out.push({ shop: shop.name, error: String(err?.message || err).slice(0, 120) });
    }
  }
  return { shops: out };
}

export async function lastRuns(db, shopId, limit = 5) {
  return (await db.collection("marketingRuns").find({ shopId }).sort({ at: -1 }).limit(limit).toArray()).map(({ _id, shopId: _s, ...r }) => r);
}

// A customer's WhatsApp choice, saved when they order (only a tick opts in; a STOP reply opts out).
export async function noteContact(db, shopId, { phone, name, optIn }) {
  const now = new Date();
  const set = { name, lastOrderAt: now, updatedAt: now };
  if (optIn) Object.assign(set, { optIn: true, optInAt: now, optOutAt: null });
  await db.collection("waContacts").updateOne(
    { shopId, phone },
    { $set: set, $setOnInsert: { shopId, phone, createdAt: now, ...(optIn ? {} : { optIn: false, optOutAt: null }) } },
    { upsert: true }
  );
}

export const toId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
