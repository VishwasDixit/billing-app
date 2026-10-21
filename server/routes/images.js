// Smart photo search for menu items, from the free Pexels library. Only the photo's
// public link is saved on the item, so pictures cost no database space and load from
// Pexels' servers. Searches are cached for 7 days and shared by all shops.
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { rateLimit } from "../limits.js";

const PEXELS = "https://api.pexels.com/v1/search";
const CACHE_DAYS = 7;
const ENOUGH = 6; // results needed before we stop trying simpler queries
const MAX_BULK_LOOKUPS = 40; // Pexels allows ~200 searches/hour for the whole app

let fetchImpl = (...a) => fetch(...a);
export function setTestFetch(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
}

export const pexelsReady = () => !!process.env.PEXELS_API_KEY;

// "Dal Makhani (Full)", "Masala Chai 150ml", "Spl. Veg Thali - 2 pcs" → the dish itself.
export function cleanDish(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b\d+\s*(ml|gm|g|kg|ltr|l|pcs?|pieces?|plates?)\b/g, " ")
    .replace(/\b(half|full|quarter|small|medium|large|regular|special|spl|plate|pcs?|pieces?|qty|nos?|per|extra)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Queries to try, most specific first.
export function queriesFor(name, category = "") {
  const dish = cleanDish(name);
  const cat = cleanDish(category);
  const list = [];
  if (dish) list.push(`${dish} indian food`, dish);
  if (cat && cat !== dish) list.push(`${cat} indian food`);
  return [...new Set(list)];
}

const photoUrl = (id, size) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${size}&h=${size}&fit=crop`;
export const PEXELS_PHOTO_URL = /^https:\/\/images\.pexels\.com\/photos\/\d+\/[\w.-]+\.(jpe?g|png)(\?[\w=&.%-]*)?$/;

function toResult(p) {
  return {
    id: p.id,
    thumb: photoUrl(p.id, 200),
    url: photoUrl(p.id, 400),
    alt: p.alt || "",
    author: p.photographer || "",
    authorUrl: p.photographer_url || "",
    pexelsUrl: p.url || "",
  };
}

// One Pexels search, through the shared cache. Returns { results, cached }.
async function pexelsSearch(db, query) {
  const key = query.toLowerCase();
  const hit = await db.collection("imageSearch").findOne({ _id: key, expiresAt: { $gt: new Date() } });
  if (hit) return { results: hit.results, cached: true };
  if (!pexelsReady()) throw new HttpError(503, "Photo search isn't set up yet (PEXELS_API_KEY).");
  let r;
  try {
    r = await fetchImpl(`${PEXELS}?${new URLSearchParams({ query, per_page: "15", orientation: "square" })}`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
    });
  } catch {
    throw new HttpError(502, "Couldn't reach the photo library. Check the internet and try again.");
  }
  if (r.status === 429) throw new HttpError(429, "Photo search is busy right now. Please try again in an hour.");
  if (!r.ok) throw new HttpError(502, `Photo search failed (${r.status}).`);
  const results = ((await r.json()).photos || []).map(toResult);
  await db
    .collection("imageSearch")
    .replaceOne({ _id: key }, { results, expiresAt: new Date(Date.now() + CACHE_DAYS * 864e5) }, { upsert: true });
  return { results, cached: false };
}

// Tries the queries in order; stops at the first with enough photos, else returns the fullest.
async function smartSearch(db, queries, { maxLookups = Infinity } = {}) {
  let best = { query: queries[0] || "", results: [] };
  let lookups = 0;
  for (const q of queries) {
    if (lookups >= maxLookups) break;
    const { results, cached } = await pexelsSearch(db, q);
    if (!cached) lookups++;
    if (results.length > best.results.length) best = { query: q, results };
    if (results.length >= ENOUGH) break;
  }
  return { ...best, lookups };
}

export default [
  [
    "GET",
    "/images/search",
    async ({ db, shop, query }) => {
      const q = z.string().trim().min(2, "type a dish name").max(60).parse(query.q || "");
      await rateLimit(db, `img:shop:${shop._id}`, 60, "Too many photo searches. Please try again in an hour.");
      // The exact text typed is tried first when it differs from the cleaned dish name.
      const typed = q.toLowerCase().replace(/\s+/g, " ");
      const queries = [...new Set([...queriesFor(q, query.category || ""), typed])];
      const { query: used, results } = await smartSearch(db, queries);
      return { query: used, results, credit: "Photos provided by Pexels" };
    },
  ],
  // Top suggestion per menu item, for "Auto-pick photos" (reviewed by the shop before saving).
  [
    "POST",
    "/images/bulk-suggest",
    async ({ db, shop, body }) => {
      const { itemIds } = z.object({ itemIds: z.array(z.string()).min(1).max(100) }).parse(body);
      await rateLimit(db, `img-bulk:shop:${shop._id}`, 5, "Too many auto-picks. Please try again in an hour.");
      const ids = itemIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
      const items = await db.collection("menuItems").find({ _id: { $in: ids }, shopId: shop._id }, { projection: { name: 1, category: 1 } }).toArray();
      const suggestions = [];
      let lookups = 0;
      let skipped = 0;
      for (const it of items) {
        if (lookups >= MAX_BULK_LOOKUPS) {
          skipped++;
          continue;
        }
        // Only the most specific query per item here, to stay within the library's limits.
        const [first] = queriesFor(it.name, it.category);
        if (!first) continue;
        const r = await smartSearch(db, [first], { maxLookups: 1 });
        lookups += r.lookups;
        if (r.results[0]) suggestions.push({ itemId: String(it._id), name: it.name, photo: r.results[0], more: r.results.slice(1, 4) });
      }
      return { suggestions, skipped };
    },
  ],
];
