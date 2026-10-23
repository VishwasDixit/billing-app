// The morning kitchen check (daily cron): expiry and running-out alerts for every kitchen,
// and one email to the owner when something needs attention.
import { checkExpiry, checkLowStock, shoppingList } from "./inventory.js";
import { sendEmail, emailOtpReady, senderName } from "../otp/mailer.js";
import { appUrl } from "../reminders.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function dailyKitchenCheck(db, { email = true } = {}) {
  const shopIds = await db.collection("ingredients").distinct("shopId", { tracked: true });
  let emailed = 0;
  const canEmail = email && (await emailOtpReady());
  for (const shopId of shopIds) {
    await checkExpiry(db, shopId);
    const ids = (await db.collection("ingredients").find({ shopId, tracked: true }, { projection: { _id: 1 } }).toArray()).map((i) => i._id);
    await checkLowStock(db, shopId, ids);
    if (!canEmail) continue;
    const alerts = await db
      .collection("kitchenAlerts")
      .find({ shopId, resolvedAt: null, dismissedAt: { $exists: false }, level: { $in: ["high", "warn"] } })
      .sort({ level: 1 })
      .limit(20)
      .toArray();
    if (!alerts.length) continue;
    const [shop, owner] = await Promise.all([
      db.collection("shops").findOne({ _id: shopId }, { projection: { name: 1, blocked: 1 } }),
      db.collection("users").findOne({ shopId }, { projection: { email: 1, name: 1 } }),
    ]);
    if (!owner || shop?.blocked) continue;
    const list = await shoppingList(db, shopId);
    const lines = alerts.map((a) => `• ${a.message}`);
    const buy = list.items.slice(0, 15).map((i) => `• ${i.name}: ${i.qty} ${i.unit}`);
    const text = `Good morning ${owner.name},\n\nKitchen alerts for ${shop.name}:\n${lines.join("\n")}\n\n${buy.length ? `Shopping list:\n${buy.join("\n")}\n\n` : ""}Open: ${appUrl()}/kitchen-manage`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2025"><p>Good morning ${esc(owner.name)},</p><p><b>Kitchen alerts for ${esc(shop.name)}</b></p><ul>${alerts
      .map((a) => `<li>${esc(a.message)}</li>`)
      .join("")}</ul>${buy.length ? `<p><b>Shopping list</b></p><ul>${list.items.slice(0, 15).map((i) => `<li>${esc(i.name)}: ${i.qty} ${esc(i.unit)}</li>`).join("")}</ul>` : ""}<p><a href="${appUrl()}/kitchen-manage" style="color:#0f766e">Open kitchen in ${esc(senderName())}</a></p></div>`;
    try {
      await sendEmail({ to: owner.email, subject: `${shop.name}: ${alerts.length} kitchen alert${alerts.length === 1 ? "" : "s"} today`, text, html, kind: "kitchen" });
      emailed++;
    } catch (err) {
      console.warn("Kitchen email failed:", err?.message || err);
    }
  }
  return { kitchens: shopIds.length, emailed };
}
