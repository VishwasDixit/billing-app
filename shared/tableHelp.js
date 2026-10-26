// What customers can ask from the table QR page (icon and words, for both sides).
export const HELP_ASKS = {
  waiter: ["🙋", "Call a waiter"],
  staff: ["🙋", "Call staff"],
  water: ["💧", "Water please"],
  bill: ["🧾", "Bring the bill"],
  cutlery: ["🥄", "Extra cutlery"],
  question: ["💬", "Question"],
};
// The one-tap buttons a shop can show (Settings › Customer help), in display order.
export const QUICK_ASKS = ["waiter", "staff", "water", "bill", "cutlery"];
export const DEFAULT_HELP = { enabled: true, asks: ["waiter", "water", "bill", "cutlery"], questions: true };
export const HELP_PRESETS = {
  restaurant: { label: "🍽️ Restaurant", help: DEFAULT_HELP },
  library: { label: "📚 Library / shop", help: { enabled: true, asks: ["staff"], questions: true } },
};
// The shop's choice, or the restaurant default.
export function helpSettings(shop) {
  const h = shop?.help;
  if (!h) return { ...DEFAULT_HELP, asks: [...DEFAULT_HELP.asks] };
  return { enabled: h.enabled !== false, asks: QUICK_ASKS.filter((k) => (h.asks || []).includes(k)), questions: h.questions !== false };
}
export const helpText = (r) => (r.kind === "question" ? r.text : HELP_ASKS[r.kind]?.[1] || r.kind);
export const QUICK_REPLIES = ["On the way! 🏃", "Coming in 2 minutes", "Sorry, that's not available today"];
