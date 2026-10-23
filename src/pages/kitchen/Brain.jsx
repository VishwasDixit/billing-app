import { useEffect, useState } from "react";
import { get, post } from "../../lib/api.js";
import { fmtDateTime } from "../../lib/format.js";
import { useAction, useToast } from "../../components/ui.jsx";
import { fmtQty } from "./common.jsx";

const CONFIDENCE = {
  learning: ["Still learning", "It needs about 2 weeks of bills to learn your busy days. Until then it uses the recent average."],
  fair: ["Getting better", "It has learned your weekdays; it gets sharper every day."],
  good: ["Knows your kitchen", "Based on your last weeks of bills and stock entries."],
};

// Kitchen Brain: our own learning engine's findings for this kitchen.
export default function Brain({ owner }) {
  const toast = useToast();
  const [b, setB] = useState(null);
  const { busy, error, run } = useAction();
  const load = (fresh) => run(async () => setB(await get(`/kitchen/brain${fresh ? "?fresh=1" : ""}`)));
  useEffect(() => {
    load(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const answer = async (s, action) => {
    try {
      const r = await post(`/kitchen/brain/suggestions/${s.id}/${action}`);
      toast(action === "apply" ? `Updated ${r.recipes} recipe${r.recipes === 1 ? "" : "s"}` : "Ignored");
      load(false);
    } catch (err) {
      toast(err.message);
    }
  };

  if (!b) return error ? <div className="error">{error}</div> : <div className="empty">🧠 Learning from your kitchen…</div>;
  const [conf, confText] = CONFIDENCE[b.confidence] || CONFIDENCE.learning;
  const maxPlates = Math.max(1, ...b.week.map((d) => d.plates));
  const short = b.prep.filter((p) => p.short > 0);
  return (
    <div className="stack">
      <div className="card brain-head">
        <div>
          <b>🧠 Kitchen Brain</b> <span className={"tag " + (b.confidence === "good" ? "good" : b.confidence === "fair" ? "" : "warn")}>{conf}</span>
          <div className="small muted">{confText} {b.salesDays ? `${b.salesDays} days of sales learned.` : ""} Updated {fmtDateTime(b.learnedAt)}.</div>
        </div>
        {owner && <button className="btn btn-sm" disabled={busy} onClick={() => load(true)}>{busy ? "Learning…" : "↻ Learn now"}</button>}
      </div>

      {owner && b.suggestions.length > 0 && (
        <section className="card stack">
          <h2 style={{ fontSize: 16 }}>Recipe fixes to check</h2>
          {b.suggestions.map((s) => (
            <div key={s.id} className="brain-sugg">
              <p className="small" style={{ margin: 0 }}>🔧 {s.message}</p>
              <div className="btn-row">
                <button className="btn btn-sm btn-primary" onClick={() => answer(s, "apply")}>Update recipes</button>
                <button className="btn btn-sm btn-ghost" onClick={() => answer(s, "dismiss")}>Ignore</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {owner && b.insights.length > 0 && (
        <section className="card stack">
          <h2 style={{ fontSize: 16 }}>This week's findings</h2>
          {b.insights.map((i, k) => (
            <div key={k} className={"brain-insight " + (i.level || "")}>
              <span aria-hidden="true">{i.icon}</span>
              <span className="small">{i.text}</span>
            </div>
          ))}
        </section>
      )}

      <section className="card stack">
        <h2 style={{ fontSize: 16 }}>
          {b.tomorrow.weekday} (tomorrow): ~{b.tomorrow.plates} plates
        </h2>
        {b.tomorrow.dishes.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>No forecast yet. It starts once dishes have a few days of bills.</p>
        ) : (
          <div className="brain-dishes">
            {b.tomorrow.dishes.slice(0, 12).map((d) => (
              <div key={d.itemId + d.variant} className="small">
                <b>{d.qty}</b> × {d.name}{d.variant ? ` (${d.variant})` : ""}
              </div>
            ))}
          </div>
        )}
        <div className="brain-week" aria-label="Expected plates next 7 days">
          {b.week.map((d) => (
            <div key={d.date} className="brain-day" title={`${d.weekday}: ~${d.plates} plates`}>
              <div className="brain-bar" style={{ height: `${Math.max(4, (d.plates / maxPlates) * 60)}px` }} />
              <span className="small">{d.weekday.slice(0, 3)}</span>
              <span className="small muted">{d.plates}</span>
            </div>
          ))}
        </div>
      </section>

      {b.prep.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <h2 style={{ fontSize: 16, padding: "12px 14px 4px" }}>Prep for tomorrow{short.length ? ` · ${short.length} short` : ""}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Need</th><th className="num">In stock</th></tr></thead>
              <tbody>
                {b.prep.map((p) => (
                  <tr key={p.ingredientId}>
                    <td>{p.name} {p.short > 0 && <span className="tag bad">{fmtQty(p.short, p.unit)} short</span>}</td>
                    <td className="num">{fmtQty(p.need, p.unit)}</td>
                    <td className="num">{p.short == null ? <span className="muted">not counted</span> : fmtQty(p.stock, p.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {b.specials.length > 0 && (
        <section className="card stack">
          <h2 style={{ fontSize: 16 }}>⭐ Use first (expiring soon)</h2>
          {b.specials.map((s) => (
            <div key={s.ingredientId} className="small">
              <b>{fmtQty(s.qty, s.unit)} {s.name}</b> · {s.inDays === 0 ? "today" : s.inDays === 1 ? "tomorrow" : `in ${s.inDays} days`}
              {s.dishes.length > 0 && <> → {s.dishes.map((d) => `${d.name} (~${d.plates} plates)`).join(", ")}</>}
            </div>
          ))}
        </section>
      )}

      {b.reorder.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <h2 style={{ fontSize: 16, padding: "12px 14px 4px" }}>Learned reorder levels</h2>
          <p className="hint" style={{ margin: "0 14px 6px" }}>Order again when stock falls to this level: daily use × supplier delay, plus a margin for busy days.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Per day</th><th className="num">Days</th><th className="num">Reorder at</th></tr></thead>
              <tbody>
                {b.reorder.map((r) => (
                  <tr key={r.ingredientId}>
                    <td>{r.name}</td>
                    <td className="num">{fmtQty(r.perDay, r.unit)}</td>
                    <td className="num" style={{ color: r.daysLeft != null && r.daysLeft < 2 ? "var(--danger)" : undefined }}>{r.daysLeft ?? "—"}</td>
                    <td className="num">
                      {r.reorderAt ? fmtQty(r.reorderAt, r.unit) : <span className="muted">learning</span>}
                      {r.reorderAt && r.leadDays !== 1 && <div className="small muted">{r.leadDays < 1 ? `${Math.round(r.leadDays * 24)} h` : `${r.leadDays} days`} delay</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
