// Plan ids and how they're named, shared by the server and the app.
export const PLAN_IDS = ["monthly", "halfyearly", "yearly"];

const NAMES = { monthly: "Monthly", halfyearly: "6 months", yearly: "Yearly" };
const PER = { monthly: "month", halfyearly: "6 months", yearly: "year" };

export const planName = (id) => NAMES[id] || id || "";
export const planPer = (id) => PER[id] || "";
