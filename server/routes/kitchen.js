// Kitchen management: ingredients (kitchen stock), recipes, cook entries, alerts,
// shopping list and the kitchen report. Usable on the kitchen phone (staff with a PIN).
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { UNIT_NAMES, convert } from "../kitchen/units.js";
import { STARTER, standardRecipe } from "../kitchen/library.js";
import {
  publicIngredient, applyMove, checkExpiry, checkLowStock, shoppingList, kitchenReport, plateCost, dailyUse, now,
} from "../kitchen/inventory.js";
import { dayRange } from "./analytics.js";
import { brainSummary, applySuggestion } from "../brain/index.js";

const K = { kitchen: true };
const oid = (id, what = "Item") => {
  if (!ObjectId.isValid(id)) throw new HttpError(404, `${what} not found.`);
  return new ObjectId(id);
};
export const KITCHEN_CATEGORIES = ["Masala", "Oil & ghee", "Vegetables", "Dairy", "Grains & dal", "Bakery", "Sauces", "Beverages", "Meat & eggs", "Packaging", "Other"];

const IngredientIn = z.object({
  name: z.string().trim().min(1).max(50),
  category: z.string().trim().max(30).default("Other"),
  unit: z.enum(UNIT_NAMES),
  minStock: z.number().min(0).max(1e6).nullable().optional(),
  costPerUnit: z.number().min(0).max(1e6).nullable().optional(),
  shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
});

const MoveIn = z.object({
  clientId: z.string().uuid(),
  ingredientId: z.string(),
  type: z.enum(["purchase", "waste", "expired", "count"]),
  qty: z.number().min(0).max(1e7),
  unit: z.enum(UNIT_NAMES).optional(),
  cost: z.number().min(0).max(1e7).optional(),
  expiry: z.coerce.date().nullable().optional(),
  reason: z.enum(["spilled", "burnt", "spoiled", "dropped", "expired", "other"]).optional(),
  note: z.string().trim().max(120).optional(),
  photo: z.string().max(110 * 1024).refine((s) => /^data:image\/(jpeg|webp|png);base64,/.test(s)).optional(),
  batchId: z.string().optional(),
});

const RecipeIn = z.object({
  variants: z.record(
    z.string().max(20),
    z.array(z.object({ ingredientId: z.string(), qty: z.number().min(0).max(1e6), unit: z.enum(UNIT_NAMES) })).max(40)
  ),
  steps: z.array(z.object({ text: z.string().trim().min(1).max(300), minutes: z.number().min(0).max(600).nullable().optional() })).max(30).default([]),
  notes: z.string().trim().max(500).optional().default(""),
});

// Entries from a shared kitchen phone must say which staff member made them.
function who(ctx) {
  if (ctx.user.role === "kitchen" && !ctx.staff) throw new HttpError(401, "Please enter your name and PIN first.", { code: "STAFF_PIN" });
  return ctx.staff;
}

const ownerOnly = (ctx) => {
  if (ctx.user.role === "kitchen") throw new HttpError(403, "Only the owner can see this.");
};

