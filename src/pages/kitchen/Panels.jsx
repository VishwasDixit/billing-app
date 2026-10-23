import { useEffect, useState } from "react";
import { get, post } from "../../lib/api.js";
import { useApp } from "../../lib/store.jsx";
import { money, todayYmd, fmtDateTime } from "../../lib/format.js";
import { useAction, useToast } from "../../components/ui.jsx";
import { EntryModal } from "./Stock.jsx";
import { shoppingPdf, shoppingExcel, shoppingText, reportPdf, reportExcel } from "../../lib/kitchenExport.js";

const ICON = { out: "🔴", low: "🟠", expiring: "⏳", expired: "⛔", waste: "🗑️", variance: "🔍" };
const LEVEL = { high: "bad", warn: "warn", info: "" };

export function Alerts({ onCount }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState("");
  const load = () =>
    get("/kitchen/alerts").then(
      (r) => (setList(r.alerts), onCount?.(r.alerts.filter((a) => a.level !== "info").length)),
      (e) => setError(e.message)
    );
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ingFor = async (id) => (await get("/kitchen/ingredients")).ingredients.find((i) => i.id === id);
  const act = async (a, type) => {
    const ing = await ingFor(a.ingredientId);
    if (!ing) return toast("This item was removed.");
    setEntry({ ing, type, batchId: type === "expired" ? a.batchId : undefined });
  };
  const dismiss = async (a) => {
    await post(`/kitchen/alerts/${a.id}/dismiss`);
    load();
  };

  if (error) return <div className="error">{error}</div>;
  if (!list) return <div className="empty">Loading…</div>;
  return (
    <div className="stack">
      {list.length === 0 && <div className="empty">✅ All good. No kitchen alerts right now.</div>}
      {list.map((a) => (
        <div key={a.id} className={"card alert-card " + (LEVEL[a.level] || "")}>
          <div className="alert-msg">
            <span className="alert-ico" aria-hidden="true">{ICON[a.type] || "•"}</span>
            <span>{a.message}</span>
          </div>
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <span className="small muted" style={{ marginRight: "auto" }}>{fmtDateTime(a.updatedAt)}</span>
            {(a.type === "low" || a.type === "out") && <button className="btn btn-sm btn-primary" onClick={() => act(a, "purchase")}>+ Received</button>}
            {(a.type === "expired" || a.type === "expiring") && a.batchId && <button className="btn btn-sm" onClick={() => act(a, "expired")}>Mark expired</button>}
            <button className="btn btn-sm btn-ghost" onClick={() => dismiss(a)}>{a.type === "waste" || a.type === "variance" ? "Seen" : "Dismiss"}</button>
          </div>
        </div>
      ))}
      {entry && <EntryModal {...entry} onClose={() => setEntry(null)} onSaved={() => (setEntry(null), toast("Saved"), load())} />}
    </div>
  );
}

