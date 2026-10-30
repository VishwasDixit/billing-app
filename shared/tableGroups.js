// Table groups (Settings › Table groups): some tables — e.g. QR codes at places far away that get
// deliveries — have their own prices and a delivery charge. Shared by the server (which decides)
// and the screens (which show the same numbers, also offline).
// A group: { id, name, tables: [tableId], pricePercent (−50…200), prices: { itemId: { variant: price } },
//   delivery: { charge, freeFrom } } — charge 0 = none; freeFrom 0 = always charged.
import { round2 } from "./totals.js";

export const MAX_GROUPS = 20;
export const CHARGE_CATEGORY = "Charges";

// Can this table order the dish by QR? Dishes with no tables set are for every table.
export const servedAt = (item, tableId) => !item?.tables?.length || item.tables.includes(tableId);

export const groupOf = (shop, tableId) => (tableId && (shop?.tableGroups || []).find((g) => (g.tables || []).includes(tableId))) || null;

// The price of one size of a dish for this group: its own price if set, else the menu price
// changed by the group's percent, in whole rupees.
export function groupPrice(group, itemId, variantLabel, menuPrice) {
  if (!group) return menuPrice;
  const own = group.prices?.[itemId]?.[variantLabel || ""];
  if (typeof own === "number" && own >= 0) return own;
  const pct = Number(group.pricePercent) || 0;
  return pct ? Math.max(0, Math.round(menuPrice * (1 + pct / 100))) : menuPrice;
}

// The menu as this group's tables see it.
export const priceMenuFor = (group, menu) =>
  group ? menu.map((m) => ({ ...m, variants: m.variants.map((v) => ({ ...v, price: groupPrice(group, String(m.id ?? m._id), v.label, v.price) })) })) : menu;

const isCharge = (l) => !!l?.charge;
// Food only (no delivery charge): what free delivery and promo minimums are judged on.
export const foodTotal = (lines) => round2((lines || []).filter((l) => !isCharge(l)).reduce((s, l) => s + l.qty * l.rate, 0));
export const withoutCharges = (lines) => (lines || []).filter((l) => !isCharge(l));

export function deliveryRule(group) {
  const charge = Number(group?.delivery?.charge) || 0;
  return charge > 0 ? { charge, freeFrom: Number(group.delivery.freeFrom) || 0 } : null;
}

// The delivery charge line for an order with this much food, or null.
export function deliveryLine(group, food) {
  const r = deliveryRule(group);
  if (!r || (r.freeFrom > 0 && food >= r.freeFrom)) return null;
  return { itemId: "", name: "Delivery charge", variant: "", category: CHARGE_CATEGORY, qty: 1, rate: r.charge, note: "", charge: true };
}

// How much more food makes delivery free (0 = already free or no rule).
export function freeDeliveryGap(group, food) {
  const r = deliveryRule(group);
  return r && r.freeFrom > 0 && food < r.freeFrom ? round2(r.freeFrom - food) : 0;
}

// "🛵 Delivery ₹30 · free on orders of ₹300+"
export function deliveryText(rule, cur = "₹") {
  if (!rule) return "";
  return `🛵 Delivery ${cur}${rule.charge}${rule.freeFrom > 0 ? ` · free on orders of ${cur}${rule.freeFrom}+` : ""}`;
}
