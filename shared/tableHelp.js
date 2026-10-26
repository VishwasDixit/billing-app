// What customers can ask from the table QR page (icon and words, for both sides).
export const HELP_ASKS = {
  waiter: ["🙋", "Call a waiter"],
  water: ["💧", "Water please"],
  bill: ["🧾", "Bring the bill"],
  cutlery: ["🥄", "Extra cutlery"],
  question: ["💬", "Question"],
};
export const helpText = (r) => (r.kind === "question" ? r.text : HELP_ASKS[r.kind]?.[1] || r.kind);
export const QUICK_REPLIES = ["On the way! 🏃", "Coming in 2 minutes", "Sorry, that's not available today"];
