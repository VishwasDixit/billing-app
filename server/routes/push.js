// Staff devices turn on lock-screen alerts (Web Push) from the Alerts panel.
import { z } from "zod";
import { HttpError } from "../http.js";
import { pushPublicKey, saveSubscription, removeSubscription, pushToEndpoint } from "../push.js";
import { rateLimit } from "../limits.js";

// Only the browsers' real push services: the server posts to this address, so anything else
// (an internal address, someone's own server) is refused.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export const isPushEndpoint = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
};
const Endpoint = z.string().trim().max(1000).refine(isPushEndpoint, "Bad push address.");
const SubIn = z.object({
  endpoint: Endpoint,
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

export default [
  // The server's public key (empty when push isn't set up on this server).
  ["GET", "/push/key", async () => ({ publicKey: pushPublicKey() }), { kitchen: true }],
  [
    "POST",
    "/push/subscribe",
    async (ctx) => {
      if (!pushPublicKey()) throw new HttpError(503, "Lock-screen alerts aren't set up on this server yet.");
      const sub = SubIn.parse(ctx.body);
      await saveSubscription(ctx.db, ctx, sub);
      return { ok: true };
    },
    { kitchen: true },
  ],
  [
    "POST",
    "/push/unsubscribe",
    async ({ db, shop, body }) => {
      const { endpoint } = z.object({ endpoint: Endpoint }).parse(body);
      await removeSubscription(db, shop._id, endpoint);
      return { ok: true };
    },
    { kitchen: true },
  ],
  // "Send a test alert": only to this device, and only if it's saved for this shop.
  [
    "POST",
    "/push/test",
    async ({ db, shop, body }) => {
      const { endpoint } = z.object({ endpoint: Endpoint }).parse(body);
      const sub = await db.collection("pushSubs").findOne({ shopId: shop._id, endpoint });
      if (!sub) throw new HttpError(404, "This device isn't set up for lock-screen alerts. Turn them on first.");
      await rateLimit(db, `pushtest:${sub._id}`, 10, "Too many test alerts. Try again in a while.");
      try {
        await pushToEndpoint(sub, { title: "🔔 Test alert", body: `${shop.name}: alerts are working on this device.` });
      } catch (err) {
        if ([404, 410].includes(err.statusCode)) await db.collection("pushSubs").deleteOne({ _id: sub._id });
        throw new HttpError(502, "The browser's push service didn't take the alert. Turn lock-screen alerts off and on again.");
      }
      return { ok: true };
    },
    { kitchen: true },
  ],
];
