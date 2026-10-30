// Pick tables in runs ("Table 1 – Table 10"): used for table groups, promo codes and dishes.
import { useState } from "react";

// Chosen tables as chips ("Table 5 – Table 9 ✕") and a from–to picker to add more.
export function TableRangePicker({ tables, ids, onChange, hint }) {
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.min(9, Math.max(0, tables.length - 1)));
  const addRange = () => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    onChange([...new Set([...ids, ...tables.slice(a, b + 1).map((t) => t.id)])]);
  };
  return (
    <>
      {ids.length > 0 && (
        <div className="chips">
          {tableRuns(ids, tables).map(([a, b, run]) => (
            <span key={a.id} className="chip on">
              {a === b ? a.name : `${a.name} – ${b.name}`}{" "}
              <button type="button" className="chip-x" aria-label="Remove these tables" onClick={() => onChange(ids.filter((id) => !run.includes(id)))}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div className="inline range-add">
        <select value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="From table">
          {tables.map((t, i) => <option key={t.id} value={i}>{t.name}</option>)}
        </select>
        <span className="muted">to</span>
        <select value={to} onChange={(e) => setTo(Number(e.target.value))} aria-label="To table">
          {tables.map((t, i) => <option key={t.id} value={i}>{t.name}</option>)}
        </select>
        <button type="button" className="btn btn-sm" onClick={addRange}>+ Add</button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </>
  );
}

// Chosen table ids as runs in the shop's order: [firstTable, lastTable, ids].
export function tableRuns(ids, tables) {
  const want = new Set(ids);
  const runs = [];
  let run = null;
  for (const t of tables) {
    if (want.has(t.id)) {
      if (run) (run[1] = t), run[2].push(t.id);
      else runs.push((run = [t, t, [t.id]]));
    } else run = null;
  }
  return runs;
}