export default [
  // ---------- Ingredients ----------
  [
    "GET",
    "/kitchen/ingredients",
    async ({ db, shop }) => {
      const list = await db.collection("ingredients").find({ shopId: shop._id }).sort({ category: 1, name: 1 }).toArray();
      const use = await dailyUse(db, shop._id, null);
      return {
        ingredients: list.map((i) => {
          const p = publicIngredient(i);
          const perDay = use.get(String(i._id)) || 0;
          return { ...p, perDay: Math.round(perDay * 1000) / 1000, daysLeft: perDay > 0 ? Math.round((i.stock / perDay) * 10) / 10 : null };
        }),
        categories: KITCHEN_CATEGORIES,
        starter: STARTER.map(([name, category, unit, price, shelf, min]) => ({ name, category, unit, costPerUnit: price, shelfLifeDays: shelf, minStock: min })),
      };
    },
    K,
  ],
  [
    "POST",
    "/kitchen/ingredients",
    async ({ db, shop, body }) => {
      const i = IngredientIn.parse(body);
      if (await db.collection("ingredients").findOne({ shopId: shop._id, nameKey: i.name.toLowerCase() })) throw new HttpError(409, `${i.name} is already in your kitchen stock.`);
      const doc = { ...i, nameKey: i.name.toLowerCase(), shopId: shop._id, stock: 0, batches: [], tracked: false, createdAt: now() };
      doc._id = (await db.collection("ingredients").insertOne(doc)).insertedId;
      return publicIngredient(doc);
    },
    K,
  ],
  // Adds starter items by name (skips ones already there).
  [
    "POST",
    "/kitchen/ingredients/starter",
    async ({ db, shop, body }) => {
      const { names } = z.object({ names: z.array(z.string()).min(1).max(200) }).parse(body);
      const have = new Set((await db.collection("ingredients").find({ shopId: shop._id }, { projection: { nameKey: 1 } }).toArray()).map((i) => i.nameKey));
      const docs = STARTER.filter(([n]) => names.includes(n) && !have.has(n.toLowerCase())).map(([name, category, unit, price, shelf, min]) => ({
        shopId: shop._id, name, nameKey: name.toLowerCase(), category, unit, costPerUnit: price, shelfLifeDays: shelf, minStock: min, stock: 0, batches: [], tracked: false, createdAt: now(),
      }));
      if (docs.length) await db.collection("ingredients").insertMany(docs);
      return { added: docs.length };
    },
    K,
  ],
  [
    "PUT",
    "/kitchen/ingredients/:id",
    async ({ db, shop, params, body }) => {
      const i = IngredientIn.partial().parse(body);
      const cur = await db.collection("ingredients").findOne({ _id: oid(params.id), shopId: shop._id });
      if (!cur) throw new HttpError(404, "Item not found.");
      // Changing the unit converts the stock and batches (kg → g keeps the same amount).
      const $set = { ...i, updatedAt: now(), ...(i.name && { nameKey: i.name.toLowerCase() }) };
      if (i.unit && i.unit !== cur.unit) {
        const f = convert(1, cur.unit, i.unit);
        if (f === null) throw new HttpError(400, `Can't change ${cur.unit} to ${i.unit}.`);
        $set.stock = cur.stock * f;
        $set.batches = (cur.batches || []).map((b) => ({ ...b, qty: b.qty * f }));
        if (cur.minStock) $set.minStock = cur.minStock * f;
        if (cur.costPerUnit) $set.costPerUnit = cur.costPerUnit / f;
      }
      const updated = await db.collection("ingredients").findOneAndUpdate({ _id: cur._id }, { $set }, { returnDocument: "after" });
      await checkLowStock(db, shop._id, [cur._id]);
      return publicIngredient(updated);
    },
    K,
  ],
  [
    "DELETE",
    "/kitchen/ingredients/:id",
    async (ctx) => {
      ownerOnly(ctx);
      const { db, shop, params } = ctx;
      const id = oid(params.id);
      const used = await db.collection("recipes").countDocuments({ shopId: shop._id, ingredientIds: String(id) });
      if (used) throw new HttpError(409, `This item is used in ${used} recipe${used === 1 ? "" : "s"}. Remove it from those recipes first.`);
      await db.collection("ingredients").deleteOne({ _id: id, shopId: shop._id });
      await db.collection("kitchenAlerts").updateMany({ shopId: shop._id, ingredientId: String(id), resolvedAt: null }, { $set: { resolvedAt: now() } });
      return { ok: true };
    },
    K,
  ],

  // ---------- Cook entries (works offline: sent in a batch, each once) ----------
  [
    "POST",
    "/kitchen/moves",
    async (ctx) => {
      const staff = who(ctx);
      const list = z.object({ moves: z.array(z.unknown()).min(1).max(100) }).parse(ctx.body).moves;
      const results = [];
      for (const raw of list) {
        const p = MoveIn.safeParse(raw);
        if (!p.success) {
          results.push({ clientId: raw?.clientId, ok: false, error: p.error.issues[0]?.message || "Invalid entry" });
          continue;
        }
        if (!ObjectId.isValid(p.data.ingredientId)) {
          results.push({ clientId: p.data.clientId, ok: false, error: "Item not found." });
          continue;
        }
        if (await ctx.db.collection("stockMoves").findOne({ shopId: ctx.shop._id, clientId: p.data.clientId }, { projection: { _id: 1 } })) {
          results.push({ clientId: p.data.clientId, ok: true, duplicate: true });
          continue;
        }
        results.push({ clientId: p.data.clientId, ...(await applyMove(ctx.db, ctx.shop._id, p.data, staff)) });
      }
      return { results };
    },
    K,
  ],
  [
    "GET",
    "/kitchen/moves",
    async ({ db, shop, query }) => {
      const { start, end } = dayRange(query.from, query.to);
      const filter = { shopId: shop._id, at: { $gte: start, $lt: end }, ...(query.type && { type: query.type }), ...(query.ingredientId && { ingredientId: query.ingredientId }) };
      const list = await db.collection("stockMoves").find(filter).sort({ at: -1 }).limit(500).toArray();
      return { moves: list.map(({ _id, shopId, photo, ...m }) => ({ ...m, id: String(_id), hasPhoto: !!photo })) };
    },
    K,
  ],

  // ---------- Recipes ----------
  [
    "GET",
    "/kitchen/recipes",
    async ({ db, shop }) => {
      const [menu, recipes, ings] = await Promise.all([
        db.collection("menuItems").find({ shopId: shop._id }).sort({ sort: 1 }).toArray(),
        db.collection("recipes").find({ shopId: shop._id }).toArray(),
        db.collection("ingredients").find({ shopId: shop._id }).toArray(),
      ]);
      const byItem = new Map(recipes.map((r) => [r.itemId, r]));
      const ingById = new Map(ings.map((i) => [String(i._id), i]));
      return {
        items: menu.map((m) => {
          const r = byItem.get(String(m._id));
          return {
            itemId: String(m._id),
            name: m.name,
            category: m.category || "Other",
            variants: m.variants,
            hasRecipe: !!r,
            standard: !r && !!standardRecipe(m.name, m.variants),
            ...(r && { cost: plateCost(r, ingById), steps: r.steps.length }),
          };
        }),
      };
    },
    K,
  ],
  [
    "GET",
    "/kitchen/recipes/:itemId",
    async ({ db, shop, params }) => {
      const item = await db.collection("menuItems").findOne({ _id: oid(params.itemId, "Dish"), shopId: shop._id });
      if (!item) throw new HttpError(404, "Dish not found.");
      const [recipe, ings] = await Promise.all([
        db.collection("recipes").findOne({ shopId: shop._id, itemId: params.itemId }),
        db.collection("ingredients").find({ shopId: shop._id }).toArray(),
      ]);
      const ingById = new Map(ings.map((i) => [String(i._id), i]));
      // The standard recipe, matched to this shop's stock items by name (missing ones listed).
      const std = standardRecipe(item.name, item.variants);
      let standard = null;
      if (std) {
        const byName = new Map(ings.map((i) => [i.nameKey, i]));
        const missing = new Set();
        const variants = Object.fromEntries(
          Object.entries(std.variants).map(([label, parts]) => [
            label,
            parts.map((p) => {
              const ing = byName.get(p.ingredient.toLowerCase());
              if (!ing) missing.add(p.ingredient);
              return { ingredientId: ing ? String(ing._id) : null, name: p.ingredient, qty: p.qty, unit: p.unit };
            }),
          ])
        );
        standard = { variants, steps: std.steps, missing: [...missing] };
      }
      return {
        item: { id: String(item._id), name: item.name, variants: item.variants, price: Object.fromEntries(item.variants.map((v) => [v.label || "", v.price])) },
        recipe: recipe && { variants: recipe.variants, steps: recipe.steps, notes: recipe.notes || "", updatedAt: recipe.updatedAt, updatedBy: recipe.updatedBy, cost: plateCost(recipe, ingById) },
        standard,
      };
    },
    K,
  ],
  [
    "PUT",
    "/kitchen/recipes/:itemId",
    async (ctx) => {
      const { db, shop, params, body } = ctx;
      const item = await db.collection("menuItems").findOne({ _id: oid(params.itemId, "Dish"), shopId: shop._id });
      if (!item) throw new HttpError(404, "Dish not found.");
      const r = RecipeIn.parse(body);
      const ids = [...new Set(Object.values(r.variants).flat().map((p) => p.ingredientId))];
      const known = await db
        .collection("ingredients")
        .find({ shopId: shop._id, _id: { $in: ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i)) } })
        .toArray();
      if (known.length !== ids.length) throw new HttpError(400, "Some ingredients aren't in your kitchen stock. Add them first.");
      for (const p of Object.values(r.variants).flat()) {
        const ing = known.find((k) => String(k._id) === p.ingredientId);
        if (convert(1, p.unit, ing.unit) === null) throw new HttpError(400, `${ing.name} is kept in ${ing.unit}; use ${ing.unit === "kg" || ing.unit === "g" ? "kg or g" : ing.unit === "L" || ing.unit === "ml" ? "L or ml" : ing.unit}.`);
      }
      await db.collection("recipes").updateOne(
        { shopId: shop._id, itemId: params.itemId },
        { $set: { ...r, itemName: item.name, ingredientIds: ids, updatedAt: now(), updatedBy: ctx.staff?.name || (ctx.user.role === "kitchen" ? "Kitchen" : "Owner") } },
        { upsert: true }
      );
      return { ok: true };
    },
    K,
  ],
  [
    "DELETE",
    "/kitchen/recipes/:itemId",
    async ({ db, shop, params }) => {
      await db.collection("recipes").deleteOne({ shopId: shop._id, itemId: params.itemId });
      return { ok: true };
    },
    K,
  ],
  // Standard recipes for many dishes at once; adds any missing starter ingredients.
  [
    "POST",
    "/kitchen/recipes/standard",
    async ({ db, shop, body }) => {
      const { itemIds } = z.object({ itemIds: z.array(z.string()).min(1).max(300) }).parse(body);
      const items = await db
        .collection("menuItems")
        .find({ shopId: shop._id, _id: { $in: itemIds.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i)) } })
        .toArray();
      const have = await db.collection("recipes").find({ shopId: shop._id, itemId: { $in: itemIds } }, { projection: { itemId: 1 } }).toArray();
      const skip = new Set(have.map((h) => h.itemId));
      let ings = await db.collection("ingredients").find({ shopId: shop._id }).toArray();
      const byName = () => new Map(ings.map((i) => [i.nameKey, i]));
      let created = 0;
      let added = 0;
      for (const item of items) {
        if (skip.has(String(item._id))) continue;
        const std = standardRecipe(item.name, item.variants);
        if (!std) continue;
        const need = [...new Set(Object.values(std.variants).flat().map((p) => p.ingredient))].filter((n) => !byName().has(n.toLowerCase()));
        const docs = STARTER.filter(([n]) => need.includes(n)).map(([name, category, unit, price, shelf, min]) => ({
          shopId: shop._id, name, nameKey: name.toLowerCase(), category, unit, costPerUnit: price, shelfLifeDays: shelf, minStock: min, stock: 0, batches: [], tracked: false, createdAt: now(),
        }));
        if (docs.length) {
          await db.collection("ingredients").insertMany(docs);
          added += docs.length;
          ings = await db.collection("ingredients").find({ shopId: shop._id }).toArray();
        }
        const map = byName();
        const variants = Object.fromEntries(
          Object.entries(std.variants).map(([label, parts]) => [
            label,
            parts.filter((p) => map.has(p.ingredient.toLowerCase())).map((p) => ({ ingredientId: String(map.get(p.ingredient.toLowerCase())._id), qty: p.qty, unit: p.unit })),
          ])
        );
        await db.collection("recipes").insertOne({
          shopId: shop._id, itemId: String(item._id), itemName: item.name, variants, steps: std.steps, notes: "", standard: true,
          ingredientIds: [...new Set(Object.values(variants).flat().map((p) => p.ingredientId))], updatedAt: now(), updatedBy: "Standard recipe",
        });
        created++;
      }
      return { created, ingredientsAdded: added };
    },
    K,
  ],

  // ---------- Alerts ----------
  [
    "GET",
    "/kitchen/alerts",
    async ({ db, shop }) => {
      await checkExpiry(db, shop._id);
      const ids = (await db.collection("ingredients").find({ shopId: shop._id, tracked: true }, { projection: { _id: 1 } }).toArray()).map((i) => i._id);
      if (ids.length) await checkLowStock(db, shop._id, ids);
      const list = await db
        .collection("kitchenAlerts")
        .find({ shopId: shop._id, resolvedAt: null, dismissedAt: { $exists: false } })
        .sort({ level: 1, updatedAt: -1 })
        .limit(100)
        .toArray();
      const order = { high: 0, warn: 1, info: 2 };
      list.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3) || new Date(b.updatedAt) - new Date(a.updatedAt));
      return { alerts: list.map(({ _id, shopId, ...a }) => ({ ...a, id: String(_id) })) };
    },
    K,
  ],
  [
    "GET",
    "/kitchen/alerts/count",
    async ({ db, shop }) => ({ count: await db.collection("kitchenAlerts").countDocuments({ shopId: shop._id, resolvedAt: null, dismissedAt: { $exists: false }, level: { $in: ["high", "warn"] } }) }),
    K,
  ],
  [
    "POST",
    "/kitchen/alerts/:id/dismiss",
    async ({ db, shop, params, staff, user }) => {
      await db.collection("kitchenAlerts").updateOne(
        { _id: oid(params.id, "Alert"), shopId: shop._id },
        { $set: { dismissedAt: now(), dismissedBy: staff?.name || (user.role === "kitchen" ? "Kitchen" : "Owner") } }
      );
      return { ok: true };
    },
    K,
  ],

  // ---------- Shopping list and report ----------
  [
    "GET",
    "/kitchen/shopping-list",
    async ({ db, shop, query }) => shoppingList(db, shop._id, { coverDays: Math.min(14, Math.max(1, Number(query.days) || 3)) }),
    K,
  ],
  [
    "GET",
    "/kitchen/report",
    async (ctx) => {
      ownerOnly(ctx);
      const { start, end, from, to } = dayRange(ctx.query.from, ctx.query.to);
      return { from, to, ...(await kitchenReport(ctx.db, ctx.shop._id, start, end)) };
    },
    K,
  ],

  // ---------- Kitchen Brain (learned forecast, reorder levels, recipe fixes, insights) ----------
  [
    "GET",
    "/kitchen/brain",
    async ({ db, shop, user, query }) => {
      const owner = user.role !== "kitchen";
      const b = await brainSummary(db, shop._id, { fresh: owner && query.fresh === "1" });
      if (owner) return b;
      // The kitchen phone gets the cooking plan, not money.
      const { insights, suggestions, ...rest } = b;
      return { ...rest, specials: b.specials.map(({ value, ...x }) => x), insights: [], suggestions: [] };
    },
    K,
  ],
  [
    "POST",
    "/kitchen/brain/suggestions/:id/:action",
    async (ctx) => {
      ownerOnly(ctx);
      const { db, shop, params } = ctx;
      if (!ObjectId.isValid(params.id)) throw new HttpError(404, "Suggestion not found.");
      if (params.action === "apply") {
        const r = await applySuggestion(db, shop._id, params.id);
        if (!r.ok) throw new HttpError(404, "This suggestion was already answered.");
        return r;
      }
      if (params.action !== "dismiss") throw new HttpError(404, "Not found.");
      await db.collection("brainSuggestions").updateOne({ _id: new ObjectId(params.id), shopId: shop._id }, { $set: { status: "dismissed", updatedAt: now() } });
      return { ok: true };
    },
    K,
  ],
];
