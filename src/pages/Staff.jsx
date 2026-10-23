import { useEffect, useMemo, useState } from "react";
import { get, post, put, api } from "../lib/api.js";
import { useApp } from "../lib/store.jsx";
import { money, todayYmd } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { ATTENDANCE, STATUS_IDS } from "../../shared/salary.js";
import { salarySlipPdf, monthSheetExcel } from "../lib/staffExport.js";

const ROLES = ["cook", "helper", "waiter", "cleaner", "manager", "other"];
const thisMonth = () => todayYmd().slice(0, 7);
const QUICK = ["present", "half", "absent", "leave", "weekoff"];

export default function Staff() {
  const [tab, setTab] = useState("attendance");
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState(null);
  const { error, run } = useAction();
  const load = () => run(async () => setData(await get(`/staff/attendance?month=${month}`)));
  useEffect(() => {
    load();
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <h1>Staff</h1>
        <div className="admin-tabs">
          <Seg value={tab} onChange={setTab} options={[["attendance", "Attendance"], ["salary", "Salary"], ["workers", `Workers${data ? ` (${data.staff.filter((s) => s.active).length})` : ""}`]]} />
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {!data ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {tab === "workers" && <Workers staff={data.staff} onChange={load} />}
          {tab === "attendance" && <Attendance data={data} onChange={load} onMonth={setMonth} />}
          {tab === "salary" && <Salary data={data} month={month} setMonth={setMonth} onChange={load} />}
        </>
      )}
    </div>
  );
}

function Workers({ staff, onChange }) {
  const [edit, setEdit] = useState(null);
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Give each worker a 4-digit PIN to use the kitchen phone. Wages are used for the monthly salary.
      </p>
      <button className="btn btn-primary" style={{ justifySelf: "start" }} onClick={() => setEdit({})}>+ Add worker</button>
      <div className="shop-list">
        {staff.map((w) => (
          <button key={w.id} className={"card shop-row" + (w.active ? "" : " is-off")} onClick={() => setEdit(w)}>
            <div className="shop-main">
              <div className="shop-title"><b>{w.name}</b> <span className="tag">{w.role}</span> {!w.active && <span className="tag">left</span>} {w.hasPin && <span className="tag good">PIN set</span>}</div>
              <div className="small muted">
                {w.wage ? `${money(w.wage)} ${w.wageType === "daily" ? "per day" : "per month"}` : "no wage set"}
                {w.shiftStart ? ` · ${w.shiftStart}–${w.shiftEnd || ""}` : ""}
                {w.phone ? ` · ${w.phone}` : ""}
              </div>
            </div>
          </button>
        ))}
        {staff.length === 0 && <div className="empty">No workers yet.</div>}
      </div>
      {edit && <WorkerModal worker={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), onChange())} />}
    </div>
  );
}

