import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { subscriptionStatus } from "../subscription.js";
import { defaultMenu } from "../seed/grillhive-menu.js";

const MAX_LOGO = 80 * 1024; // data-URL characters (~60 KB image)

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
    gstin: z.string().trim().max(20),
    footer: z.string().trim().max(80),
    currency: z.string().trim().max(4),
    gstPercent: z.number().min(0).max(100),
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
});

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
  ["GET", "/shop", async ({ shop, user }) => publicShop(shop, user.role === "admin")],
  [
    "PUT",
    "/shop",
    async ({ db, shop, user, body }) => {
      const input = ShopSettings.parse(body);
      if (input.printer) input.printer = { ...shop.printer, ...input.printer };
      const updated = await db
        .collection("shops")
        .findOneAndUpdate({ _id: shop._id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: "after" });
      return publicShop(updated, user.role === "admin");
    },
  ],

  ["GET", "/menu", async ({ db, shop }) => (await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray()).map(publicItem)],
  [
    "POST",
    "/menu",
    async ({ db, shop, body }) => {
      const item = MenuItem.parse(body);
      if (item.sort === undefined) {
        const last = await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: -1 }).limit(1).next();
        item.sort = (last?.sort ?? -1) + 1;
      }
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
      const updated = await db
        .collection("menuItems")
        .findOneAndUpdate({ _id: oid(params.id), shopId: shop._id }, { $set: { ...item, updatedAt: new Date() } }, { returnDocument: "after" });
      if (!updated) throw new HttpError(404, "Menu item not found.");
      return publicItem(updated);
    },
  ],
  [
    "DELETE",
    "/menu/:id",
    async ({ db, shop, params }) => {
      const { deletedCount } = await db.collection("menuItems").deleteOne({ _id: oid(params.id), shopId: shop._id });
      if (!deletedCount) throw new HttpError(404, "Menu item not found.");
      return { ok: true };
    },
  ],
  [
    "POST",
    "/menu/reset-default",
    async ({ db, shop }) => {
      await db.collection("menuItems").deleteMany({ shopId: shop._id });
      await db.collection("menuItems").insertMany(defaultMenu(shop._id));
      return (await db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray()).map(publicItem);
    },
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
  ],
];
