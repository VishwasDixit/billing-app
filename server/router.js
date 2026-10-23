import { getDb, describeDbError } from "./db.js";
import { razorpayKeyStatus } from "./routes/pay.js";
import { emailOtpEnabled, verifyGmail } from "./otp/mailer.js";
import { googleClientId } from "./google.js";
import { HttpError, readBody, send, sendError } from "./http.js";
import { requireUser, jwtSecretOk, clearCookie } from "./auth.js";
import { subscriptionStatus, blockedMessage, loadPlanSettings } from "./subscription.js";
import authRoutes from "./routes/auth.js";
import shopRoutes from "./routes/shop.js";
import billRoutes from "./routes/bills.js";
import expenseRoutes from "./routes/expenses.js";
import analyticsRoutes from "./routes/analytics.js";
import payRoutes from "./routes/pay.js";
import adminRoutes from "./routes/admin.js";
import customerRoutes from "./routes/customers.js";
import cronRoutes from "./routes/cron.js";
import imageRoutes, { pexelsReady } from "./routes/images.js";
import helpRoutes from "./routes/help.js";

// Each route: [method, "/path/:param", handler, { auth = true, admin = false }]
const ROUTES = [
  ...authRoutes,
  ...shopRoutes,
  ...billRoutes,
  ...expenseRoutes,
  ...analyticsRoutes,
  ...payRoutes,
  ...adminRoutes,
  ...customerRoutes,
  ...cronRoutes,
  ...imageRoutes,
  ...helpRoutes,
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

    if (path === "/health" && req.method === "GET") {
      const h = await health();
      // Details only for the admin, or while setup is broken (so it can be fixed).
      const isAdmin = await requireUser(req, await getDb())
        .then((u) => u.role === "admin")
        .catch(() => false);
      if (url.searchParams.get("check") === "gmail" && !isAdmin) return send(res, 403, { error: "Admins only." });
      if (!isAdmin && h.ok) return send(res, 200, { ok: true, database: h.database });
      if (url.searchParams.get("check") === "gmail") {
        h.gmail = await verifyGmail();
        // Enough to spot a wrong account or a cut-off password, without revealing either.
        const u = process.env.GMAIL_USER || "";
        h.gmailUser = u.replace(/^(.{3}).*(@.*)$/, "$1***$2");
        h.gmailPasswordLength = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, "").length;
      }
      return send(res, 200, h);
    }

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
    await loadPlanSettings(db);
    const { raw, json } = await readBody(req);
    const ctx = { req, res, db, params: match.params, query: Object.fromEntries(url.searchParams), body: json, raw };

    if (match.route.auth) {
      ctx.user = await requireUser(req, db);
      if (match.route.admin && ctx.user.role !== "admin") throw new HttpError(403, "Admins only.");
      // Without the big pictures (logo, QR): most requests don't need them.
      ctx.shop = await db.collection("shops").findOne({ _id: ctx.user.shopId }, { projection: { logo: 0, qrImage: 0 } });
      if (!ctx.shop) throw new HttpError(401, "Shop not found. Please log in again.");
      if (ctx.shop.blocked && ctx.user.role !== "admin") {
        res.setHeader("Set-Cookie", clearCookie());
        throw new HttpError(401, blockedMessage(ctx.shop), { code: "BLOCKED" });
      }
      ctx.status = subscriptionStatus(ctx.shop, { isAdmin: ctx.user.role === "admin" });
    }

    const out = await match.route.handler(ctx);
    if (res.writableEnded) return;
    if (out && out.__response) return send(res, out.status, out.data, out.headers);
    if (out && out.__raw) {
      res.writeHead(out.status, { ...out.headers, "Content-Length": out.body.length });
      return res.end(out.body);
    }
    return send(res, 200, out ?? { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}

// Setup check for the deployed app: says which settings exist, never their values.
async function health() {
  const out = {
    database: "not checked",
    MONGODB_URI: !!process.env.MONGODB_URI,
    JWT_SECRET: jwtSecretOk(),
    ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
    UPI_ID: !!process.env.UPI_ID,
    RAZORPAY_KEYS: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    razorpay: await razorpayKeyStatus(),
    EMAIL_OTP: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) || emailOtpEnabled(),
    RAZORPAY_WEBHOOK_SECRET: !!process.env.RAZORPAY_WEBHOOK_SECRET,
    GOOGLE_CLIENT_ID: !!googleClientId(),
    CRON_SECRET: !!process.env.CRON_SECRET,
    PEXELS_API_KEY: pexelsReady(),
    SUPPORT_WHATSAPP: !!process.env.SUPPORT_WHATSAPP,
  };
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    out.database = "connected";
  } catch (err) {
    out.database = "error: " + (err.extra?.detail || describeDbError(err));
  }
  out.ok = out.database === "connected" && out.JWT_SECRET && out.ADMIN_EMAIL;
  return out;
}
