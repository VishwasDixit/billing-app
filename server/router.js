import { getDb } from "./db.js";
import { HttpError, readBody, send, sendError } from "./http.js";
import { requireUser } from "./auth.js";
import { subscriptionStatus } from "./subscription.js";
import authRoutes from "./routes/auth.js";
import shopRoutes from "./routes/shop.js";
import billRoutes from "./routes/bills.js";
import expenseRoutes from "./routes/expenses.js";
import analyticsRoutes from "./routes/analytics.js";
import payRoutes from "./routes/pay.js";
import adminRoutes from "./routes/admin.js";

// Each route: [method, "/path/:param", handler, { auth = true, admin = false }]
const ROUTES = [
  ...authRoutes,
  ...shopRoutes,
  ...billRoutes,
  ...expenseRoutes,
  ...analyticsRoutes,
  ...payRoutes,
  ...adminRoutes,
].map(([method, path, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp(
    "^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$"
  );
  return { method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin };
});

export async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://local");
    // On Vercel every /api/* request is rewritten to /api?path=...
    const path = "/" + (url.searchParams.get("path") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/^\/+/, "");
    url.searchParams.delete("path");

    let match = null;
    let methodMismatch = false;
    for (const r of ROUTES) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      match = { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? "Method not allowed." : "Not found.");

    const db = await getDb();
    const { raw, json } = await readBody(req);
    const ctx = { req, res, db, params: match.params, query: Object.fromEntries(url.searchParams), body: json, raw };

    if (match.route.auth) {
      ctx.user = await requireUser(req, db);
      if (match.route.admin && ctx.user.role !== "admin") throw new HttpError(403, "Admins only.");
      ctx.shop = await db.collection("shops").findOne({ _id: ctx.user.shopId });
      if (!ctx.shop) throw new HttpError(401, "Shop not found. Please log in again.");
      ctx.status = subscriptionStatus(ctx.shop, { isAdmin: ctx.user.role === "admin" });
    }

    const out = await match.route.handler(ctx);
    if (res.writableEnded) return;
    if (out && out.__response) return send(res, out.status, out.data, out.headers);
    return send(res, 200, out ?? { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
