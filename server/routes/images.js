// Smart photo search for menu items. Only the photo's public link is saved on the item,
// so pictures cost no database space and load from the library's own servers.
// Source: Wikimedia Commons (free licences, no key needed), or Pexels when
// PEXELS_API_KEY is set. Searches are cached for 7 days and shared by all shops.
import { z } from "zod";
import { ObjectId } from "mongodb";
import { HttpError } from "../http.js";
import { rateLimit } from "../limits.js";

const PEXELS = "https://api.pexels.com/v1/search";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
// Wikimedia asks API users to identify themselves.
const USER_AGENT = "BizoraBilling/1.0 (https://billing-app-chi-five.vercel.app)";
const CACHE_DAYS = 7;
const ENOUGH = 6; // results needed before we stop trying simpler queries
const MAX_BULK_LOOKUPS = 40; // Pexels allows ~200 searches/hour for the whole app

let fetchImpl = (...a) => fetch(...a);
export function setTestFetch(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
}

export const pexelsReady = () => !!process.env.PEXELS_API_KEY;
export const photoSource = () => (pexelsReady() ? "pexels" : "wikimedia");

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

// Menus spell dishes many ways; photo libraries use the common spelling.
const SPELLINGS = [
  [/\b(chhola|chhole|cholle|chola|chole|chana|channa)\b/g, "chole"],
  [/\bbhatur[ae]?\b/g, "bhature"],
  [/\b(pakode|pakoda|pakore|pakodi)\b/g, "pakora"],
  [/\b(pyaj|pyaz|pyaaz)\b/g, "onion"],
  [/\b(makkhan|makhan|makhkhan)\b/g, "butter"],
  [/\b(aaloo|alu)\b/g, "aloo"],
  [/\b(panir|paneeer)\b/g, "paneer"],
  [/\b(chay|chaai|chai)\b/g, "masala chai"],
  [/\b(rumali|rumaali)\b/g, "rumali"],
  [/\b(parantha|paratha|parotha)\b/g, "paratha"],
  [/\b(kulhad|kullad|kulhar)\b/g, "kulhad"],
];
export const commonSpelling = (dish) => SPELLINGS.reduce((d, [re, to]) => d.replace(re, to), dish).replace(/\b(masala )+masala chai\b/, "masala chai");

// Queries to try, most specific first.
export function queriesFor(name, category = "", source = photoSource()) {
  const dish = cleanDish(name);
  const common = commonSpelling(dish);
  const cat = cleanDish(category);
  const list = [];
  // Stock libraries need "indian food" to stay on topic; Wikimedia does best with the plain dish name.
  if (source === "pexels") {
    if (dish) list.push(`${dish} indian food`, `${common} indian food`, dish);
    if (cat && cat !== dish) list.push(`${cat} indian food`);
  } else {
    if (dish) list.push(dish, common, `${common} food`);
    if (cat && cat !== dish) list.push(`${cat} food`);
  }
  return [...new Set(list)];
}

const photoUrl = (id, size) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${size}&h=${size}&fit=crop`;
export const PEXELS_PHOTO_URL = /^https:\/\/images\.pexels\.com\/photos\/\d+\/[\w.-]+\.(jpe?g|png)(\?[\w=&.%-]*)?$/;
export const COMMONS_PHOTO_URL = /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/(thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/[^\s?#"'<>]+$/;
// Photo links a menu item may use.
export const isLibraryPhoto = (u) => PEXELS_PHOTO_URL.test(u || "") || COMMONS_PHOTO_URL.test(u || "");
export const CREDIT_URL = /^https:\/\/((www\.)?pexels\.com|commons\.wikimedia\.org)\//;

function toResult(p) {
  return {
    source: "pexels",
    id: p.id,
    thumb: photoUrl(p.id, 200),
    url: photoUrl(p.id, 400),
    alt: p.alt || "",
    author: p.photographer || "",
    authorUrl: p.photographer_url || "",
    pexelsUrl: p.url || "",
  };
}

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

async function commonsFetch(query) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "15",
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    iiurlwidth: "330",
    iiextmetadatafilter: "Artist|LicenseShortName",
  });
  let r;
  try {
    r = await fetchImpl(`${COMMONS}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    throw new HttpError(502, "Couldn't reach the photo library. Check the internet and try again.");
  }
  if (r.status === 429) throw new HttpError(429, "Photo search is busy right now. Please try again in a few minutes.");
  if (!r.ok) throw new HttpError(502, `Photo search failed (${r.status}).`);
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages
    .map((p) => {
      const ii = p.imageinfo?.[0];
      if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !ii.thumburl) return null;
      const url = ii.thumburl.split("?")[0];
      if (!COMMONS_PHOTO_URL.test(url)) return null;
      const meta = ii.extmetadata || {};
      const author = stripTags(meta.Artist?.value).slice(0, 60) || "Wikimedia Commons";
      const licence = stripTags(meta.LicenseShortName?.value);
      return {
        source: "wikimedia",
        id: p.pageid,
        thumb: url,
        url,
        alt: p.title.replace(/^File:/, "").replace(/\.\w+$/, ""),
        author: licence ? `${author} (${licence})` : author,
        authorUrl: "",
        pexelsUrl: ii.descriptionurl, // where the photo and its licence are described
      };
    })
    .filter(Boolean);
}

// One library search, through the shared cache. Returns { results, cached }.
async function librarySearch(db, query) {
  const source = photoSource();
  const key = `${source}:${query.toLowerCase()}`;
  const hit = await db.collection("imageSearch").findOne({ _id: key, expiresAt: { $gt: new Date() } });
  if (hit) return { results: hit.results, cached: true };
  const results = source === "pexels" ? await pexelsFetch(query) : await commonsFetch(query);
  await db.collection("imageSearch").replaceOne({ _id: key }, { results, expiresAt: new Date(Date.now() + CACHE_DAYS * 864e5) }, { upsert: true });
  return { results, cached: false };
}

async function pexelsFetch(query) {
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
  return ((await r.json()).photos || []).map(toResult);
}

// Tries the queries in order; stops at the first with enough photos, else returns the fullest.
async function smartSearch(db, queries, { maxLookups = Infinity } = {}) {
  let best = { query: queries[0] || "", results: [] };
  let lookups = 0;
  for (const q of queries) {
    if (lookups >= maxLookups) break;
    const { results, cached } = await librarySearch(db, q);
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
      const pexels = photoSource() === "pexels";
      return {
        query: used,
        results,
        source: photoSource(),
        credit: pexels ? "Photos provided by Pexels" : "Photos from Wikimedia Commons (free licences)",
        creditUrl: pexels ? "https://www.pexels.com" : "https://commons.wikimedia.org",
      };
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
      return { suggestions, skipped, source: photoSource() };
    },
  ],
];
