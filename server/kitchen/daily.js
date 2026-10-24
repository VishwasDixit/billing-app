// The morning kitchen check (daily cron): expiry and running-out alerts for every kitchen,
// and one email to the owner when something needs attention.
import { checkExpiry, checkLowStock, shoppingList } from "./inventory.js";
import { learnKitchen } from "../brain/index.js";
import { billChanges } from "../routes/bills.js";
import { sendEmail, emailOtpReady, senderName } from "../otp/mailer.js";
import { appUrl } from "../reminders.js";

const DAY = 864e5;
const IST = 5.5 * 3600e3;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function dailyKitchenCheck(db, { email = true } = {}) {
  const kitchenIds = await db.collection("ingredients").distinct("shopId", { tracked: true });
  // Yesterday in India: bills edited or deleted go in the same morning email.
  const todayStart = new Date(Math.floor((Date.now() + IST) / DAY) * DAY - IST);
  const yStart = new Date(todayStart.getTime() - DAY);
  const changedIds = await db.collection("billAudit").distinct("shopId", { at: { $gte: yStart, $lt: todayStart } });
  const isKitchen = new Set(kitchenIds.map(String));
  const shopIds = [...new Map([...kitchenIds, ...changedIds].map((id) => [String(id), id])).values()];
  let emailed = 0;
  const canEmail = email && (await emailOtpReady());
  for (const shopId of shopIds) {
    const kitchen = isKitchen.has(String(shopId));
    let brain = null;
    if (kitchen) {
      // Learn first, so today's checks use fresh forecasts and reorder levels.
      brain = await learnKitchen(db, shopId).catch((err) => (console.warn("Kitchen Brain failed:", err?.message || err), null));
      await checkExpiry(db, shopId);
      const ids = (await db.collection("ingredients").find({ shopId, tracked: true }, { projection: { _id: 1 } }).toArray()).map((i) => i._id);
      await checkLowStock(db, shopId, ids);
    }
    if (!canEmail) continue;
    const alerts = kitchen
      ? await db
          .collection("kitchenAlerts")
          .find({ shopId, resolvedAt: null, dismissedAt: { $exists: false }, level: { $in: ["high", "warn"] } })
          .sort({ level: 1 })
          .limit(20)
          .toArray()
      : [];
    const tips = (brain?.insights || []).slice(0, 4);
    const ch = await billChanges(db, shopId, yStart, todayStart);
    const billLines = ch.edited || ch.deleted
      ? [`Yesterday: ${ch.deleted} bill${ch.deleted === 1 ? "" : "s"} deleted (₹${ch.deletedAmount}), ${ch.edited} edited, ${ch.restored} restored.`, ...ch.flags.map((f) => `⚠️ ${f}`)]
      : [];
    if (!alerts.length && !tips.length && !billLines.length) continue;
    const [shop, owner] = await Promise.all([
      db.collection("shops").findOne({ _id: shopId }, { projection: { name: 1, blocked: 1 } }),
      db.collection("users").findOne({ shopId }, { projection: { email: 1, name: 1 } }),
    ]);
    if (!owner || shop?.blocked) continue;
    const list = kitchen ? await shoppingList(db, shopId) : { items: [] };
    const lines = alerts.map((a) => `• ${a.message}`);
    const buy = list.items.slice(0, 15).map((i) => `• ${i.name}: ${i.qty} ${i.unit}`);
    const text = `Good morning ${owner.name},\n\n${billLines.length ? `Bills:\n${billLines.map((l) => `• ${l}`).join("\n")}\n\n` : ""}${lines.length ? `Kitchen alerts for ${shop.name}:\n${lines.join("\n")}\n\n` : ""}${tips.length ? `Kitchen Brain:\n${tips.map((t) => `• ${t.text}`).join("\n")}\n\n` : ""}${buy.length ? `Shopping list:\n${buy.join("\n")}\n\n` : ""}Open: ${appUrl()}/kitchen-manage`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2025"><p>Good morning ${esc(owner.name)},</p>${billLines.length ? `<p><b>Bills</b></p><ul>${billLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}${alerts.length ? `<p><b>Kitchen alerts for ${esc(shop.name)}</b></p><ul>${alerts.map((a) => `<li>${esc(a.message)}</li>`).join("")}</ul>` : ""}${
      tips.length ? `<p><b>🧠 Kitchen Brain</b></p><ul>${tips.map((t) => `<li>${esc(t.text)}</li>`).join("")}</ul>` : ""
    }${buy.length ? `<p><b>Shopping list</b></p><ul>${list.items.slice(0, 15).map((i) => `<li>${esc(i.name)}: ${i.qty} ${esc(i.unit)}</li>`).join("")}</ul>` : ""}<p><a href="${appUrl()}/kitchen-manage" style="color:#0f766e">Open kitchen in ${esc(senderName())}</a></p></div>`;
    try {
      await sendEmail({ to: owner.email, subject: alerts.length ? `${shop.name}: ${alerts.length} kitchen alert${alerts.length === 1 ? "" : "s"} today` : billLines.length ? `${shop.name}: ${ch.deleted} deleted, ${ch.edited} edited bills yesterday` : `${shop.name}: kitchen tips for today`, text, html, kind: "kitchen" });
      emailed++;
    } catch (err) {
      console.warn("Kitchen email failed:", err?.message || err);
    }
  }
  return { kitchens: kitchenIds.length, shops: shopIds.length, emailed };
}
