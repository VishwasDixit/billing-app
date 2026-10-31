// Dice game on the QR menu: once a day per mobile (and per phone), throw two dice; a total of 7
// wins a one-time code for `percent`% off (up to maxDiscount) on an order of minOrder or more,
// usable today. The server rolls; the screen only shows what it rolled.

export const DICE_DEFAULTS = { on: false, percent: 50, minOrder: 120, maxDiscount: 100 };
export const DICE_TARGET = 7;

export const diceRule = (shop) => {
  const d = { ...DICE_DEFAULTS, ...(shop?.dice || {}) };
  return d.on ? d : null;
};

export const isWin = (dice) => dice.length === 2 && dice[0] + dice[1] === DICE_TARGET;

// "50% off up to ₹100 on orders above ₹120"
export function diceOfferText(rule, cur = "₹") {
  return `${rule.percent}% off${rule.maxDiscount ? ` up to ${cur}${rule.maxDiscount}` : ""}${rule.minOrder ? ` on orders above ${cur}${rule.minOrder}` : ""}`;
}
