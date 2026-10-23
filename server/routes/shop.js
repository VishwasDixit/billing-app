import crypto from "node:crypto";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError, respondRaw } from "../http.js";
import { subscriptionStatus } from "../subscription.js";
import { defaultMenu } from "../seed/grillhive-menu.js";
import { defaultImageFor, isDefaultImage } from "../../shared/menuImages.js";
import { isLibraryPhoto, CREDIT_URL } from "./images.js";
import { StockIn, refreshDailyStock, stockDay } from "../stock.js";
import { LANGUAGE_CODES } from "../../shared/messages.js";

const MAX_LOGO = 80 * 1024; // data-URL characters (~60 KB image)
const MAX_QR_IMAGE = 200 * 1024;
const MAX_PHOTO = 50 * 1024; // decoded bytes; the phone resizes photos to ~15–35 KB
export const MAX_PHOTOS_PER_SHOP = 150;
const PHOTO_URL = /^\/api\/menu-images\/[a-f0-9]{24}$/;

export function publicShop(shop, isAdmin = false) {
  const { deviceSeq, ...rest } = shop;
  return { ...rest, id: String(shop._id), _id: undefined, status: subscriptionStatus(shop, { isAdmin }) };
}

const ShopSettings = z
  .object({
    name: z.string().trim().min(1).max(40),
    logo: z
      .string()
      .max(MAX_LOGO, "logo image is too large")
      .refine((s) => s === "" || /^data:image\/(png|jpeg|webp);base64,/.test(s), "logo must be a PNG, JPEG or WebP image"),
    address: z.string().trim().max(160),
    phone: z.string().trim().max(30),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine((g) => g === "" || /^[0-9A-Z]{15}$/.test(g), "GSTIN has 15 letters and numbers, like 09ABCDE1234F1Z5"),
    // Payment QR on bills: off, made from the UPI ID with the bill amount, or an uploaded picture.
    qrMode: z.enum(["off", "upi", "image"]),
    qrOn: z.enum(["all", "credit"]),
    qrImage: z
      .string()
      .max(MAX_QR_IMAGE, "QR picture is too large")
      .refine((s) => s === "" || /^data:image\/(png|jpeg|webp);base64,/.test(s), "QR picture must be a PNG, JPEG or WebP image"),
    footer: z.string().trim().max(80),
    currency: z.string().trim().max(4),
    // Language of udhar reminders / receipts, and the text used when it's "custom".
    reminderLanguage: z.enum(LANGUAGE_CODES),
    reminderTemplate: z.string().trim().max(500),
    // Shop's own UPI ID, shown in udhar reminders so customers can pay directly.
    upiId: z
      .string()
      .trim()
      .max(60)
      .refine((u) => u === "" || /^[\w.\-]{2,}@[\w.\-]{2,}$/.test(u), "enter a UPI ID like name@okbank"),
    gstPercent: z.number().min(0).max(100),
    // Tables for table orders / QR ordering.
    tables: z
      .array(z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/), name: z.string().trim().min(1).max(30) }))
      .max(100)
      .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "table ids must be different"),
    qrOrdering: z.boolean(),
    defaultDiscount: z.object({ type: z.enum(["percent", "flat"]), value: z.number().min(0).max(100000) }),
    printer: z.object({
      paperSize: z.union([z.literal(58), z.literal(80), z.literal(110)]),
      method: z.enum(["bluetooth", "rawbt", "serial", "browser"]),
      charsPerLine: z.number().int().min(16).max(80),
      largeText: z.boolean(),
      slowMode: z.boolean(),
      cut: z.boolean(),
      printLogo: z.boolean(),
    }).partial(),
  })
  .partial();

const Variant = z.object({ label: z.string().trim().max(20), price: z.number().min(0).max(1000000) });
const MenuItem = z.object({
  name: z.string().trim().min(1).max(60),
  category: z.string().trim().max(30).default(""),
  note: z.string().trim().max(160).optional().default(""),
  variants: z.array(Variant).min(1).max(6),
  active: z.boolean().default(true),
  sort: z.number().optional(),
  // Our own pictures (a default illustration or an uploaded photo), or a photo-library link.
  image: z
    .string()
    .max(300)
    .refine((u) => u === "" || isDefaultImage(u) || PHOTO_URL.test(u) || isLibraryPhoto(u), "image must be a menu picture")
    .optional(),
  // Credit for a library photo (author and licence, with a link to its page).
  imageCredit: z
    .object({ author: z.string().trim().max(100), url: z.string().trim().max(300).refine((u) => u === "" || CREDIT_URL.test(u)) })
    .nullable()
    .optional(),
});

