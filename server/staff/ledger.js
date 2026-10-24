// Payroll across months: each worker's running balance (unpaid salary carried forward, extra
// advances taken back), loans repaid in instalments, and the months the owner has closed.
import { salaryFor, salarySettings, monthsBetween, addMonths } from "../../shared/salary.js";

const WINDOW = 36; // months of history looked at
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthOf = (d) => (d ? String(d).slice(0, 7) : null);
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const clean = ({ _id, shopId, ...x }) => ({ ...x, id: String(_id) });

// Everything needed to work out salaries up to `upto` (YYYY-MM), loaded once for all workers.
export async function payrollData(db, shop, upto) {
  const from = addMonths(upto, -(WINDOW - 1));
  const fromDay = `${from}-01`;
  const toDay = `${upto}-31`;
  const q = (c, filter, sort = {}) => db.collection(c).find({ shopId: shop._id, ...filter }).sort(sort).toArray();
  const [staff, records, advances, payments, adjustments, loans, closed] = await Promise.all([
    q("staff", {}, { active: -1, name: 1 }),
    q("attendance", { date: { $gte: fromDay, $lte: toDay } }),
    q("staffAdvances", { date: { $gte: fromDay, $lte: toDay } }, { date: 1 }),
    q("salaryPayments", { month: { $gte: from, $lte: upto } }, { date: 1 }),
    q("salaryAdjustments", { month: { $gte: from, $lte: upto } }, { createdAt: 1 }),
    q("staffLoans", {}, { createdAt: 1 }),
    q("salaryMonths", {}),
  ]);
  return {
    from,
    upto,
    settings: salarySettings(shop.salarySettings),
    staff,
    records: records.map(clean),
    advances: advances.map(clean),
    payments: payments.map(clean),
    adjustments: adjustments.map(clean),
    loans: loans.map(clean),
    closed: closed.map(clean),
  };
}

// Month-by-month for one worker, oldest first: that month's salary and the balance carried in and out.
export function workerLedger(worker, data, upto, today = todayIst()) {
  const id = String(worker._id);
  const mine = (list) => list.filter((x) => x.staffId === id);
  const recs = mine(data.records);
  const adv = mine(data.advances);
  const pay = mine(data.payments);
  const adj = mine(data.adjustments);
  const loans = mine(data.loans);
  const opening = worker.openingBalance?.month ? worker.openingBalance : null;
  // Start: the opening balance month, else the first month with anything for this worker.
  const firsts = [
    monthOf(worker.joinedAt),
    ...recs.map((r) => monthOf(r.date)),
    ...adv.map((a) => monthOf(a.date)),
    ...pay.map((p) => p.month),
    ...adj.map((a) => a.month),
    ...loans.map((l) => l.startMonth),
  ].filter((m) => m && m >= data.from && m <= upto);
  let start = opening ? opening.month : firsts.sort()[0] || upto;
  if (start < data.from) start = data.from;
  let balance = opening && opening.month >= data.from ? r2(opening.amount) : 0;
  const rows = [];
  for (const month of monthsBetween(start, upto)) {
    const inMonth = (d) => String(d).startsWith(month);
    const s = salaryFor(
      worker,
      month,
      recs.filter((r) => inMonth(r.date)),
      adv.filter((a) => inMonth(a.date)),
      pay.filter((p) => p.month === month),
      adj.filter((a) => a.month === month),
      { settings: data.settings, today, loans, previousBalance: balance }
    );
    rows.push(s);
    balance = s.payable;
  }
  return rows;
}

// Loan status for the list: how much is repaid and left as of `month`.
export function loanStatus(loan, month) {
  const months = monthsBetween(loan.startMonth, month < loan.startMonth ? loan.startMonth : month);
  let left = Number(loan.amount) || 0;
  for (const m of months) {
    if (m > month) break;
    if (loan.skips?.includes(m) || (loan.closedMonth && m >= loan.closedMonth)) continue;
    left = r2(left - Math.min(Number(loan.cut) || 0, left));
  }
  return { ...loan, repaid: r2((Number(loan.amount) || 0) - left), left, done: left <= 0 || !!loan.closedMonth };
}

export const isClosed = (data, month) => data.closed.some((c) => c.month === month);
