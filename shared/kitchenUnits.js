// Kitchen units. Stock is stored in a base unit (g, ml or pcs); recipes and entries can use
// any unit of the same kind (a recipe in g takes stock kept in kg).
export const UNITS = {
  kg: { base: "g", factor: 1000 },
  g: { base: "g", factor: 1 },
  L: { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  pcs: { base: "pcs", factor: 1 },
  dozen: { base: "pcs", factor: 12 },
  packet: { base: "packet", factor: 1 },
};
export const UNIT_NAMES = Object.keys(UNITS);

export const sameKind = (a, b) => UNITS[a] && UNITS[b] && UNITS[a].base === UNITS[b].base;
export const toBase = (qty, unit) => (Number(qty) || 0) * (UNITS[unit]?.factor ?? 1);
export const fromBase = (qty, unit) => (Number(qty) || 0) / (UNITS[unit]?.factor ?? 1);

// Converts between units of the same kind; null if they don't match (e.g. g → ml).
export function convert(qty, from, to) {
  if (from === to) return Number(qty) || 0;
  if (!sameKind(from, to)) return null;
  return fromBase(toBase(qty, from), to);
}

const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

// "1.25 kg", "750 g", "12 pcs": shown in the unit the item is kept in, smaller unit when below 1.
export function fmtQty(qty, unit) {
  const q = Number(qty) || 0;
  if (unit === "kg" && Math.abs(q) < 1 && q !== 0) return `${round(q * 1000, 0)} g`;
  if (unit === "L" && Math.abs(q) < 1 && q !== 0) return `${round(q * 1000, 0)} ml`;
  return `${round(q, unit === "pcs" || unit === "packet" ? 1 : 2)} ${unit}`;
}