export function Shopping() {
  const { shop } = useApp();
  const toast = useToast();
  const [days, setDays] = useState(3);
  const [list, setList] = useState(null);
  const [entry, setEntry] = useState(null);
  const { busy, error, run } = useAction();
  const load = () => run(async () => setList(await get(`/kitchen/shopping-list?days=${days}`)));
  useEffect(() => {
    load();
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = (list?.items || []).reduce((m, i) => (m[i.category] = [...(m[i.category] || []), i], m), {});
  const bought = async (i) => {
    const ing = (await get("/kitchen/ingredients")).ingredients.find((x) => x.id === i.ingredientId);
    if (ing) setEntry({ ing, type: "purchase" });
  };
  return (
    <div className="stack">
      <div className="btn-row">
        <span className="small">Buy enough for</span>
        <div className="chips">{[1, 2, 3, 7].map((d) => <button key={d} className={"chip" + (days === d ? " on" : "")} onClick={() => setDays(d)}>{d} day{d > 1 ? "s" : ""}</button>)}</div>
      </div>
      {error && <div className="error">{error}</div>}
      {list && list.items.length === 0 && <div className="empty">🎉 Nothing to buy. Everything lasts more than {days} day{days > 1 ? "s" : ""}. (Items appear here once you've counted or received them.)</div>}
      {list && list.items.length > 0 && (
        <>
          <div className="btn-row">
            <button className="btn btn-sm" disabled={busy} onClick={() => run(() => shoppingPdf(shop, list))}>📄 PDF</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => run(() => shoppingExcel(shop, list))}>📊 Excel</button>
            <a className="btn btn-sm" href={`https://wa.me/?text=${encodeURIComponent(shoppingText(shop, list))}`} target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>
            {list.total > 0 && <span className="small muted">Approx. {money(list.total, shop.currency || "₹")}</span>}
          </div>
          {Object.entries(groups).map(([c, items]) => (
            <section key={c} className="card" style={{ padding: 0 }}>
              <h2 style={{ padding: "12px 14px 4px", fontSize: 16 }}>{c}</h2>
              {items.map((i) => (
                <div key={i.ingredientId} className="ing-row">
                  <div className="ing-main" style={{ cursor: "default" }}>
                    <b>{i.name} {i.urgent && <span className="tag bad">urgent</span>}</b>
                    <span className="small">Buy <b>{i.qty} {i.unit}</b> · left {i.stock} {i.unit}{i.daysLeft != null ? ` (~${i.daysLeft} days)` : ""}</span>
                  </div>
                  <button className="btn btn-sm" onClick={() => bought(i)}>✓ Bought</button>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
      {entry && <EntryModal {...entry} onClose={() => setEntry(null)} onSaved={() => (setEntry(null), toast("Added to stock"), load())} />}
    </div>
  );
}

export function Report() {
  const { shop } = useApp();
  const cur = shop.currency || "₹";
  const [range, setRange] = useState([todayYmd(-6), todayYmd()]);
  const [r, setR] = useState(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(async () => setR(await get(`/kitchen/report?from=${range[0]}&to=${range[1]}`)));
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
  const presets = [["Today", [todayYmd(), todayYmd()]], ["7 days", [todayYmd(-6), todayYmd()]], ["30 days", [todayYmd(-29), todayYmd()]]];
  return (
    <div className="stack">
      <div className="chips">
        {presets.map(([l, rg]) => <button key={l} className={"chip" + (range[0] === rg[0] && range[1] === rg[1] ? " on" : "")} onClick={() => setRange(rg)}>{l}</button>)}
      </div>
      {error && <div className="error">{error}</div>}
      {r && (
        <>
          <div className="stats">
            <div className="stat"><div className="label">Sales</div><div className="value">{money(r.totals.sales, cur)}</div></div>
            <div className="stat"><div className="label">Ingredients used</div><div className="value">{money(r.totals.usedCost, cur)}</div></div>
            <div className="stat"><div className="label">Food cost</div><div className="value">{r.totals.foodCostPct == null ? "—" : `${r.totals.foodCostPct}%`}</div></div>
            <div className="stat"><div className="label">Wasted / expired</div><div className="value" style={{ color: r.totals.wasteCost ? "var(--danger)" : undefined }}>{money(r.totals.wasteCost, cur)}</div></div>
            <div className="stat"><div className="label">Missing in counts</div><div className="value">{money(r.totals.missingCost, cur)}</div></div>
          </div>
          <p className="hint" style={{ margin: 0 }}>Food cost = ingredients used + wasted, as % of sales. Most dhabas aim for 30–35%.</p>
          <div className="btn-row">
            <button className="btn btn-sm" disabled={busy} onClick={() => run(() => reportPdf(shop, r))}>📄 PDF</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => run(() => reportExcel(shop, r))}>📊 Excel</button>
          </div>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Used</th><th className="num">₹</th><th className="num">Wasted</th><th className="num">Missing</th></tr></thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.name}>
                    <td>{x.name}</td>
                    <td className="num">{x.used ? `${x.used} ${x.unit}` : ""}</td>
                    <td className="num">{x.usedCost ? money(x.usedCost, cur) : ""}</td>
                    <td className="num" style={{ color: x.wasted ? "var(--danger)" : undefined }}>{x.wasted ? `${x.wasted} ${x.unit}` : ""}</td>
                    <td className="num">{x.missing ? `${x.missing} ${x.unit}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.rows.length === 0 && <div className="empty">No kitchen activity in these days.</div>}
          </div>
          {r.waste.length > 0 && (
            <div className="card stack">
              <h2 style={{ fontSize: 16 }}>Waste</h2>
              {r.waste.map((w, i) => (
                <div key={i} className="small">🗑️ {w.qty} {w.unit} {w.name} · {w.reason} · {money(w.cost, cur)} · {w.by} · <span className="muted">{fmtDateTime(w.at)}</span></div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