// Checks a data URL really is a PNG / JPEG / WebP by its first bytes.
function decodePhoto(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) throw new HttpError(400, "Photo must be a PNG, JPEG or WebP image.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_PHOTO) throw new HttpError(400, "Photo is too large. Please try again (it is resized automatically).");
  const isPng = buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG";
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  if (!(isPng || isJpeg || isWebp)) throw new HttpError(400, "That file isn't a valid image.");
  return { type: isPng ? "image/png" : isJpeg ? "image/jpeg" : "image/webp", data: buf };
}

const photoId = (url) => (PHOTO_URL.test(url || "") ? new ObjectId(url.slice(-24)) : null);

const oid = (id) => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, "Not found.");
  return new ObjectId(id);
};

const publicItem = ({ _id, shopId, ...it }) => ({ ...it, id: String(_id) });

// 1 -> A, 26 -> Z, 27 -> AA
function deviceCode(n) {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export default [
  // The secret part of the table QR links. A new one makes old printed QR codes stop working.
  [
    "POST",
    "/shop/order-token",
    async ({ db, shop, user }) => {
      const token = crypto.randomBytes(16).toString("base64url");
      const updated = await db.collection("shops").findOneAndUpdate({ _id: shop._id }, { $set: { orderToken: token } }, { returnDocument: "after" });
      return publicShop(updated, user.role === "admin");
    },
  ],
  ["GET", "/shop", async ({ db, shop, user }) => publicShop(await db.collection("shops").findOne({ _id: shop._id }), user.role === "admin")],
  [
    "PUT",
    "/shop",
    async ({ db, shop, user, body }) => {
      const input = ShopSettings.parse(body);
      const next = { ...(await db.collection("shops").findOne({ _id: shop._id })), ...input };
      if (next.qrMode === "upi" && !next.upiId) throw new HttpError(400, "Add your shop UPI ID to print a payment QR on bills.");
      if (next.qrMode === "image" && !next.qrImage) throw new HttpError(400, "Upload your QR picture, or choose another QR option.");
      if (input.printer) input.printer = { ...shop.printer, ...input.printer };
      const updated = await db
        .collection("shops")
        .findOneAndUpdate({ _id: shop._id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: "after" });
      return publicShop(updated, user.role === "admin");
    },
  ],

  [
    "GET",
    "/menu",
    async ({ db, shop }) => {
      await refreshDailyStock(db, shop._id);
      return (await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray()).map(publicItem);
    },
    { kitchen: true },
  ],
  // Quick stock change: Sold out switch, quantity left, daily amount.
  [
    "PUT",
    "/menu/:id/stock",
    async ({ db, shop, params, body }) => {
      const s = StockIn.parse(body);
      const $set = { updatedAt: new Date() };
      if (s.soldOut !== undefined) $set.soldOut = s.soldOut;
      if (s.stock !== undefined) {
        $set.stock = s.stock;
        if (s.soldOut === undefined && s.stock !== null) $set.soldOut = s.stock <= 0;
      }
      if (s.dailyStock !== undefined) {
        $set.dailyStock = s.dailyStock;
        if (s.dailyStock !== null) $set.stockDay = stockDay();
      }
      // Back to available with a counted quantity of 0 makes no sense: stop counting.
      if (s.soldOut === false && s.stock === undefined) {
        const cur = await db.collection("menuItems").findOne({ _id: oid(params.id), shopId: shop._id }, { projection: { stock: 1 } });
        if (cur?.stock === 0) $set.stock = null;
      }
      const updated = await db.collection("menuItems").findOneAndUpdate({ _id: oid(params.id), shopId: shop._id }, { $set }, { returnDocument: "after" });
      if (!updated) throw new HttpError(404, "Menu item not found.");
      return publicItem(updated);
    },
    { kitchen: true },
  ],
  [
    "POST",
    "/menu",
    async ({ db, shop, body }) => {
      const item = MenuItem.parse(body);
      if (item.sort === undefined) {
        const last = await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: -1 }).limit(1).next();
        item.sort = (last?.sort ?? -1) + 1;
      }
      if (!item.image) item.image = defaultImageFor(item.name, item.category);
      const doc = { ...item, shopId: shop._id, createdAt: new Date() };
      doc._id = (await db.collection("menuItems").insertOne(doc)).insertedId;
      return publicItem(doc);
    },
  ],
  [
    "PUT",
    "/menu/:id",
    async ({ db, shop, params, body }) => {
      const item = MenuItem.partial().parse(body);
      // A picture that isn't a library photo drops the old photo credit.
      if (item.image !== undefined && !isLibraryPhoto(item.image) && item.imageCredit === undefined) item.imageCredit = null;
      const before = await db
        .collection("menuItems")
        .findOneAndUpdate({ _id: oid(params.id), shopId: shop._id }, { $set: { ...item, updatedAt: new Date() } }, { returnDocument: "before" });
      if (!before) throw new HttpError(404, "Menu item not found.");
      // Swapping an uploaded photo for something else frees its space.
      const old = photoId(before.image);
      if (old && item.image !== undefined && item.image !== before.image) await db.collection("menuImages").deleteOne({ _id: old, shopId: shop._id });
      return publicItem({ ...before, ...item });
    },
  ],
  [
    "DELETE",
    "/menu/:id",
    async ({ db, shop, params }) => {
      const _id = oid(params.id);
      const { deletedCount } = await db.collection("menuItems").deleteOne({ _id, shopId: shop._id });
      if (!deletedCount) throw new HttpError(404, "Menu item not found.");
      await db.collection("menuImages").deleteMany({ shopId: shop._id, itemId: _id });
      return { ok: true };
    },
  ],
  [
    "POST",
    "/menu/reset-default",
    async ({ db, shop }) => {
      await db.collection("menuItems").deleteMany({ shopId: shop._id });
      await db.collection("menuImages").deleteMany({ shopId: shop._id });
      await db.collection("menuItems").insertMany(defaultMenu(shop._id));
      return (await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray()).map(publicItem);
    },
  ],

  // Menu photos (uploaded or taken with the camera), stored in MongoDB.
  [
    "PUT",
    "/menu/:id/image",
    async ({ db, shop, params, body }) => {
      const _id = oid(params.id);
      const item = await db.collection("menuItems").findOne({ _id, shopId: shop._id });
      if (!item) throw new HttpError(404, "Menu item not found.");
      const { type, data } = decodePhoto(z.object({ dataUrl: z.string() }).parse(body).dataUrl);
      // Replacing this item's own photo doesn't count against the limit.
      const replacing = photoId(item.image) ? 1 : 0;
      if ((await db.collection("menuImages").countDocuments({ shopId: shop._id })) - replacing >= MAX_PHOTOS_PER_SHOP) {
        throw new HttpError(400, `Photo limit reached (${MAX_PHOTOS_PER_SHOP}). Remove some photos, or use Find photo (it uses no storage).`);
      }
      const { insertedId } = await db.collection("menuImages").insertOne({ shopId: shop._id, itemId: _id, type, data, createdAt: new Date() });
      const updated = await db
        .collection("menuItems")
        .findOneAndUpdate({ _id }, { $set: { image: `/api/menu-images/${insertedId}`, imageCredit: null, updatedAt: new Date() } }, { returnDocument: "after" });
      const old = photoId(item.image);
      if (old) await db.collection("menuImages").deleteOne({ _id: old, shopId: shop._id });
      return publicItem(updated);
    },
  ],
  [
    "DELETE",
    "/menu/:id/image",
    async ({ db, shop, params }) => {
      const _id = oid(params.id);
      const item = await db.collection("menuItems").findOne({ _id, shopId: shop._id });
      if (!item) throw new HttpError(404, "Menu item not found.");
      const old = photoId(item.image);
      if (old) await db.collection("menuImages").deleteOne({ _id: old, shopId: shop._id });
      const updated = await db
        .collection("menuItems")
        .findOneAndUpdate({ _id }, { $set: { image: defaultImageFor(item.name, item.category), imageCredit: null, updatedAt: new Date() } }, { returnDocument: "after" });
      return publicItem(updated);
    },
  ],
  // Gives every item without a picture its default illustration (menus made before pictures existed).
  [
    "POST",
    "/menu/default-images",
    async ({ db, shop }) => {
      const missing = await db
        .collection("menuItems")
        .find({ shopId: shop._id, $or: [{ image: { $exists: false } }, { image: "" }] })
        .toArray();
      if (missing.length) {
        await db.collection("menuItems").bulkWrite(
          missing.map((m) => ({ updateOne: { filter: { _id: m._id }, update: { $set: { image: defaultImageFor(m.name, m.category) } } } }))
        );
      }
      const menu = await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray();
      return { updated: missing.length, menu: menu.map(publicItem) };
    },
  ],
  // Public so <img> tags can load it; ids are random and a new photo always gets a new id.
  [
    "GET",
    "/menu-images/:id",
    async ({ db, params }) => {
      const img = await db.collection("menuImages").findOne({ _id: oid(params.id) });
      if (!img) throw new HttpError(404, "Picture not found.");
      return respondRaw(200, Buffer.from(img.data.buffer ?? img.data), {
        "Content-Type": img.type,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    },
    { auth: false },
  ],

  // Each phone/computer gets its own bill-number prefix, so offline devices never clash.
  [
    "POST",
    "/devices",
    async ({ db, shop }) => {
      const updated = await db
        .collection("shops")
        .findOneAndUpdate({ _id: shop._id }, { $inc: { deviceSeq: 1 } }, { returnDocument: "after" });
      return { code: deviceCode(updated.deviceSeq) };
    },
    { kitchen: true },
  ],
];
