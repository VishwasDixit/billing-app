import crypto from "node:crypto";
import { HttpError } from "../http.js";
import { runReminders } from "../reminders.js";
import { dailyKitchenCheck } from "../kitchen/daily.js";

// Vercel Cron calls these with "Authorization: Bearer <CRON_SECRET>".
function assertCron(req) {
  const secret = process.env.CRON_SECRET || "";
  const got = Buffer.from(String(req.headers.authorization || ""));
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, "Not allowed.");
}

export default [
  [
    "GET",
    "/cron/reminders",
    async ({ db, req }) => {
      assertCron(req);
      const run = await runReminders(db, { trigger: "auto" });
      const kitchen = await dailyKitchenCheck(db).catch((err) => ({ error: String(err?.message || err) }));
      return { sent: run.sent, failed: run.failed, skipped: run.skipped, kitchen };
    },
    { auth: false },
  ],
];
