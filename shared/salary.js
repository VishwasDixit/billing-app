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

// How a shop pays (Staff › Salary › Settings).
// weeklyOff: weekdays (0 = Sunday) that count as Week off when not marked.
// unmarked: "none" (unmarked days aren't paid) or "present" (only absences need marking).
// dayBasis: day rate for monthly wages = wage ÷ days in month ("month"), ÷ 30, or ÷ 26 working days.
// otAuto: overtime per hour = day rate ÷ shift hours when a worker has no overtime rate.
export const DEFAULT_SALARY_SETTINGS = { weeklyOff: [], unmarked: "none", dayBasis: "month", otAuto: false };
export const salarySettings = (s) => ({ ...DEFAULT_SALARY_SETTINGS, ...(s || {}) });

export const addMonths = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
export const monthsBetween = (a, b) => {
  const out = [];
  for (let m = a; m <= b && out.length < 600; m = addMonths(m, 1)) out.push(m);
  return out;
};

// The wage in force for a month: raises apply from their month, past months keep the old wage.
export function wageFor(staff, month) {
  const h = (staff.wageHistory || []).filter((w) => w.from <= month).sort((a, b) => (a.from < b.from ? -1 : 1)).at(-1);
  return h ? { wage: Number(h.wage) || 0, wageType: h.wageType || staff.wageType || "monthly" } : { wage: Number(staff.wage) || 0, wageType: staff.wageType || "monthly" };
}

// A day nobody marked: Week off on the weekly off day, Present if the shop counts unmarked days.
// Only for days the worker was with the shop, up to today.
export function autoStatus(staff, date, settings, today) {
  const st = salarySettings(settings);
  if (date > today) return null;
  if (staff.joinedAt && date < staff.joinedAt) return null;
  if (staff.leftAt && date > staff.leftAt) return null;
  if (st.weeklyOff.includes(new Date(date + "T12:00:00Z").getUTCDay())) return "weekoff";
  return st.unmarked === "present" ? "present" : null;
}

// Loan instalment for a month: the monthly cut from the start month, not in skipped months,
// never more than what is left; stops once repaid or closed.
export function loanFor(loan, month) {
  let left = Number(loan.amount) || 0;
  let cut = 0;
  for (const m of monthsBetween(loan.startMonth, month)) {
    const c = loan.skips?.includes(m) || (loan.closedMonth && m >= loan.closedMonth) ? 0 : Math.min(Number(loan.cut) || 0, left);
    if (m === month) cut = c;
    else left = r2(left - c);
  }
  return { cut: r2(cut), leftBefore: r2(left), leftAfter: r2(left - cut) };
}

// staff: { wageType, wage, otRate, wageHistory? }. records: that worker's attendance for the month.
// advances / payments / adjustments (bonus +, deduction −): that month's entries.
// opts: { settings, today (YYYY-MM-DD, for unmarked days), loans, previousBalance }.
export function salaryFor(staff, month, records, advances = [], payments = [], adjustments = [], opts = {}) {
  const settings = salarySettings(opts.settings);
  const { wage, wageType } = wageFor(staff, month);
  const count = Object.fromEntries(STATUS_IDS.map((s) => [s, 0]));
  const auto = { weekoff: 0, present: 0 };
  let otHours = 0;
  for (const r of records) {
    if (count[r.status] !== undefined) count[r.status] += 1;
    otHours += Number(r.otHours) || 0;
  }
  const dim = daysInMonth(month);
  // Unmarked days: weekly offs and (if the shop wants) present.
  if (opts.today && (settings.weeklyOff.length || settings.unmarked === "present")) {
    const marked = new Set(records.map((r) => r.date));
    for (let d = 1; d <= dim; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      if (marked.has(date)) continue;
      const a = autoStatus(staff, date, settings, opts.today);
      if (a) (count[a] += 1), (auto[a] += 1);
    }
  }
  const monthly = wageType !== "daily";
  const basis = settings.dayBasis === "30" ? 30 : settings.dayBasis === "26" ? 26 : dim;
  // Monthly wage: paid days include week offs and paid leave (on a 26-day basis week offs aren't paid days).
  // Daily wage: only days worked.
  const paidDays = monthly
    ? STATUS_IDS.reduce((s, k) => s + count[k] * (basis === 26 && k === "weekoff" ? 0 : ATTENDANCE[k].pay), 0)
    : count.present + count.half * 0.5;
  const perDay = monthly ? wage / basis : wage;
  // Salaries are paid in whole rupees, so paise never pile up month after month.
  const earned = Math.round(monthly && basis !== dim ? Math.min(wage, perDay * paidDays) : perDay * paidDays);
  const shiftHours = staff.shiftStart && staff.shiftEnd ? (((Date.parse(`2000-01-01T${staff.shiftEnd}`) - Date.parse(`2000-01-01T${staff.shiftStart}`)) / 36e5 + 24) % 24) || 8 : 8;
  const otRate = Number(staff.otRate) || (settings.otAuto ? perDay / shiftHours : 0);
  const overtime = Math.round(otHours * otRate);
  const advance = r2(advances.reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const paid = r2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const bonus = r2(adjustments.filter((a) => a.amount > 0).reduce((s, a) => s + a.amount, 0));
  const deduction = r2(adjustments.filter((a) => a.amount < 0).reduce((s, a) => s - a.amount, 0));
  const loans = (opts.loans || []).map((l) => ({ id: l.id, note: l.note, ...loanFor(l, month) })).filter((l) => l.cut > 0);
  const loanCut = r2(loans.reduce((s, l) => s + l.cut, 0));
  const previousBalance = Math.round(opts.previousBalance || 0) || 0;
  // This month on its own (what moves the running balance), and what's left to pay including earlier months.
  const net = Math.round(earned + overtime + bonus - deduction - loanCut - advance - paid) || 0; // whole rupees (no −0)
  return {
    month,
    wage,
    wageType,
    daysInMonth: dim,
    count,
    auto,
    marked: records.length,
    workedDays: count.present + count.half * 0.5,
    paidDays,
    perDay: r2(perDay),
    earned,
    otHours,
    otRate: r2(otRate),
    overtime,
    gross: r2(earned + overtime + bonus - deduction),
    bonus,
    deduction,
    loans,
    loanCut,
    advance,
    paid,
    net,
    previousBalance,
    payable: Math.round(previousBalance + net) || 0,
  };
}
