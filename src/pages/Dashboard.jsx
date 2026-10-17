import { useEffect, useState } from "react";
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";
import { useApp } from "../lib/store.jsx";
import { get } from "../lib/api.js";
import { money, monthStartYmd, todayYmd } from "../lib/format.js";
import { useAction } from "../components/ui.jsx";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

// Reference palette (categorical slots 1–2) and recessive chart ink.
const C = { sales: "#2a78d6", expenses: "#eb6834", grid: "#eceef1", axis: "#6b7280", text: "#1d2025" };

const PRESETS = [
  ["today", "Today", () => [todayYmd(), todayYmd()]],
  ["yesterday", "Yesterday", () => [todayYmd(-1), todayYmd(-1)]],
  ["7d", "7 days", () => [todayYmd(-6), todayYmd()]],
  ["30d", "30 days", () => [todayYmd(-29), todayYmd()]],
  ["month", "This month", () => [monthStartYmd(), todayYmd()]],
];

const shortDate = (ymd) => new Date(ymd + "T00:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

export default function Dashboard() {
  const { shop, sync } = useApp();
  const cur = shop.currency || "₹";
  const [preset, setPreset] = useState("7d");
  const [range, setRange] = useState(() => PRESETS[2][2]());
  const [data, setData] = useState(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    run(async () => setData(await get(`/analytics?from=${range[0]}&to=${range[1]}`)));
  }, [range, sync.pending, run]);

  const choose = (id) => {
    setPreset(id);
    setRange(PRESETS.find((p) => p[0] === id)[2]());
  };

  const axisTicks = { color: C.axis, font: { size: 11 } };
  const yMoney = { ...axisTicks, callback: (v) => cur + Number(v).toLocaleString("en-IN") };
  const tooltip = {
    backgroundColor: "#1d2025",
    padding: 10,
    callbacks: { label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y ?? ctx.parsed.x, cur)}` },
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="range-bar">
          <div className="chips">
            {PRESETS.map(([id, label]) => (
              <button key={id} className={"chip" + (preset === id ? " on" : "")} onClick={() => choose(id)}>{label}</button>
            ))}
          </div>
          <input type="date" value={range[0]} max={range[1]} onChange={(e) => (setPreset(""), setRange([e.target.value, range[1]]))} aria-label="From" />
          <input type="date" value={range[1]} min={range[0]} max={todayYmd()} onChange={(e) => (setPreset(""), setRange([range[0], e.target.value]))} aria-label="To" />
          {data && <button className="btn btn-sm" onClick={() => exportCsv(range, cur)}>Export CSV</button>}
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {!data && busy && <div className="empty">Loading…</div>}

      {data && (
        <>
          <div className="stats">
            <Stat label="Sales" value={money(data.totals.sales, cur)} delta={data.growth.sales} prev={money(data.previous.sales, cur)} />
            <Stat label="Bills" value={data.totals.bills} delta={data.growth.bills} prev={data.previous.bills} />
            <Stat label="Average bill" value={money(data.totals.avgBill, cur)} />
            <Stat label="Expenses" value={money(data.totals.expenses, cur)} delta={data.growth.expenses} prev={money(data.previous.expenses, cur)} invert />
            <Stat label="Profit" value={money(data.totals.profit, cur)} delta={data.growth.profit} prev={money(data.previous.profit, cur)} tone={data.totals.profit < 0 ? "bad" : ""} />
            <Stat label="GST collected" value={money(data.totals.gst, cur)} />
          </div>
          <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
            Changes compare with the previous {data.days.length === 1 ? "day" : `${data.days.length} days`} ({shortDate(data.range.prevFrom)} – {shortDate(data.range.prevTo)}). Profit = sales − expenses.
          </p>

          <div className="chart-grid">
            <div className="card">
              <h2>{data.days.length > 1 ? "Daily sales and expenses" : "Sales by hour"}</h2>
              <div className="chart-box">
                {data.days.length > 1 ? (
                  <Line
                    data={{
                      labels: data.days.map((d) => shortDate(d.date)),
                      datasets: [
                        { label: "Sales", data: data.days.map((d) => d.sales), borderColor: C.sales, backgroundColor: C.sales, borderWidth: 2, pointRadius: data.days.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0 },
                        { label: "Expenses", data: data.days.map((d) => d.expenses), borderColor: C.expenses, backgroundColor: C.expenses, borderWidth: 2, pointRadius: data.days.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0 },
                      ],
                    }}
                    options={{
                      maintainAspectRatio: false,
                      interaction: { mode: "index", intersect: false },
                      plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 12, boxHeight: 2, color: C.text } }, tooltip },
                      scales: { x: { grid: { display: false }, ticks: { ...axisTicks, maxTicksLimit: 10 } }, y: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: yMoney } },
                    }}
                  />
                ) : (
                  <HourBars hours={data.hours} tooltip={tooltip} axisTicks={axisTicks} yMoney={yMoney} />
                )}
              </div>
            </div>
            <div className="card">
              <h2>Payment modes</h2>
              {data.payments.length === 0 && <div className="empty">No sales yet.</div>}
              <table className="table">
                <tbody>
                  {[...data.payments].sort((a, b) => b.sales - a.sales).map((p) => (
                    <tr key={p.mode}>
                      <td>{p.mode?.toUpperCase()}</td>
                      <td className="num muted">{p.bills} bills</td>
                      <td className="num"><b>{money(p.sales, cur)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.expenseCategories.length > 0 && (
                <>
                  <h2 style={{ marginTop: 18 }}>Expenses by category</h2>
                  <table className="table">
                    <tbody>
                      {data.expenseCategories.map((e) => (
                        <tr key={e.category}><td>{e.category}</td><td className="num">{money(e.amount, cur)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>

          <div className="chart-grid">
            <div className="card">
              <h2>Top items</h2>
              {data.topItems.length === 0 ? (
                <div className="empty">No sales in this range.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Revenue</th></tr></thead>
                    <tbody>
                      {data.topItems.slice(0, 10).map((i) => (
                        <tr key={i.name}><td>{i.name}</td><td className="num">{i.qty}</td><td className="num">{money(i.revenue, cur)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="card">
              <h2>Sales by category</h2>
              {data.categories.length === 0 ? (
                <div className="empty">No sales in this range.</div>
              ) : (
                <div className="chart-box" style={{ height: Math.max(160, data.categories.length * 30 + 30) }}>
                  <Bar
                    data={{
                      labels: data.categories.map((c) => c.category),
                      datasets: [{ label: "Revenue", data: data.categories.map((c) => c.revenue), backgroundColor: C.sales, borderRadius: 4, borderSkipped: "start", maxBarThickness: 18 }],
                    }}
                    options={{
                      indexAxis: "y",
                      maintainAspectRatio: false,
                      plugins: { legend: { display: false }, tooltip },
                      scales: { x: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { ...yMoney, maxTicksLimit: 5 } }, y: { grid: { display: false }, ticks: { ...axisTicks, color: C.text } } },
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {data.days.length > 1 && (
            <div className="card">
              <h2>Busy hours</h2>
              <div className="chart-box short">
                <HourBars hours={data.hours} tooltip={tooltip} axisTicks={axisTicks} yMoney={yMoney} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HourBars({ hours, tooltip, axisTicks, yMoney }) {
  // Trim to the hours the shop is actually open.
  const used = hours.filter((h) => h.sales > 0);
  const first = used.length ? Math.max(0, used[0].hour - 1) : 8;
  const last = used.length ? Math.min(23, used[used.length - 1].hour + 1) : 22;
  const shown = hours.slice(first, last + 1);
  return (
    <Bar
      data={{
        labels: shown.map((h) => hourLabel(h.hour)),
        datasets: [{ label: "Sales", data: shown.map((h) => h.sales), backgroundColor: C.sales, borderRadius: 4, borderSkipped: "start", maxBarThickness: 28 }],
      }}
      options={{
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip },
        scales: { x: { grid: { display: false }, ticks: axisTicks }, y: { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: { ...yMoney, maxTicksLimit: 5 } } },
      }}
    />
  );
}

function Stat({ label, value, delta, prev, invert, tone }) {
  const has = delta !== undefined;
  const good = delta > 0 ? !invert : delta < 0 ? !!invert : null;
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone === "bad" ? { color: "var(--danger)" } : null}>{value}</div>
      {has && (
        <div className={"delta " + (good === true ? "up" : good === false ? "down" : "muted")} title={`Previous period: ${prev}`}>
          {delta === null ? "new" : delta === 0 ? "no change" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}%`}
          <span className="muted"> vs {prev}</span>
        </div>
      )}
    </div>
  );
}

async function exportCsv([from, to], cur) {
  const [{ bills }, { expenses }] = await Promise.all([
    get(`/bills?from=${from}&to=${to}&limit=5000`),
    get(`/expenses?from=${from}&to=${to}`),
  ]);
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Type", "Date", "Bill no / Category", "Items / Note", "Payment", "Status", `Amount (${cur})`]];
  for (const b of bills) {
    rows.push(["Bill", new Date(b.createdAt).toLocaleString("en-IN"), b.billNo, b.items.map((i) => `${i.qty}x ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join("; "), b.paymentMode, b.status, b.total]);
  }
  for (const e of expenses) rows.push(["Expense", e.date, e.category, e.note, e.paymentMode, "", -e.amount]);
  const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sales-${from}-to-${to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
