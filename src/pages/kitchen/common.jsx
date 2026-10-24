import { UNITS, fmtQty } from "../../../shared/kitchenUnits.js";
import { useApp } from "../../lib/store.jsx";
import { ensureStaff } from "../../components/StaffPin.jsx";

export { fmtQty };
// Units an entry can use for an item kept in `unit` (kg ↔ g, L ↔ ml, pcs ↔ dozen).
export const unitChoices = (unit) => Object.keys(UNITS).filter((u) => UNITS[u].base === UNITS[unit]?.base);

// Kitchen phone: make sure a worker has entered their PIN before saving an entry.
export function useStaffCheck() {
  const { user } = useApp();
  // A cook signed in on their own phone is already known; the shared phone asks for a PIN.
  return () => ensureStaff(user.role === "kitchen" && !user.staff);
}

export function DaysLeft({ ing }) {
  if (!ing.tracked) return <span className="tag">not counted yet</span>;
  if (ing.stock <= 0) return <span className="tag bad">finished</span>;
  if (ing.daysLeft == null) return null;
  const d = ing.daysLeft;
  return <span className={"tag " + (d < 1 ? "bad" : d < 3 ? "warn" : "good")}>{d < 1 ? `~${Math.max(1, Math.round(d * 24))} h left` : `~${d} days left`}</span>;
}
