// Add-ons (Menu › Add-ons): shared groups like "Sauces" or "Extra cheese" that some dishes or whole
// categories offer. Shared by the server (which prices them) and the screens (same numbers offline).
// A group: { id, name, min, max, options: [{ id, name, price, off }], items: [itemId], categories: [name] }
// min 0 = optional; max 1 = pick one. A line keeps what was picked as addons: [{ name, price }],
// and its rate already includes them.
import { round2 } from "./totals.js";

export const MAX_ADDON_GROUPS = 30;
export const MAX_ADDON_OPTIONS = 15;
export const MAX_LINE_ADDONS = 10;

const idOf = (item) => String(item?.id ?? item?._id ?? "");

// The groups this dish offers: chosen for the dish itself, or for its category.
export const addonGroupsFor = (groups, item) =>
  (groups || []).filter((g) => (g.options || []).length && ((g.items || []).includes(idOf(item)) || (!!item?.category && (g.categories || []).includes(item.category))));

// "Pick up to 2", "Pick 1", "Required" — what the customer is asked for.
export function addonRule(g) {
  const min = g.min || 0;
  const max = Math.min(g.max || 1, (g.options || []).length || 1);
  if (min && min === max) return `Pick ${min}`;
  if (min) return `Pick ${min}–${max}`;
  return max === 1 ? "Pick 1 (optional)" : `Pick up to ${max}`;
}

// Checks what was picked (option ids) against the dish's groups. Returns { addons, error }.
export function checkAddons(groups, picked = []) {
  const want = new Set(picked);
  const addons = [];
  for (const g of groups || []) {
    const chosen = (g.options || []).filter((o) => want.has(o.id));
    chosen.forEach((o) => want.delete(o.id));
    const off = chosen.find((o) => o.off);
    if (off) return { addons: [], error: `${off.name} is not available today. Please pick again.` };
    const min = g.min || 0;
    const max = Math.min(g.max || 1, g.options.length);
    if (chosen.length < min) return { addons: [], error: `Please pick ${min === 1 ? "one" : min} for ${g.name}.` };
    if (chosen.length > max) return { addons: [], error: `You can pick up to ${max} for ${g.name}.` };
    chosen.forEach((o) => addons.push({ name: o.name, price: Number(o.price) || 0 }));
  }
  if (want.size) return { addons: [], error: "Some add-ons changed. Please pick again." };
  return { addons, error: "" };
}

export const addonsTotal = (addons) => round2((addons || []).reduce((s, a) => s + (Number(a.price) || 0), 0));

// The ids picked, as one stable piece of the cart line key.
export const addonKey = (ids) => [...(ids || [])].sort().join(",");

// "Burger (Large) + Extra cheese, Mayo"
export const addonText = (addons) => (addons || []).map((a) => a.name).join(", ");
export const lineLabel = (l) => `${l.name}${l.variant ? ` (${l.variant})` : ""}${l.addons?.length ? ` + ${addonText(l.addons)}` : ""}`;
