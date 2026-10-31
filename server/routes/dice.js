// Dice game (Settings › Dice game): a QR customer throws two dice once a day; a total of 7 wins a
// code for their mobile only, usable once today. The roll happens here with a secure random
// number, and is saved before it's shown, so reloading or retrying never gives another throw.
import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../http.js";
import { cleanMobile } from "./customers.js";
import { rateLimit, clientIp } from "../limits.js";
import { shopByToken } from "./orders.js";
import { PromoIn } from "./promos.js";
import { istDay } from "../../shared/hours.js";
import { diceRule, isWin } from "../../shared/dice.js";

const face = () => crypto.randomInt(1, 7); // 1–6, each equally likely
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => "DICE" + Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");

const view = (r, phone) => ({ dice: r.dice, win: r.win, code: r.phone === phone ? r.code || "" : "", mine: r.phone === phone });

// The winner's code: only their mobile, once, today.
async function winCode(db, shop, rule, phone, day) {
  for (let i = 0; i < 5; i++) {
    const p = PromoIn.parse({ code: randomCode(), description: "Dice game win", type: "percent", value: rule.percent, maxDiscount: rule.maxDiscount, minOrder: rule.minOrder, validFrom: day, validTo: day, maxUses: 1, onePerPhone: true, phones: [phone] });
    try {
      await db.collection("promos").insertOne({ shopId: shop._id, ...p, source: "dice", uses: 0, discountGiven: 0, createdAt: new Date(), updatedAt: new Date() });
      return p.code;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new HttpError(500, "Couldn't make your code. Please show this screen to the staff.");
}

export default [
  [
    "POST",
    "/public/shop/:token/dice",
    async ({ db, params, body, req }) => {
      const shop = await shopByToken(db, params.token);
      const rule = diceRule(shop);
      if (!rule) throw new HttpError(400, "The dice game isn't on right now.");
      const input = z.object({ phone: z.string().max(20), device: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/) }).parse(body);
      const phone = cleanMobile(input.phone);
      if (!phone) throw new HttpError(400, "Enter your 10-digit mobile number to play.");
      const ip = clientIp(req);
      if (ip) await rateLimit(db, `dice:ip:${ip}`, 30, "Too many tries. Please try again later.");

      const rolls = db.collection("diceRolls");
      const day = istDay();
      const had = await rolls.findOne({ shopId: shop._id, day, $or: [{ phone }, { device: input.device }] });
      if (had) return { already: true, ...view(had, phone) };

      const dice = [face(), face()];
      const doc = { shopId: shop._id, day, phone, device: input.device, dice, win: isWin(dice), code: "", createdAt: new Date() };
      try {
        await rolls.insertOne(doc);
      } catch (err) {
        if (err?.code !== 11000) throw err;
        // Two taps at once: the first throw counts.
        const first = await rolls.findOne({ shopId: shop._id, day, $or: [{ phone }, { device: input.device }] });
        return { already: true, ...view(first, phone) };
      }
      if (doc.win) {
        doc.code = await winCode(db, shop, rule, phone, day);
        await rolls.updateOne({ _id: doc._id }, { $set: { code: doc.code } });
      }
      return { already: false, ...view(doc, phone) };
    },
    { auth: false },
  ],
  // Settings › Dice game: how today went.
  [
    "GET",
    "/dice/today",
    async ({ db, shop }) => {
      const day = istDay();
      const list = await db.collection("diceRolls").find({ shopId: shop._id, day }, { projection: { win: 1, code: 1 } }).toArray();
      const codes = list.filter((r) => r.code).map((r) => r.code);
      const used = codes.length ? await db.collection("promos").countDocuments({ shopId: shop._id, code: { $in: codes }, uses: { $gt: 0 } }) : 0;
      return { rolls: list.length, wins: codes.length, used };
    },
  ],
];
