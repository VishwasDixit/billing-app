// Default menu pictures: drawn illustrations in public/menu/<key>.svg, matched to
// an item by keywords in its name, then by category. Used by the server seed
// and by the menu editor, so new items get a sensible picture automatically.

export const IMAGE_KEYS = [
  "samosa", "tea", "coffee", "kulhad", "lassi", "chaas", "lemon", "bread", "breadjam", "bun",
  "garlicbread", "pakoda", "poha", "upma", "chhole", "fries", "sandwich", "momos", "soup", "kebab",
  "balls", "corn", "roti", "paratha", "dal", "curry", "palak", "sabzi", "thali", "noodles",
  "friedrice", "manchurian", "chilli", "ricebowl", "plate",
];

// First match wins, so more specific dishes come first
// (e.g. "Paneer Pakoda" is a pakoda, "Chilli Paneer" is chilli, "Mix Veg Paratha" is a paratha).
const NAME_RULES = [
  [/thali/, "thali"],
  [/pakod|pakor|bonda|bhaji|bhajia/, "pakoda"],
  [/samosa|kachori/, "samosa"],
  [/bhatur|chhol|chole/, "chhole"],
  [/kulhad|kullad/, "kulhad"],
  [/coffee/, "coffee"],
  [/\btea\b|chai/, "tea"],
  [/lassi|shake|smoothie/, "lassi"],
  [/chaas|chach|buttermilk/, "chaas"],
  [/lemon|lime|soda|nimbu|shikanji|juice/, "lemon"],
  [/momo/, "momos"],
  [/fries|finger chips/, "fries"],
  [/sandwich|burger/, "sandwich"],
  [/garlic bread/, "garlicbread"],
  [/jam/, "breadjam"],
  [/\bbun\b|maska|makkhan|pav\b/, "bun"],
  [/bread|toast/, "bread"],
  [/poha/, "poha"],
  [/upma|khichdi/, "upma"],
  [/soup/, "soup"],
  [/ball/, "balls"],
  [/kebab|kabab|cutlet|tikki|tikka/, "kebab"],
  [/corn/, "corn"],
  [/paratha|parantha/, "paratha"],
  [/roti|naan|chapati|phulka|kulcha|puri\b/, "roti"],
  [/\bdal\b|daal/, "dal"],
  [/palak|saag/, "palak"],
  [/bowl|combo/, "ricebowl"],
  [/noodle|chowmein|chow mein|hakka/, "noodles"],
  [/rice|biryani|pulao/, "friedrice"],
  [/manchurian/, "manchurian"],
  [/chilli|chili/, "chilli"],
  [/paneer|mushroom|kofta|korma|masala|makhani|curry|kadai/, "curry"],
  [/aloo|alu\b|sabzi|sabji|\bveg\b|tamatar|bhindi|gobi|matar/, "sabzi"],
];

const CATEGORY_RULES = [
  [/tea|beverage|drink|juice|coffee/, "tea"],
  [/soup/, "soup"],
  [/chinese/, "noodles"],
  [/main|curry|sabzi/, "curry"],
  [/breakfast/, "poha"],
  [/snack|starter|special/, "pakoda"],
  [/roti|paratha|bread/, "roti"],
  [/dal/, "dal"],
  [/thali/, "thali"],
  [/sandwich/, "sandwich"],
  [/bowl|rice/, "ricebowl"],
];

export function defaultImageKey(name = "", category = "") {
  const n = String(name).toLowerCase();
  const c = String(category).toLowerCase();
  for (const [re, key] of NAME_RULES) if (re.test(n)) return key;
  for (const [re, key] of CATEGORY_RULES) if (re.test(c)) return key;
  return "plate";
}

export const defaultImageFor = (name, category) => `/menu/${defaultImageKey(name, category)}.svg`;

export const isDefaultImage = (url) => /^\/menu\/[a-z]+\.svg$/.test(url || "");
