import { z } from "zod";
import { round2 } from "../../shared/totals.js";
import { HttpError } from "../http.js";
import { totalOutstanding } from "./customers.js";
import { hasPaidFeatures } from "../subscription.js";

// Shops are in India: days and hours are counted in IST.
export const TZ = "Asia/Kolkata";
const DAY = 24 * 60 * 60 * 1000;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const istMidnight = (d) => new Date(`${d}T00:00:00+05:30`);
const toYmd = (date) => new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Inclusive YYYY-MM-DD range -> [start, end) instants.
export function dayRange(from, to) {
  const today = toYmd(new Date());
  const f = ymd.parse(from || to || today);
  const t = ymd.parse(to || from || today);
  const start = istMidnight(f);
  const end = new Date(istMidnight(t).getTime() + DAY);
  if (end <= start) throw new HttpError(400, "The end date must be on or after the start date.");
  if (end - start > 400 * DAY) throw new HttpError(400, "Please pick a range of 400 days or less.");
  return { start, end, from: f, to: t };
}

async function salesSummary(db, shopId, start, end) {
  const [r] = await db
    .collection("bills")
    .aggregate([
      { $match: { shopId, status: "paid", createdAt: { $gte: start, $lt: end } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                sales: { $sum: "$total" },
                bills: { $sum: 1 },
                items: { $sum: "$itemCount" },
                gst: { $sum: "$gst.amount" },
                discount: { $sum: "$discount.amount" },
              },
            },
          ],
          daily: [
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } }, sales: { $sum: "$total" }, bills: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          hourly: [{ $group: { _id: { $hour: { date: "$createdAt", timezone: TZ } }, sales: { $sum: "$total" }, bills: { $sum: 1 } } }],
          payments: [{ $group: { _id: "$paymentMode", sales: { $sum: "$total" }, bills: { $sum: 1 } } }],
          categories: [
            { $unwind: "$items" },
            { $group: { _id: { $ifNull: ["$items.category", ""] }, revenue: { $sum: "$items.amount" }, qty: { $sum: "$items.qty" } } },
            { $sort: { revenue: -1 } },
          ],
          topItems: [
            { $unwind: "$items" },
            {
              $group: {
                _id: { name: "$items.name", variant: "$items.variant" },
                qty: { $sum: "$items.qty" },
                revenue: { $sum: "$items.amount" },
              },
            },
            { $sort: { revenue: -1 } },
            { $limit: 30 },
          ],
        },
      },
    ])
    .toArray();
  return r;
}

async function expenseSummary(db, shopId, from, to) {
  const [r] = await db
    .collection("expenses")
    .aggregate([
      { $match: { shopId, date: { $gte: from, $lte: to } } },
      {
        $facet: {
          total: [{ $group: { _id: null, amount: { $sum: "$amount" } } }],
          daily: [{ $group: { _id: "$date", amount: { $sum: "$amount" } } }],
          categories: [{ $group: { _id: "$category", amount: { $sum: "$amount" } } }, { $sort: { amount: -1 } }],
        },
      },
    ])
    .toArray();
  return r;
}

const growth = (now, before) => (before > 0 ? round2(((now - before) / before) * 100) : now > 0 ? null : 0);

export default [
  [
    "GET",
    "/analytics",
    async ({ db, shop, query, status }) => {
      if (!hasPaidFeatures(status)) {
        throw new HttpError(402, "The sales dashboard and reports are part of the paid plan.", { code: "PAID_FEATURE" });
      }
      const { start, end, from, to } = dayRange(query.from, query.to);
      const len = end - start;
      const prevStart = new Date(start.getTime() - len);
      const prevFrom = toYmd(prevStart);
      const prevTo = toYmd(new Date(start.getTime() - DAY));

      const [cur, prev, exp, prevExp, given, collected, outstanding] = await Promise.all([
        salesSummary(db, shop._id, start, end),
        salesSummary(db, shop._id, prevStart, start),
        expenseSummary(db, shop._id, from, to),
        expenseSummary(db, shop._id, prevFrom, prevTo),
        db.collection("bills").aggregate([{ $match: { shopId: shop._id, paymentMode: "credit", status: "paid", createdAt: { $gte: start, $lt: end } } }, { $group: { _id: null, v: { $sum: "$creditAmount" } } }]).toArray(),
        db.collection("customerPayments").aggregate([{ $match: { shopId: shop._id, createdAt: { $gte: start, $lt: end } } }, { $group: { _id: null, v: { $sum: "$amount" } } }]).toArray(),
        totalOutstanding(db, shop._id),
      ]);

      const t = cur.totals[0] || { sales: 0, bills: 0, items: 0, gst: 0, discount: 0 };
      const pt = prev.totals[0] || { sales: 0, bills: 0 };
      const expenses = exp.total[0]?.amount || 0;
      const prevExpenses = prevExp.total[0]?.amount || 0;
      const profit = round2(t.sales - expenses);
      const prevProfit = round2(pt.sales - prevExpenses);

      // One row per day in range, so charts show zero days too.
      const salesByDay = Object.fromEntries(cur.daily.map((d) => [d._id, d]));
      const expByDay = Object.fromEntries(exp.daily.map((d) => [d._id, d.amount]));
      const days = [];
      for (let ts = start.getTime(); ts < end.getTime(); ts += DAY) {
        const d = toYmd(new Date(ts));
        const sales = round2(salesByDay[d]?.sales || 0);
        const expense = round2(expByDay[d] || 0);
        days.push({ date: d, sales, bills: salesByDay[d]?.bills || 0, expenses: expense, profit: round2(sales - expense) });
      }

      const hours = Array.from({ length: 24 }, (_, h) => {
        const row = cur.hourly.find((x) => x._id === h);
        return { hour: h, sales: round2(row?.sales || 0), bills: row?.bills || 0 };
      });

      return {
        range: { from, to, prevFrom, prevTo },
        totals: {
          sales: round2(t.sales),
          bills: t.bills,
          items: t.items,
          avgBill: t.bills ? round2(t.sales / t.bills) : 0,
          gst: round2(t.gst),
          discount: round2(t.discount),
          expenses: round2(expenses),
          profit,
        },
        previous: { sales: round2(pt.sales), bills: pt.bills, expenses: round2(prevExpenses), profit: prevProfit },
        growth: {
          sales: growth(t.sales, pt.sales),
          bills: growth(t.bills, pt.bills),
          expenses: growth(expenses, prevExpenses),
          profit: prevProfit !== 0 ? round2(((profit - prevProfit) / Math.abs(prevProfit)) * 100) : profit !== 0 ? null : 0,
        },
        days,
        hours,
        payments: cur.payments.map((p) => ({ mode: p._id, sales: round2(p.sales), bills: p.bills })),
        categories: cur.categories.map((c) => ({ category: c._id || "Other", revenue: round2(c.revenue), qty: c.qty })),
        topItems: cur.topItems.map((i) => ({
          name: i._id.variant ? `${i._id.name} (${i._id.variant})` : i._id.name,
          qty: i.qty,
          revenue: round2(i.revenue),
        })),
        credit: { given: round2(given[0]?.v || 0), collected: round2(collected[0]?.v || 0), outstanding },
        expenseCategories: exp.categories.map((c) => ({ category: c._id, amount: round2(c.amount) })),
      };
    },
  ],
];
