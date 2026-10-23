// Attendance and salary maths, shared by the server and the app.
export const ATTENDANCE = {
  present: { label: "Present", short: "P", pay: 1, days: 1 },
  half: { label: "Half day", short: "H", pay: 0.5, days: 0.5 },
  absent: { label: "Absent", short: "A", pay: 0, days: 0 },
  leave: { label: "Leave (unpaid)", short: "L", pay: 0, days: 0 },
  paidleave: { label: "Paid leave", short: "PL", pay: 1, days: 0 },
  weekoff: { label: "Week off", short: "WO", pay: 1, days: 0 },
};
export const STATUS_IDS = Object.keys(ATTENDANCE);

export const daysInMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// staff: { wageType: "monthly" | "daily", wage, otRate }
// records: that worker's attendance for the month; advances / payments: amounts given that month.
export function salaryFor(staff, month, records, advances = [], payments = []) {
  const count = Object.fromEntries(STATUS_IDS.map((s) => [s, 0]));
  let otHours = 0;
  for (const r of records) {
    if (count[r.status] !== undefined) count[r.status] += 1;
    otHours += Number(r.otHours) || 0;
  }
  const dim = daysInMonth(month);
  const monthly = staff.wageType !== "daily";
  // Monthly wage: paid days include week offs and paid leave. Daily wage: only days worked.
  const paidDays = monthly
    ? STATUS_IDS.reduce((s, k) => s + count[k] * ATTENDANCE[k].pay, 0)
    : count.present + count.half * 0.5;
  const perDay = monthly ? (Number(staff.wage) || 0) / dim : Number(staff.wage) || 0;
  const earned = r2(perDay * paidDays);
  const overtime = r2(otHours * (Number(staff.otRate) || 0));
  const advance = r2(advances.reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const paid = r2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  return {
    month,
    daysInMonth: dim,
    count,
    marked: records.length,
    workedDays: count.present + count.half * 0.5,
    paidDays,
    perDay: r2(perDay),
    earned,
    otHours,
    overtime,
    gross: r2(earned + overtime),
    advance,
    paid,
    payable: r2(earned + overtime - advance - paid),
  };
}
