// Plan reminder emails: to shops whose access ends within REMIND_DAYS, and to shops whose
// access has ended. Runs daily (Vercel Cron → /api/cron/reminders) and from the admin page.
// Automatic runs email each shop once per stage per access period; manual runs can repeat,
// but never more than once in MANUAL_COOLDOWN_MS.
import { isAdminEmail } from "./auth.js";
import { subscriptionStatus, plansFor } from "./subscription.js";
import { sendEmail, senderName } from "./otp/mailer.js";

export const REMIND_DAYS = 3;
const MANUAL_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const MAX_PER_RUN = 60; // keeps a run inside the function time limit (Gmail allows ~500/day)

export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return "http://localhost:5173";
}

// Shops that need a reminder now, with the reason ("ending" or "expired").
export async function dueReminders(db, now = new Date()) {
  const [shops, users] = await Promise.all([
    db.collection("shops").find({ blocked: { $exists: false } }, { projection: { logo: 0 } }).toArray(),
    db.collection("users").find({}, { projection: { email: 1, name: 1, shopId: 1 } }).toArray(),
  ]);
  const owners = new Map(users.map((u) => [String(u.shopId), u]));
  const due = [];
  for (const shop of shops) {
    const owner = owners.get(String(shop._id));
    if (!owner || isAdminEmail(owner.email)) continue;
    const status = subscriptionStatus(shop, { now });
    const stage = !status.active ? "expired" : status.daysLeft <= REMIND_DAYS ? "ending" : null;
    if (!stage) continue;
    const key = new Date(status.endsAt).toISOString().slice(0, 10);
    due.push({
      shop,
      owner,
      status,
      stage,
      key,
      sentAuto: shop.reminders?.[stage] === key,
      recentlySent: shop.reminders?.lastAt && now - new Date(shop.reminders.lastAt) < MANUAL_COOLDOWN_MS,
    });
  }
  return due.sort((a, b) => a.status.endsAt - b.status.endsAt);
}

export function reminderEmail({ shop, owner, status, stage }, url = appUrl()) {
  const plans = plansFor(shop);
  const price = `₹${plans.monthly.amount}/month or ₹${plans.yearly.amount}/year`;
  const date = new Date(status.endsAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const days = status.daysLeft;
  const app = senderName();
  const subject =
    stage === "ending"
      ? `${shop.name}: your ${app} access ends ${days <= 1 ? "tomorrow" : `in ${days} days`}`
      : `${shop.name}: your ${app} access has ended`;
  const lines =
    stage === "ending"
      ? [`Your access for ${shop.name} ends on ${date}.`, `Renew now (${price}) to keep billing without a break. Your bills, menu and reports stay safe.`]
      : [`Your access for ${shop.name} ended on ${date}, so new bills can't be saved.`, `Renew (${price}) to start billing again. All your bills, menu and reports are still saved.`];
  const link = `${url}/plans`;
  const text = `Hello ${owner.name},\n\n${lines.join("\n\n")}\n\nRenew here: ${link}\n\nIf you've already paid, you can ignore this email.\n\n— ${app}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2025">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#fff;border-radius:14px;border:1px solid #e3e5e9">
<tr><td style="padding:26px 28px 6px;font-size:19px;font-weight:700">${stage === "ending" ? "Your plan is ending soon" : "Your plan has ended"}</td></tr>
<tr><td style="padding:0 28px;font-size:15px;line-height:1.55">Hello ${esc(owner.name)},<br><br>${lines.map(esc).join("<br><br>")}</td></tr>
<tr><td align="center" style="padding:22px 28px"><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px">Renew now</a></td></tr>
<tr><td style="padding:0 28px 24px;color:#6b7280;font-size:13px">If you've already paid, you can ignore this email.</td></tr>
</table><div style="color:#9aa0a6;font-size:12px;padding-top:14px">${esc(app)}</div></td></tr></table></body></html>`;
  return { subject, text, html };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Sends the reminders. trigger: "auto" (daily) or "manual" (admin button, optionally only some shopIds).
export async function runReminders(db, { trigger = "auto", shopIds = null, now = new Date() } = {}) {
  let due = await dueReminders(db, now);
  if (shopIds) due = due.filter((d) => shopIds.includes(String(d.shop._id)));
  const todo = due.filter((d) => (trigger === "auto" ? !d.sentAuto : !d.recentlySent));
  const batch = todo.slice(0, MAX_PER_RUN);
  const sent = [];
  const failed = [];
  // A few at a time: fast enough, and gentle on Gmail.
  for (let i = 0; i < batch.length; i += 5) {
    await Promise.all(
      batch.slice(i, i + 5).map(async (d) => {
        try {
          await sendEmail({ to: d.owner.email, ...reminderEmail(d), kind: "reminder" });
          await db.collection("shops").updateOne(
            { _id: d.shop._id },
            { $set: { [`reminders.${d.stage}`]: d.key, "reminders.lastAt": now, "reminders.lastStage": d.stage } }
          );
          sent.push({ shop: d.shop.name, email: d.owner.email, stage: d.stage });
        } catch (err) {
          failed.push({ shop: d.shop.name, email: d.owner.email, error: String(err?.message || err).slice(0, 120) });
        }
      })
    );
  }
  const run = { at: now, trigger, sent: sent.length, failed: failed.length, skipped: due.length - batch.length, details: { sent, failed } };
  await db.collection("reminderRuns").insertOne(run);
  return run;
}

export async function lastRuns(db, limit = 5) {
  const runs = await db.collection("reminderRuns").find({}).sort({ at: -1 }).limit(limit).toArray();
  return runs.map(({ _id, ...r }) => r);
}

export const reminderCooldownHours = MANUAL_COOLDOWN_MS / 3600e3;
