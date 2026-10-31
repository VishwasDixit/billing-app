// Link previews: WhatsApp and other apps read a shared order link without running the app, so
// vercel.json sends their bots here for a tiny page with the shop's name and logo in its og tags.
// Customers who open the link get the normal app.
import crypto from "node:crypto";
import { respondRaw, HttpError } from "../http.js";
import { appOrigin } from "./orders.js";

const TOKEN = /^[A-Za-z0-9_-]{16,40}$/;
const LOGO = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const findShop = (db, token) => (TOKEN.test(token || "") ? db.collection("shops").findOne({ orderToken: token }, { projection: { name: 1, address: 1, logo: 1 } }) : null);

export function sharePage({ origin, url, shop, token, code }) {
  const title = shop ? shop.name : "Order online";
  const description = !shop
    ? "Order from your table."
    : code
      ? `🎁 Your code ${code} is ready. Tap to order.`
      : `Order online from ${shop.name}${shop.address ? ` · ${shop.address}` : ""}`.replace(/\s+/g, " ");
  const image = shop?.logo
    ? `${origin}/api/public/shop/${token}/logo?v=${crypto.createHash("sha1").update(shop.logo).digest("hex").slice(0, 10)}`
    : `${origin}/apple-touch-icon.png`;
  const meta = [
    ["og:type", "website"],
    ["og:site_name", title],
    ["og:title", title],
    ["og:description", description],
    ["og:image", image],
    ["og:url", url],
    ["twitter:card", "summary"],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${meta.map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join("\n")}
</head>
<body><a href="${esc(url)}">${esc(title)}</a></body>
</html>`;
}

export default [
  [
    "GET",
    "/share/order/:token",
    async ({ db, params, query, req }) => {
      const shop = await findShop(db, params.token);
      const origin = appOrigin(req).replace(/\/$/, "");
      const code = /^[A-Za-z0-9_-]{2,30}$/.test(query.code || "") ? query.code.toUpperCase() : "";
      const qs = new URLSearchParams(Object.entries(query).filter(([k]) => k !== "path" && k !== "token")).toString();
      const url = `${origin}/order/${encodeURIComponent(params.token)}${qs ? `?${qs}` : ""}`;
      const html = sharePage({ origin, url, shop, token: params.token, code });
      return respondRaw(200, Buffer.from(html), { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=600" });
    },
    { auth: false },
  ],
  // The shop's logo as a picture file (it's stored as a data URL), for the preview card.
  [
    "GET",
    "/public/shop/:token/logo",
    async ({ db, params }) => {
      const m = LOGO.exec((await findShop(db, params.token))?.logo || "");
      if (!m) throw new HttpError(404, "No logo.");
      return respondRaw(200, Buffer.from(m[2], "base64"), { "Content-Type": m[1], "Cache-Control": "public, max-age=86400" });
    },
    { auth: false },
  ],
];
