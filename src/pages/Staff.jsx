import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, put, api } from "../lib/api.js";
import { useApp } from "../lib/store.jsx";
import { money, todayYmd } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { ATTENDANCE, STATUS_IDS } from "../../shared/salary.js";
import { salarySlipPdf, monthSheetExcel } from "../lib/staffExport.js";

const ROLES = ["cook", "helper", "waiter", "cleaner", "manager", "other"];
const ACCESS = [["none", "No app"], ["kitchen", "Kitchen (cook)"], ["manager", "Billing manager"]];
const ACCESS_TAG = { kitchen: "🍳 kitchen login", manager: "🧾 billing login" };
const defaultAccess = (role) => (role === "manager" || role === "waiter" ? "manager" : role === "cook" || role === "helper" ? "kitchen" : "none");
const thisMonth = () => todayYmd().slice(0, 7);

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
          {tab !== "workers" && <MonthBar month={month} setMonth={setMonth} />}
          {tab === "attendance" && <Attendance data={data} onChange={load} />}
          {tab === "salary" && <Salary data={data} month={month} onChange={load} />}
        </>
      )}
    </div>
  );
}

function Workers({ staff, onChange }) {
  const [edit, setEdit] = useState(null);
  return (
    <div className="stack">
      <StaffCodeCard />
      <p className="small muted" style={{ margin: 0 }}>
        Give each worker a 4-digit PIN and choose their <b>App access</b>: cooks see only kitchen screens; a billing manager runs billing and the kitchen but never sees profit, reports, salaries or settings. Wages are used for the monthly salary.
      </p>
      <button className="btn btn-primary" style={{ justifySelf: "start" }} onClick={() => setEdit({})}>+ Add worker</button>
      <div className="shop-list">
        {staff.map((w) => (
          <button key={w.id} className={"card shop-row" + (w.active ? "" : " is-off")} onClick={() => setEdit(w)}>
            <div className="shop-main">
              <div className="shop-title"><b>{w.name}</b> <span className="tag">{w.role}</span> {!w.active && <span className="tag">left</span>} {w.hasPin && <span className="tag good">PIN set</span>} {ACCESS_TAG[w.access] && <span className="tag">{ACCESS_TAG[w.access]}</span>}</div>
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

// The shop's staff code: workers type it once on their phone (Login › Staff login).
function StaffCodeCard() {
  const { shop } = useApp();
  const toast = useToast();
  const [code, setCode] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(async () => setCode((await get("/staff/code")).code));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = `${location.origin}/staff-login`;
  const text = `${shop.name} staff login\nOpen ${link}\nStaff code: ${code}\nThen tap your name and enter your 4-digit PIN.`;
  const renew = () =>
    confirm("Make a new staff code? Every staff phone will be signed out and will need the new code.") &&
    run(async () => {
      setCode((await post("/staff/code")).code);
      toast("New code made. All staff phones are signed out.");
    });
  return (
    <div className="card staff-code-card">
      <div>
        <div className="small muted">Staff code (for cooks and counter staff to sign in)</div>
        <div className="staff-code">{code || "······"}</div>
        <div className="small muted">On their phone: Login › <b>Staff login</b> › this code › their name › PIN.</div>
      </div>
      <div className="btn-row">
        <button className="btn btn-sm" disabled={!code} onClick={() => navigator.clipboard?.writeText(code).then(() => toast("Code copied"), () => {})}>Copy</button>
        <a className="btn btn-sm" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={renew}>New code</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function WorkerModal({ worker, onClose, onSaved }) {
  const isNew = !worker.id;
  const [f, setF] = useState({
    name: worker.name || "", phone: worker.phone || "", role: worker.role || "cook", pin: "",
    wageType: worker.wageType || "monthly", wage: worker.wage ?? "", otRate: worker.otRate ?? "",
    shiftStart: worker.shiftStart || "", shiftEnd: worker.shiftEnd || "", joinedAt: worker.joinedAt || "", active: worker.active !== false,
    access: worker.access || (worker.id ? "none" : defaultAccess(worker.role || "cook")),
  });
  const [accessTouched, setAccessTouched] = useState(!!worker.id);
  const { busy, error, run } = useAction();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = {
        name: f.name, phone: f.phone, role: f.role, wageType: f.wageType, wage: Number(f.wage) || 0, otRate: Number(f.otRate) || 0,
        shiftStart: f.shiftStart || null, shiftEnd: f.shiftEnd || null, active: f.active, access: f.access, ...(f.joinedAt && { joinedAt: f.joinedAt }), ...(f.pin && { pin: f.pin }),
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
          <Field label="Work"><select value={f.role} onChange={(e) => (set("role", e.target.value), !accessTouched && set("access", defaultAccess(e.target.value)))}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label={worker.hasPin ? "New PIN (optional)" : "PIN for kitchen phone"} hint="4 digits">
            <input inputMode="numeric" pattern="\d{4}" maxLength={4} value={f.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} autoComplete="off" />
          </Field>
        </div>
        <Field label="App access (sign in on their own phone)" hint={f.access === "none" ? "Can still use the shared kitchen phone with the PIN." : f.access === "kitchen" ? "Kitchen board, stock, recipes and alerts only." : "Billing, orders, bills, udhar and kitchen. No dashboard, expenses, salaries or settings."}>
          <Seg value={f.access} onChange={(v) => (set("access", v), setAccessTouched(true))} options={ACCESS} />
        </Field>
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

const WD = ["S", "M", "T", "W", "T", "F", "S"];
const BRUSHES = [...STATUS_IDS, "none"];
const keyOf = (staffId, date) => `${staffId}|${date}`;
const monthLabel = (m) => new Date(m + "-01T12:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const shiftMonth = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const lastOfMonth = (m) => `${m}-${String(new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate()).padStart(2, "0")}`;

// ‹ October 2026 › without a calendar popup.
export function MonthBar({ month, setMonth }) {
  const now = thisMonth();
  return (
    <div className="month-bar">
      <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
      <b>{monthLabel(month)}</b>
      <button className="btn btn-sm" disabled={month >= now} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
      {month !== now && <button className="btn btn-sm btn-ghost" onClick={() => setMonth(now)}>This month</button>}
    </div>
  );
}

// The month timeline: pick a status "brush", then tap or drag across days. Long-press for times and overtime.
function Attendance({ data, onChange }) {
  const toast = useToast();
  const month = data.month;
  const today = todayYmd();
  const active = data.staff.filter((s) => s.active);
  const dim = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const days = Array.from({ length: dim }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const [recs, setRecs] = useState(() => new Map(data.records.map((r) => [keyOf(r.staffId, r.date), r])));
  useEffect(() => setRecs(new Map(data.records.map((r) => [keyOf(r.staffId, r.date), r]))), [data]);
  const [brush, setBrush] = useState("present");
  const [dragMode, setDragMode] = useState(() => !matchMedia?.("(pointer: coarse)").matches);
  const [undo, setUndo] = useState([]);
  const [saving, setSaving] = useState(0);
  const [time, setTime] = useState(null); // { worker, date }
  const [range, setRange] = useState(false);
  const stroke = useRef(null);
  const wrap = useRef(null);
  // On a narrow screen, open the timeline at today (or the end of a past month).
  useEffect(() => {
    const el = wrap.current;
    const target = el?.querySelector("th.today") || el?.querySelector("thead th:nth-last-child(2)");
    if (el && target) el.scrollLeft = Math.max(0, target.offsetLeft - el.clientWidth + 120);
  }, [month]);

  const send = async (staffId, date, rec) => {
    setSaving((n) => n + 1);
    try {
      await put("/staff/attendance", rec ? { staffId, date, status: rec.status, inTime: rec.inTime || null, outTime: rec.outTime || null, otHours: rec.otHours || 0, note: rec.note || "" } : { staffId, date, status: "none" });
    } catch (err) {
      toast(err.message);
      onChange();
    } finally {
      setSaving((n) => n - 1);
    }
  };
  // Paints one cell (once per stroke) and remembers what was there for Undo.
  const paint = (staffId, date) => {
    const st = stroke.current;
    const k = keyOf(staffId, date);
    if (!st || st.done.has(k)) return;
    st.done.add(k);
    const prev = recs.get(k) || null;
    if ((prev?.status || "none") === brush) return;
    st.cells.push({ staffId, date, prev });
    const next = brush === "none" ? null : { ...(prev || {}), staffId, date, status: brush };
    setRecs((m) => {
      const n = new Map(m);
      if (next) n.set(k, next);
      else n.delete(k);
      return n;
    });
    send(staffId, date, next);
  };
  const cellAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-cell]");
    return el ? el.dataset.cell.split("|") : null;
  };
  const down = (e, staffId, date) => {
    if (e.button === 2) return;
    stroke.current = { start: [staffId, date], cells: [], done: new Set(), dragging: false, long: false };
    stroke.current.timer = setTimeout(() => {
      if (stroke.current && !stroke.current.dragging) {
        stroke.current.long = true;
        setTime({ worker: active.find((w) => w.id === staffId), date });
      }
    }, 550);
  };
  const move = (e) => {
    const st = stroke.current;
    if (!st || !dragMode) return;
    const c = cellAt(e);
    if (!c || (c[0] === st.start[0] && c[1] === st.start[1] && !st.dragging)) return;
    if (!st.dragging) {
      st.dragging = true;
      clearTimeout(st.timer);
      paint(...st.start);
      st.last = st.start;
    }
    // Fill every day between the last cell and this one, so fast drags don't skip days.
    if (st.last[0] === c[0]) {
      const a = Math.min(Number(st.last[1].slice(8)), Number(c[1].slice(8)));
      const b = Math.max(Number(st.last[1].slice(8)), Number(c[1].slice(8)));
      for (let d = a; d <= b; d++) {
        const date = `${month}-${String(d).padStart(2, "0")}`;
        if (date <= today) paint(c[0], date);
      }
    } else paint(c[0], c[1]);
    st.last = c;
  };
  const up = () => {
    const st = stroke.current;
    if (!st) return;
    clearTimeout(st.timer);
    if (!st.dragging && !st.long) paint(...st.start);
    if (st.cells.length) setUndo((u) => [...u.slice(-19), st.cells]);
    stroke.current = null;
  };
  useEffect(() => {
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => (window.removeEventListener("pointerup", up), window.removeEventListener("pointercancel", up));
  });
  const undoLast = () => {
    const last = undo.at(-1);
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    setRecs((m) => {
      const n = new Map(m);
      for (const c of last) c.prev ? n.set(keyOf(c.staffId, c.date), c.prev) : n.delete(keyOf(c.staffId, c.date));
      return n;
    });
    for (const c of last) send(c.staffId, c.date, c.prev);
    toast(`Undone (${last.length} day${last.length === 1 ? "" : "s"})`);
  };
  const markTodayAll = async () => {
    const r = await put("/staff/attendance/bulk", { staffIds: active.map((w) => w.id), from: today, to: today, status: "present", onlyEmpty: true });
    toast(`Marked ${r.marked} present today`);
    onChange();
  };
  const counts = (id) => {
    const c = Object.fromEntries(STATUS_IDS.map((s) => [s, 0]));
    for (const d of days) {
      const r = recs.get(keyOf(id, d));
      if (r && c[r.status] != null) c[r.status]++;
    }
    return c;
  };

  if (!active.length) return <div className="empty">Add workers first (Workers tab).</div>;
  return (
    <div className="stack">
      <div className="brush-bar">
        <span className="small muted">Mark as:</span>
        {BRUSHES.map((b) => (
          <button key={b} className={"brush " + b + (brush === b ? " on" : "")} onClick={() => setBrush(b)} title={b === "none" ? "Clear" : ATTENDANCE[b].label}>
            {b === "none" ? "Clear" : ATTENDANCE[b].short}
          </button>
        ))}
        <label className="check small" title="On phones, turn off to scroll the timeline with your finger">
          <input type="checkbox" checked={dragMode} onChange={(e) => setDragMode(e.target.checked)} /> Drag to mark many
        </label>
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-primary" onClick={() => setRange(true)}>📅 Mark a range (from – to)</button>
        {month === thisMonth() && <button className="btn btn-sm" onClick={markTodayAll}>✓ Everyone present today</button>}
        <button className="btn btn-sm btn-ghost" disabled={!undo.length} onClick={undoLast}>↶ Undo</button>
        <span className="small muted">{saving ? "Saving…" : undo.length ? "Saved ✓" : ""}</span>
      </div>

      <div ref={wrap} className={"card timeline-wrap" + (dragMode ? " drag" : "")} onPointerMove={move}>
        <table className="timeline">
          <thead>
            <tr>
              <th className="tl-name">Worker</th>
              {days.map((d) => {
                const wd = new Date(d + "T12:00:00").getDay();
                return (
                  <th key={d} className={(wd === 0 ? "sun " : "") + (d === today ? "today" : "")}>
                    <span className="tl-wd">{WD[wd]}</span>
                    {Number(d.slice(8))}
                  </th>
                );
              })}
              <th className="tl-sum">P · H · A · L</th>
            </tr>
          </thead>
          <tbody>
            {active.map((w) => {
              const c = counts(w.id);
              return (
                <tr key={w.id}>
                  <td className="tl-name"><b>{w.name}</b><div className="small muted">{w.role}</div></td>
                  {days.map((d) => {
                    const r = recs.get(keyOf(w.id, d));
                    const wd = new Date(d + "T12:00:00").getDay();
                    return (
                      <td
                        key={d}
                        data-cell={`${w.id}|${d}`}
                        className={"tl-cell " + (r?.status || "") + (wd === 0 ? " sun" : "") + (d === today ? " today" : "") + (d > today ? " future" : "")}
                        onPointerDown={(e) => d <= today && down(e, w.id, d)}
                        onContextMenu={(e) => (e.preventDefault(), setTime({ worker: w, date: d }))}
                        title={`${w.name} · ${d}${r ? ` · ${ATTENDANCE[r.status]?.label}` : ""}${r?.otHours ? ` · OT ${r.otHours} h` : ""}`}
                      >
                        {r ? ATTENDANCE[r.status]?.short : ""}
                        {r?.otHours ? <sup>+</sup> : null}
                      </td>
                    );
                  })}
                  <td className="tl-sum small">{c.present} · {c.half} · {c.absent} · {c.leave}<div className="muted">{data.salary[w.id]?.paidDays ?? 0} paid days</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Pick a status, then tap a day (or drag across days). Hold a day for in/out time and overtime (<sup>+</sup> shows overtime).
        P = Present · H = Half day · A = Absent · L = Leave (unpaid) · PL = Paid leave · WO = Week off.
      </p>
      {time && (
        <TimeModal
          worker={time.worker}
          date={time.date}
          rec={recs.get(keyOf(time.worker.id, time.date))}
          onClose={() => setTime(null)}
          onSave={async (extra) => {
            await put("/staff/attendance", { staffId: time.worker.id, date: time.date, ...extra });
            setTime(null);
            onChange();
          }}
        />
      )}
      {range && <RangeModal staff={active} month={month} onClose={() => setRange(false)} onDone={(n) => (setRange(false), toast(`Marked ${n} day${n === 1 ? "" : "s"}`), onChange())} />}
    </div>
  );
}

// From–to for one or all workers, with a live count of what will change.
function RangeModal({ staff, month, onClose, onDone }) {
  const today = todayYmd();
  const end = lastOfMonth(month) < today ? lastOfMonth(month) : today;
  const [ids, setIds] = useState(() => new Set(staff.map((w) => w.id)));
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(end);
  const [status, setStatus] = useState("present");
  const [skipSundays, setSkipSundays] = useState(false);
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const { busy, error, run } = useAction();
  let n = 0;
  if (from && to && to >= from) for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 864e5) if (!(skipSundays && new Date(t).getUTCDay() === 0)) n++;
  const toggle = (id) => setIds((s) => {
    const x = new Set(s);
    x.has(id) ? x.delete(id) : x.add(id);
    return x;
  });
  const names = staff.filter((w) => ids.has(w.id)).map((w) => w.name);
  return (
    <Modal title="Mark a range of days" onClose={onClose}>
      <div className="stack">
        <div className="field">
          Workers
          <div className="chips">
            <button type="button" className={"chip" + (ids.size === staff.length ? " on" : "")} onClick={() => setIds(ids.size === staff.length ? new Set() : new Set(staff.map((w) => w.id)))}>All</button>
            {staff.map((w) => <button key={w.id} type="button" className={"chip" + (ids.has(w.id) ? " on" : "")} onClick={() => toggle(w.id)}>{w.name}</button>)}
          </div>
        </div>
        <div className="grid2">
          <Field label="From"><input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <div className="field">
          Mark as
          <div className="brush-bar">
            {BRUSHES.map((b) => (
              <button key={b} type="button" className={"brush " + b + (status === b ? " on" : "")} onClick={() => setStatus(b)}>{b === "none" ? "Clear" : ATTENDANCE[b].label}</button>
            ))}
          </div>
        </div>
        <label className="check small"><input type="checkbox" checked={skipSundays} onChange={(e) => setSkipSundays(e.target.checked)} /> Skip Sundays</label>
        <label className="check small"><input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> Only days not marked yet (keep what's already there)</label>
        <p className="small" style={{ margin: 0 }}>
          {n > 62 ? <span className="error">Choose up to 62 days.</span> : <>Will mark <b>{n} day{n === 1 ? "" : "s"}</b> as <b>{status === "none" ? "cleared" : ATTENDANCE[status].label}</b> for {names.length === staff.length ? "everyone" : names.join(", ") || "nobody"}.</>}
        </p>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !ids.size || !n || n > 62}
            onClick={() => run(async () => onDone((await put("/staff/attendance/bulk", { staffIds: [...ids], from, to, status, skipSundays, onlyEmpty })).marked))}
          >
            Mark
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TimeModal({ worker, date, rec, onClose, onSave }) {
  const [f, setF] = useState({ status: rec?.status || "present", inTime: rec?.inTime || worker.shiftStart || "", outTime: rec?.outTime || worker.shiftEnd || "", otHours: rec?.otHours || "", note: rec?.note || "" });
  return (
    <Modal title={`${worker.name} · ${new Date(date + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`} onClose={onClose}>
      <div className="stack">
        <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUS_IDS.map((s) => <option key={s} value={s}>{ATTENDANCE[s].label}</option>)}</select>
        <div className="grid3 price-inputs">
          <Field label="In"><input type="time" value={f.inTime} onChange={(e) => setF({ ...f, inTime: e.target.value })} /></Field>
          <Field label="Out"><input type="time" value={f.outTime} onChange={(e) => setF({ ...f, outTime: e.target.value })} /></Field>
          <Field label="Overtime (h)"><input type="number" min="0" max="24" step="0.5" value={f.otHours} onChange={(e) => setF({ ...f, otHours: e.target.value })} /></Field>
        </div>
        <Field label="Note"><input maxLength={80} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="modal-actions">
          {rec && <button className="btn btn-ghost" onClick={() => onSave({ status: "none" })}>Clear day</button>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave({ status: f.status, inTime: f.inTime || null, outTime: f.outTime || null, otHours: Number(f.otHours) || 0, note: f.note })}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

const fmtDay = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;

// Salary: everything can be fixed — advances, bonus/deductions and payments (their expense follows).
function Salary({ data, month, onChange }) {
  const { shop } = useApp();
  const toast = useToast();
  const [modal, setModal] = useState(null); // { kind: "advance"|"adjust"|"pay", worker, item? }
  const { busy, run } = useAction();
  const workers = useMemo(() => data.staff.filter((s) => s.active || data.salary[s.id]?.marked), [data]);
  const total = workers.reduce((s, w) => s + Math.max(0, data.salary[w.id]?.payable || 0), 0);
  const mine = (list, id) => (list || []).filter((x) => x.staffId === id);
  return (
    <div className="stack">
      <div className="btn-row">
        <div className="small" style={{ flex: 1 }}>Total still to pay: <b>{money(total)}</b></div>
        <button className="btn btn-sm" disabled={busy || !workers.length} onClick={() => run(() => monthSheetExcel(shop, month, workers, data.records, data.salary, data.adjustments))}>📊 Month sheet (Excel)</button>
      </div>
      {workers.length === 0 && <div className="empty">No workers yet.</div>}
      <div className="shop-list">
        {workers.map((w) => {
          const s = data.salary[w.id];
          const advances = mine(data.advances, w.id);
          const adjustments = mine(data.adjustments, w.id);
          const payments = mine(data.payments, w.id);
          return (
            <div key={w.id} className="card stack salary-card">
              <div className="shop-title"><b>{w.name}</b> <span className="tag">{w.role}</span> <span className="small muted">{money(w.wage)} {w.wageType === "daily" ? "/day" : "/month"}</span></div>
              <div className="salary-grid small">
                <span>Paid days</span><b>{s.paidDays} / {s.daysInMonth}</b>
                <span>Earned</span><b>{money(s.earned)}</b>
                {s.overtime > 0 && (<><span>Overtime ({s.otHours} h)</span><b>+ {money(s.overtime)}</b></>)}
                {s.bonus > 0 && (<><span>Bonus</span><b>+ {money(s.bonus)}</b></>)}
                {s.deduction > 0 && (<><span>Deductions</span><b>− {money(s.deduction)}</b></>)}
                {s.advance > 0 && (<><span>Advances</span><b>− {money(s.advance)}</b></>)}
                {s.paid > 0 && (<><span>Paid</span><b>− {money(s.paid)}</b></>)}
                <span><b>Payable</b></span><b className={s.payable > 0 ? "" : "muted"}>{money(s.payable)}</b>
              </div>
              {(advances.length > 0 || adjustments.length > 0 || payments.length > 0) && (
                <div className="money-list small">
                  {advances.map((a) => (
                    <button key={a.id} className="money-item" onClick={() => setModal({ kind: "advance", worker: w, item: a })}>
                      <span>💵 Advance · {fmtDay(a.date)}{a.note ? ` · ${a.note}` : ""}</span><b>− {money(a.amount)}</b><span className="muted">✏️</span>
                    </button>
                  ))}
                  {adjustments.map((a) => (
                    <button key={a.id} className="money-item" onClick={() => setModal({ kind: "adjust", worker: w, item: a })}>
                      <span>{a.amount > 0 ? "🎁 Bonus" : "➖ Deduction"} · {a.note}</span><b>{a.amount > 0 ? "+" : "−"} {money(Math.abs(a.amount))}</b><span className="muted">✏️</span>
                    </button>
                  ))}
                  {payments.map((p) => (
                    <button key={p.id} className="money-item" onClick={() => setModal({ kind: "pay", worker: w, item: p })}>
                      <span>✅ Paid · {fmtDay(p.date)} · {p.mode}</span><b>{money(p.amount)}</b><span className="muted">✏️</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => setModal({ kind: "advance", worker: w })}>+ Advance</button>
                <button className="btn btn-sm" onClick={() => setModal({ kind: "adjust", worker: w })}>± Bonus / deduction</button>
                {s.payable > 0 && <button className="btn btn-sm btn-primary" onClick={() => setModal({ kind: "pay", worker: w, amount: s.payable })}>Pay {money(s.payable)}</button>}
                <button className="btn btn-sm btn-ghost" onClick={() => run(() => salarySlipPdf(shop, w, s, data.records.filter((r) => r.staffId === w.id), adjustments))}>📄 Slip</button>
              </div>
            </div>
          );
        })}
      </div>
      {modal && (
        <MoneyModal
          {...modal}
          month={month}
          onClose={() => setModal(null)}
          onDone={(msg) => (setModal(null), toast(msg), onChange())}
        />
      )}
    </div>
  );
}

// Add or fix an advance, a bonus/deduction, or a salary payment.
function MoneyModal({ kind, worker, item, amount, month, onClose, onDone }) {
  const editing = !!item;
  const [f, setF] = useState({
    amount: item ? Math.abs(item.amount) : amount ?? "",
    sign: item && item.amount < 0 ? "-" : "+",
    date: item?.date || todayYmd(),
    note: item?.note || "",
    mode: item?.mode || "cash",
    addExpense: true,
  });
  const { busy, error, run } = useAction();
  const title = {
    advance: editing ? `Edit advance · ${worker.name}` : `Advance to ${worker.name}`,
    adjust: editing ? `Edit ${item.amount > 0 ? "bonus" : "deduction"} · ${worker.name}` : `Bonus or deduction · ${worker.name}`,
    pay: editing ? `Edit payment · ${worker.name}` : `Pay ${worker.name} · ${monthLabel(month)}`,
  }[kind];
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const amt = Number(f.amount);
      if (kind === "advance") {
        const body = { amount: amt, date: f.date, note: f.note, mode: f.mode };
        editing ? await put(`/staff/advances/${item.id}`, body) : await post(`/staff/${worker.id}/advances`, body);
        onDone(editing ? "Advance updated" : "Advance saved");
      } else if (kind === "adjust") {
        const body = { month, amount: f.sign === "-" ? -amt : amt, note: f.note };
        editing ? await put(`/staff/adjustments/${item.id}`, body) : await post(`/staff/${worker.id}/adjustments`, body);
        onDone(editing ? "Updated" : f.sign === "-" ? "Deduction saved" : "Bonus saved");
      } else {
        if (editing) {
          const r = await put(`/staff/payments/${item.id}`, { amount: amt, date: f.date, mode: f.mode });
          onDone(r.expenseUpdated ? "Payment and its Salary expense updated" : "Payment updated");
        } else {
          await post(`/staff/${worker.id}/salary-paid`, { month, amount: amt, date: f.date, mode: f.mode, addExpense: f.addExpense });
          onDone("Salary payment saved");
        }
      }
    });
  };
  const remove = () =>
    confirm("Delete this entry?") &&
    run(async () => {
      if (kind === "advance") await api(`/staff/advances/${item.id}`, { method: "DELETE" });
      else if (kind === "adjust") await api(`/staff/adjustments/${item.id}`, { method: "DELETE" });
      else {
        const r = await api(`/staff/payments/${item.id}`, { method: "DELETE" });
        return onDone(r.expenseRemoved ? "Payment and its Salary expense deleted" : "Payment deleted");
      }
      onDone("Deleted");
    });
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {kind === "adjust" && <Seg value={f.sign} onChange={(v) => setF({ ...f, sign: v })} options={[["+", "🎁 Bonus (+)"], ["-", "➖ Deduction (−)"]]} />}
        <div className="grid2">
          <Field label="Amount (₹)"><input type="number" min="1" required inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></Field>
          {kind !== "adjust" && <Field label="Date"><input type="date" value={f.date} max={todayYmd()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>}
        </div>
        {kind !== "adjust" && <Seg value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank"]]} />}
        {kind !== "pay" && (
          <Field label={kind === "adjust" ? "Reason (needed)" : "Note"}>
            <input maxLength={80} required={kind === "adjust"} minLength={kind === "adjust" ? 2 : undefined} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={kind === "adjust" ? (f.sign === "-" ? "e.g. broken plate, late days" : "e.g. Diwali bonus") : "e.g. medicine, festival"} />
          </Field>
        )}
        {kind === "pay" && !editing && <label className="check"><input type="checkbox" checked={f.addExpense} onChange={(e) => setF({ ...f, addExpense: e.target.checked })} /> Add to Expenses (Salary) so profit includes it</label>}
        {kind === "pay" && editing && <p className="hint" style={{ margin: 0 }}>The matching Salary expense is updated or deleted with it.</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {editing && <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
