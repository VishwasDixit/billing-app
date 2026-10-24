import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store.jsx";
import { get, post, put, del } from "../lib/api.js";
import { fmtDate, money, todayYmd } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";

const lastDay = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

// A billing manager can add expenses and fix their own for 24 hours; salaries stay with the owner.
const canChange = (user, e) => !e.id || user.role !== "manager" || (e.addedById === user.staff?.id && Date.now() - new Date(e.createdAt) < 864e5);

export default function Expenses() {
  const { shop, user } = useApp();
  const manager = user.role === "manager";
  const cur = shop.currency || "₹";
  const [month, setMonth] = useState(todayYmd().slice(0, 7));
  const [list, setList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [editing, setEditing] = useState(null);
  const { busy, error, run } = useAction();

  const load = useCallback(
    () =>
      run(async () => {
        const r = await get(`/expenses?from=${month}-01&to=${lastDay(month)}`);
        setList(r.expenses);
        setCategories(r.categories);
      }),
    [month, run]
  );
  useEffect(() => {
    load();
  }, [load]);

  const total = list.reduce((s, e) => s + e.amount, 0);
  const byCat = Object.entries(list.reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + e.amount), m), {})).sort((a, b) => b[1] - a[1]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Expenses</h1>
        <div className="btn-row">
          <input className="input" style={{ width: 160 }} type="month" value={month} max={todayYmd().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
          <button className="btn btn-primary" onClick={() => setEditing({ date: todayYmd(), category: categories[0] || "Raw material", amount: "", note: "", paymentMode: "cash" })}>
            + Add expense
          </button>
        </div>
      </div>

      {manager && <p className="hint" style={{ marginTop: 0 }}>Expenses you add are recorded under your name. You can fix or delete your own entries for 24 hours; after that, ask the owner.</p>}
      <div className="stats">
        <div className="stat"><div className="label">Total this month</div><div className="value">{money(total, cur)}</div></div>
        {byCat.slice(0, 4).map(([c, a]) => (
          <div className="stat" key={c}><div className="label">{c}</div><div className="value">{money(a, cur)}</div></div>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr><th>Date</th><th>Category</th><th>Note</th><th>Paid by</th><th>Added by</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="click" onClick={() => setEditing(e)}>
                <td>{fmtDate(e.date + "T00:00:00+05:30")}</td>
                <td>{e.category}</td>
                <td className="muted">{e.note}</td>
                <td>{e.paymentMode?.toUpperCase()}</td>
                <td className="muted small">{e.addedBy || ""}</td>
                <td className="num">{money(e.amount, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && list.length === 0 && <div className="empty">No expenses this month. Add rent, salaries, raw material and other costs to see your real profit.</div>}
      </div>

      {editing && <ExpenseEditor expense={editing} categories={categories} locked={!canChange(user, editing)} manager={manager} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function ExpenseEditor({ expense, categories, locked, manager, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ ...expense });
  const { busy, error, run } = useAction();
  const allCats = [...new Set([...categories, f.category].filter(Boolean))];

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { date: f.date, category: f.category, amount: Number(f.amount), note: f.note || "", paymentMode: f.paymentMode };
      if (f.id) await put(`/expenses/${f.id}`, body);
      else await post("/expenses", body);
      toast(f.id ? "Expense updated" : "Expense added");
      onSaved();
      onClose();
    });
  };

  return (
    <Modal title={locked ? "Expense" : f.id ? "Edit expense" : "Add expense"} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {locked && <p className="hint" style={{ margin: 0 }}>Added by {f.addedBy || "the owner"}. Only the owner can change it now.</p>}
        <fieldset disabled={locked} className="plain-fieldset stack">
        <div className="grid2">
          <Field label="Date"><input type="date" required value={f.date} max={todayYmd()} min={manager ? todayYmd(-7) : undefined} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Amount"><input type="number" required min="0.01" step="0.01" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <Field label="Category">
          <input list="exp-cats" required maxLength={30} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <datalist id="exp-cats">{allCats.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Note (optional)"><input maxLength={120} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. 10 kg paneer" /></Field>
        <div className="field">
          Paid by
          <Seg value={f.paymentMode} onChange={(v) => setF({ ...f, paymentMode: v })} options={[["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["bank", "Bank"]]} />
        </div>
        </fieldset>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {f.id && !locked && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => confirm("Delete this expense?") && run(async () => (await del(`/expenses/${f.id}`), toast("Expense deleted"), onSaved(), onClose()))}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!locked && <button className="btn btn-primary" disabled={busy}>Save</button>}
        </div>
      </form>
    </Modal>
  );
}