function WorkerModal({ worker, onClose, onSaved }) {
  const isNew = !worker.id;
  const [f, setF] = useState({
    name: worker.name || "", phone: worker.phone || "", role: worker.role || "cook", pin: "",
    wageType: worker.wageType || "monthly", wage: worker.wage ?? "", otRate: worker.otRate ?? "",
    shiftStart: worker.shiftStart || "", shiftEnd: worker.shiftEnd || "", joinedAt: worker.joinedAt || "", active: worker.active !== false,
  });
  const { busy, error, run } = useAction();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = {
        name: f.name, phone: f.phone, role: f.role, wageType: f.wageType, wage: Number(f.wage) || 0, otRate: Number(f.otRate) || 0,
        shiftStart: f.shiftStart || null, shiftEnd: f.shiftEnd || null, active: f.active, ...(f.joinedAt && { joinedAt: f.joinedAt }), ...(f.pin && { pin: f.pin }),
      };
      if (isNew) await post("/staff", body);
      else await put(`/staff/${worker.id}`, body);
      onSaved();
    });
  };
  return (
    <Modal title={isNew ? "New worker" : worker.name} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label="Name"><input required maxLength={40} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Phone"><input type="tel" maxLength={15} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
        </div>
        <div className="grid2">
          <Field label="Work"><select value={f.role} onChange={(e) => set("role", e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label={worker.hasPin ? "New PIN (optional)" : "PIN for kitchen phone"} hint="4 digits">
            <input inputMode="numeric" pattern="\d{4}" maxLength={4} value={f.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} autoComplete="off" />
          </Field>
        </div>
        <Field label="Wage">
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" type="number" min="0" inputMode="numeric" value={f.wage} onChange={(e) => set("wage", e.target.value)} />
            <Seg value={f.wageType} onChange={(v) => set("wageType", v)} options={[["monthly", "per month"], ["daily", "per day"]]} />
          </div>
        </Field>
        <div className="grid3 price-inputs">
          <Field label="Overtime ₹/hour"><input type="number" min="0" value={f.otRate} onChange={(e) => set("otRate", e.target.value)} /></Field>
          <Field label="Shift from"><input type="time" value={f.shiftStart} onChange={(e) => set("shiftStart", e.target.value)} /></Field>
          <Field label="to"><input type="time" value={f.shiftEnd} onChange={(e) => set("shiftEnd", e.target.value)} /></Field>
        </div>
        <Field label="Joined on"><input type="date" value={f.joinedAt} onChange={(e) => set("joinedAt", e.target.value)} /></Field>
        {!isNew && (
          <label className="check"><input type="checkbox" checked={!f.active} onChange={(e) => set("active", !e.target.checked)} /> Has left the job (hide from lists)</label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Attendance({ data, onChange, onMonth }) {
  const toast = useToast();
  const [date, setDate] = useState(todayYmd());
  const [ot, setOt] = useState(null); // worker for overtime/time entry
  const active = data.staff.filter((s) => s.active);
  const rec = (id) => data.records.find((r) => r.staffId === id && r.date === date);
  const mark = async (w, status, extra = {}) => {
    try {
      const r = rec(w.id);
      const keep = r ? { inTime: r.inTime || null, outTime: r.outTime || null, otHours: r.otHours || 0, note: r.note || "" } : {};
      await put("/staff/attendance", { staffId: w.id, date, status, ...keep, ...extra });
      onChange();
    } catch (err) {
      toast(err.message);
    }
  };
  const markAll = async () => {
    const todo = active.filter((w) => !rec(w.id));
    for (const w of todo) await put("/staff/attendance", { staffId: w.id, date, status: "present" });
    toast(`Marked ${todo.length} present`);
    onChange();
  };
  const changeDate = (d) => {
    setDate(d);
    if (d.slice(0, 7) !== data.month) onMonth(d.slice(0, 7));
  };
  const counts = STATUS_IDS.map((s) => [s, active.filter((w) => rec(w.id)?.status === s).length]).filter(([, n]) => n);

  return (
    <div className="stack">
      <div className="btn-row">
        <input className="input" type="date" value={date} max={todayYmd(30)} onChange={(e) => e.target.value && changeDate(e.target.value)} style={{ width: "auto" }} />
        <button className="btn btn-sm" onClick={() => changeDate(todayYmd(-1))}>Yesterday</button>
        <button className="btn btn-sm" onClick={() => changeDate(todayYmd())}>Today</button>
        {active.some((w) => !rec(w.id)) && <button className="btn btn-sm btn-primary" onClick={markAll}>✓ Mark rest present</button>}
      </div>
      {counts.length > 0 && <div className="small muted">{counts.map(([s, n]) => `${n} ${ATTENDANCE[s].label.toLowerCase()}`).join(" · ")}</div>}
      {active.length === 0 && <div className="empty">Add workers first (Workers tab).</div>}
      <div className="shop-list">
        {active.map((w) => {
          const r = rec(w.id);
          return (
            <div key={w.id} className="card att-row">
              <div className="att-name">
                <b>{w.name}</b>
                <span className="small muted">
                  {w.role}
                  {r?.inTime ? ` · ${r.inTime}–${r.outTime || ""}` : ""}
                  {r?.otHours ? ` · OT ${r.otHours} h` : ""}
                </span>
              </div>
              <div className="att-buttons">
                {QUICK.map((s) => (
                  <button key={s} className={"att-btn " + s + (r?.status === s ? " on" : "")} onClick={() => mark(w, r?.status === s ? "none" : s)} title={ATTENDANCE[s].label}>
                    {ATTENDANCE[s].short}
                  </button>
                ))}
                <button className="att-btn" onClick={() => setOt(w)} title="Time & overtime">⏱</button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ margin: 0 }}>P = Present · H = Half day · A = Absent · L = Leave (unpaid) · WO = Week off (paid for monthly wage). Tap again to clear.</p>
      <MonthGrid data={data} />
      {ot && <TimeModal worker={ot} date={date} rec={rec(ot.id)} onClose={() => setOt(null)} onSave={async (extra) => (await mark(ot, extra.status, extra), setOt(null))} />}
    </div>
  );
}

function TimeModal({ worker, date, rec, onClose, onSave }) {
  const [f, setF] = useState({ status: rec?.status || "present", inTime: rec?.inTime || worker.shiftStart || "", outTime: rec?.outTime || worker.shiftEnd || "", otHours: rec?.otHours || "", note: rec?.note || "" });
  return (
    <Modal title={`${worker.name} · ${date}`} onClose={onClose}>
      <div className="stack">
        <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUS_IDS.map((s) => <option key={s} value={s}>{ATTENDANCE[s].label}</option>)}</select>
        <div className="grid3 price-inputs">
          <Field label="In"><input type="time" value={f.inTime} onChange={(e) => setF({ ...f, inTime: e.target.value })} /></Field>
          <Field label="Out"><input type="time" value={f.outTime} onChange={(e) => setF({ ...f, outTime: e.target.value })} /></Field>
          <Field label="Overtime (h)"><input type="number" min="0" max="24" step="0.5" value={f.otHours} onChange={(e) => setF({ ...f, otHours: e.target.value })} /></Field>
        </div>
        <Field label="Note"><input maxLength={80} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave({ status: f.status, inTime: f.inTime || null, outTime: f.outTime || null, otHours: Number(f.otHours) || 0, note: f.note })}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// Whole month at a glance: one row per worker, one cell per day.
function MonthGrid({ data }) {
  const dim = new Date(Number(data.month.slice(0, 4)), Number(data.month.slice(5)), 0).getDate();
  const active = data.staff.filter((s) => s.active);
  if (!active.length) return null;
  return (
    <div className="card table-wrap" style={{ padding: 0 }}>
      <table className="table month-grid">
        <thead>
          <tr><th>{new Date(data.month + "-01T12:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</th>{Array.from({ length: dim }, (_, i) => <th key={i}>{i + 1}</th>)}</tr>
        </thead>
        <tbody>
          {active.map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              {Array.from({ length: dim }, (_, i) => {
                const r = data.records.find((x) => x.staffId === w.id && Number(x.date.slice(8)) === i + 1);
                return <td key={i} className={"mg " + (r?.status || "")}>{r ? ATTENDANCE[r.status]?.short : ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Salary({ data, month, setMonth, onChange }) {
  const { shop } = useApp();
  const toast = useToast();
  const [adv, setAdv] = useState(null);
  const [pay, setPay] = useState(null);
  const { busy, run } = useAction();
  const workers = useMemo(() => data.staff.filter((s) => s.active || data.salary[s.id]?.marked), [data]);
  const total = workers.reduce((s, w) => s + Math.max(0, data.salary[w.id]?.payable || 0), 0);
  return (
    <div className="stack">
      <div className="btn-row">
        <input className="input" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: "auto" }} />
        <button className="btn btn-sm" disabled={busy || !workers.length} onClick={() => run(() => monthSheetExcel(shop, month, workers, data.records, data.salary))}>📊 Month sheet (Excel)</button>
      </div>
      <div className="small">Total still to pay: <b>{money(total)}</b></div>
      {workers.length === 0 && <div className="empty">No workers yet.</div>}
      <div className="shop-list">
        {workers.map((w) => {
          const s = data.salary[w.id];
          const advances = data.advances.filter((a) => a.staffId === w.id);
          return (
            <div key={w.id} className="card stack salary-card">
              <div className="shop-title"><b>{w.name}</b> <span className="tag">{w.role}</span> <span className="small muted">{money(w.wage)} {w.wageType === "daily" ? "/day" : "/month"}</span></div>
              <div className="salary-grid small">
                <span>Paid days</span><b>{s.paidDays} / {s.daysInMonth}</b>
                <span>Earned</span><b>{money(s.earned)}</b>
                {s.overtime > 0 && (<><span>Overtime ({s.otHours} h)</span><b>+ {money(s.overtime)}</b></>)}
                {s.advance > 0 && (<><span>Advances</span><b>− {money(s.advance)}</b></>)}
                {s.paid > 0 && (<><span>Paid</span><b>− {money(s.paid)}</b></>)}
                <span><b>Payable</b></span><b className={s.payable > 0 ? "" : "muted"}>{money(s.payable)}</b>
              </div>
              {s.marked < new Date().getDate() && month === thisMonth() && <div className="hint">Attendance marked for {s.marked} days so far.</div>}
              {advances.length > 0 && (
                <div className="small muted">
                  Advances: {advances.map((a) => (
                    <span key={a.id} className="adv-chip">
                      {money(a.amount)} on {a.date.slice(8)}/{a.date.slice(5, 7)}{a.note ? ` (${a.note})` : ""}
                      <button className="link-btn" onClick={() => confirm("Remove this advance?") && api(`/staff/advances/${a.id}`, { method: "DELETE" }).then(onChange)} aria-label="Remove advance">✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => setAdv(w)}>+ Advance</button>
                {s.payable > 0 && <button className="btn btn-sm btn-primary" onClick={() => setPay({ w, amount: s.payable })}>Pay {money(s.payable)}</button>}
                <button className="btn btn-sm btn-ghost" onClick={() => run(() => salarySlipPdf(shop, w, s, data.records.filter((r) => r.staffId === w.id)))}>📄 Slip</button>
              </div>
            </div>
          );
        })}
      </div>
      {adv && (
        <MoneyModal
          title={`Advance to ${adv.name}`}
          onClose={() => setAdv(null)}
          onSave={async ({ amount, date, note, mode }) => {
            await post(`/staff/${adv.id}/advances`, { amount, date, note, mode });
            toast("Advance saved");
            setAdv(null);
            onChange();
          }}
        />
      )}
      {pay && (
        <MoneyModal
          title={`Pay ${pay.w.name} · ${month}`}
          amount={pay.amount}
          withExpense
          onClose={() => setPay(null)}
          onSave={async ({ amount, date, mode, addExpense }) => {
            await post(`/staff/${pay.w.id}/salary-paid`, { month, amount, date, mode, addExpense });
            toast("Salary payment saved");
            setPay(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function MoneyModal({ title, amount = "", withExpense, onClose, onSave }) {
  const [f, setF] = useState({ amount, date: todayYmd(), note: "", mode: "cash", addExpense: true });
  const { busy, error, run } = useAction();
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), run(() => onSave({ ...f, amount: Number(f.amount) })))}>
        <div className="grid2">
          <Field label="Amount (₹)"><input type="number" min="1" required inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></Field>
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        </div>
        <Seg value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank"]]} />
        {!withExpense && <Field label="Note"><input maxLength={80} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. medicine, festival" /></Field>}
        {withExpense && <label className="check"><input type="checkbox" checked={f.addExpense} onChange={(e) => setF({ ...f, addExpense: e.target.checked })} /> Add to Expenses (Salary) so profit includes it</label>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
