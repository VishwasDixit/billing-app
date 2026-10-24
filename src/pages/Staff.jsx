import { useEffect, useMemo, useRef, useState } from "react";
import { get, post, put, api } from "../lib/api.js";
import { useApp } from "../lib/store.jsx";
import { money, todayYmd } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { ATTENDANCE, STATUS_IDS } from "../../shared/salary.js";
import { salarySlipPdf, monthSheetExcel, passbookExcel } from "../lib/staffExport.js";
import { autoStatus } from "../../shared/salary.js";

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
    wageFrom: thisMonth(),
  });
  const wageChanged = !!worker.id && (Number(f.wage) !== Number(worker.wage || 0) || f.wageType !== (worker.wageType || "monthly"));
  const [accessTouched, setAccessTouched] = useState(!!worker.id);
  const { busy, error, run } = useAction();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = {
        name: f.name, phone: f.phone, role: f.role, wageType: f.wageType, wage: Number(f.wage) || 0, otRate: Number(f.otRate) || 0,
        shiftStart: f.shiftStart || null, shiftEnd: f.shiftEnd || null, active: f.active, access: f.access,
        ...(wageChanged && { wageFrom: f.wageFrom }), ...(f.joinedAt && { joinedAt: f.joinedAt }), ...(f.pin && { pin: f.pin }),
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
        {wageChanged && (
          <Field label="New wage applies from" hint="Months before this keep the old wage, so past salaries don't change.">
            <input type="month" required value={f.wageFrom} onChange={(e) => setF({ ...f, wageFrom: e.target.value })} />
          </Field>
        )}
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
    if (data.closed) return toast(`${monthLabel(month)} is closed. Reopen it on the Salary tab to change attendance.`);
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
    const w = active.find((x) => x.id === id);
    for (const d of days) {
      const st = recs.get(keyOf(id, d))?.status || autoStatus(w, d, data.settings, today);
      if (st && c[st] != null) c[st]++;
    }
    return c;
  };

  if (!active.length) return <div className="empty">Add workers first (Workers tab).</div>;
  return (
    <div className="stack">
      {data.closed && <div className="banner info closed-banner">🔒 {monthLabel(month)} is closed, so attendance is locked. Reopen it on the Salary tab to make changes.</div>}
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
                    const auto = r ? null : autoStatus(w, d, data.settings, today);
                    const wd = new Date(d + "T12:00:00").getDay();
                    return (
                      <td
                        key={d}
                        data-cell={`${w.id}|${d}`}
                        className={"tl-cell " + (r?.status || (auto ? `${auto} auto` : "")) + (wd === 0 ? " sun" : "") + (d === today ? " today" : "") + (d > today ? " future" : "")}
                        onPointerDown={(e) => d <= today && down(e, w.id, d)}
                        onContextMenu={(e) => (e.preventDefault(), !data.closed && setTime({ worker: w, date: d }))}
                        title={`${w.name} · ${d}${r ? ` · ${ATTENDANCE[r.status]?.label}` : ""}${r?.otHours ? ` · OT ${r.otHours} h` : ""}`}
                      >
                        {r ? ATTENDANCE[r.status]?.short : auto ? ATTENDANCE[auto].short : ""}
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

const MODES = [["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank"]];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Status of a worker's month: paid, part paid, due, or they owe the shop.
function payState(s) {
  if (s.payable < 0) return ["blue", "Owes you"];
  if (s.payable === 0 && s.paid > 0) return ["good", "Paid ✓"];
  if (s.payable > 0 && s.paid > 0) return ["warn", "Part paid"];
  if (s.payable > 0) return ["bad", "Due"];
  return ["", "—"];
}

// Salary overview: who is paid and who is due, pay everyone, close the month.
function Salary({ data, month, onChange }) {
  const { shop } = useApp();
  const toast = useToast();
  const [sheet, setSheet] = useState(null); // worker id
  const [payAll, setPayAll] = useState(false);
  const [settings, setSettings] = useState(false);
  const { busy, error, run } = useAction();
  const workers = useMemo(() => data.staff.filter((s) => s.active || data.salary[s.id]?.marked || data.salary[s.id]?.payable || data.salary[s.id]?.paid), [data]);
  const sm = data.summary;
  const closed = data.closed;
  const due = workers.filter((w) => data.salary[w.id]?.payable > 0);
  const closeMonth = () =>
    confirm(`Close ${monthLabel(month)}? Attendance, advances, bonuses and payments for this month will be locked until you reopen it.`) &&
    run(async () => (await post(`/staff/months/${month}/close`), toast("Month closed"), onChange()));
  return (
    <div className="stack">
      {closed && (
        <div className="banner info closed-banner">
          🔒 {monthLabel(month)} is closed ({new Date(closed.closedAt).toLocaleDateString("en-IN")}{closed.closedBy ? ` by ${closed.closedBy}` : ""}). Nothing in it can change.
          <button className="link-btn" onClick={() => run(async () => (await post(`/staff/months/${month}/reopen`), toast("Month reopened"), onChange()))}>Reopen</button>
        </div>
      )}
      <div className="stats salary-stats">
        <div className="stat"><div className="label">Salary this month</div><div className="value">{money(sm.gross)}</div></div>
        <div className="stat"><div className="label">Paid</div><div className="value">{money(sm.paid)}</div></div>
        <div className="stat"><div className="label">Still to pay</div><div className="value" style={{ color: sm.due ? "var(--danger)" : undefined }}>{money(sm.due)}</div></div>
        {(sm.owedToShop > 0 || sm.loansLeft > 0) && (
          <div className="stat"><div className="label">Staff owe you</div><div className="value">{money(sm.owedToShop + sm.loansLeft)}</div><div className="small muted">{sm.loansLeft ? `loans ${money(sm.loansLeft)}` : ""}{sm.loansLeft && sm.owedToShop ? " · " : ""}{sm.owedToShop ? `advances ${money(sm.owedToShop)}` : ""}</div></div>
        )}
      </div>
      <div className="btn-row">
        {!closed && due.length > 0 && <button className="btn btn-primary" onClick={() => setPayAll(true)}>💸 Pay everyone due ({due.length})</button>}
        {!closed && <button className="btn" disabled={busy} onClick={closeMonth}>🔒 Close month</button>}
        <button className="btn btn-ghost" onClick={() => setSettings(true)}>⚙️ Salary settings</button>
        <button className="btn btn-ghost" disabled={busy || !workers.length} onClick={() => run(() => monthSheetExcel(shop, month, workers, data.records, data.salary, data.adjustments))}>📊 Excel</button>
      </div>
      {error && <div className="error">{error}</div>}
      {workers.length === 0 && <div className="empty">No workers yet.</div>}
      {workers.length > 0 && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table salary-table">
            <thead>
              <tr><th>Worker</th><th className="num">Days</th><th className="num hide-sm">Earned</th><th className="num hide-sm">Cuts</th><th className="num hide-sm">Earlier</th><th className="num">Payable</th><th></th></tr>
            </thead>
            <tbody>
              {workers.map((w) => {
                const s = data.salary[w.id];
                const [cls, label] = payState(s);
                const cuts = s.advance + s.loanCut + s.deduction;
                return (
                  <tr key={w.id} className="click" onClick={() => setSheet(w.id)}>
                    <td><b>{w.name}</b><div className="small muted">{w.role} · {money(s.wage)}{s.wageType === "daily" ? "/day" : "/mo"}</div></td>
                    <td className="num">{s.paidDays}{s.auto.present + s.auto.weekoff ? <div className="small muted">{s.auto.present + s.auto.weekoff} auto</div> : null}</td>
                    <td className="num hide-sm">{money(s.earned + s.overtime + s.bonus)}</td>
                    <td className="num hide-sm">{cuts ? `− ${money(cuts)}` : "—"}</td>
                    <td className="num hide-sm">{s.previousBalance ? money(s.previousBalance) : "—"}</td>
                    <td className="num"><b>{money(s.payable)}</b>{s.paid ? <div className="small muted">paid {money(s.paid)}</div> : null}</td>
                    <td><span className={"tag " + cls}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={{ margin: 0 }}>Tap a worker for the full breakdown, passbook and loans. "Earlier" is salary left unpaid (or advances not yet recovered) from previous months.</p>
      {sheet && <WorkerSalarySheet worker={data.staff.find((w) => w.id === sheet)} data={data} month={month} onChange={onChange} onClose={() => setSheet(null)} />}
      {payAll && <PayAllModal workers={due} data={data} month={month} onClose={() => setPayAll(false)} onDone={(r) => (setPayAll(false), toast(`Paid ${r.paid} worker${r.paid === 1 ? "" : "s"} · ${money(r.total)}`), onChange())} />}
      {settings && <SalarySettingsModal settings={data.settings} onClose={() => setSettings(false)} onDone={() => (setSettings(false), toast("Salary settings saved"), onChange())} />}
    </div>
  );
}

// Everything about one worker's pay: this month, the passbook, and loans.
function WorkerSalarySheet({ worker, data, month, onChange, onClose }) {
  const { shop } = useApp();
  const [tab, setTab] = useState("month");
  const [modal, setModal] = useState(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const s = data.salary[worker.id];
  const mine = (list) => (list || []).filter((x) => x.staffId === worker.id);
  const advances = mine(data.advances);
  const adjustments = mine(data.adjustments);
  const payments = mine(data.payments);
  const loans = mine(data.loans);
  const closed = !!data.closed;
  const [cls, label] = payState(s);
  const done = (msg) => (setModal(null), toast(msg), onChange());
  const phone = String(worker.phone || "").replace(/\D/g, "");
  const wa = `https://wa.me/${phone.length === 10 ? "91" + phone : phone}?text=${encodeURIComponent(slipText(shop, worker, s))}`;
  const line = (labelText, value, onClick, cls2 = "") => (
    <button key={labelText} type="button" className={"sal-line " + cls2} onClick={onClick} disabled={!onClick || closed}>
      <span>{labelText}</span><b>{value}</b>
    </button>
  );
  return (
    <Modal title={`${worker.name} · ${monthLabel(month)}`} onClose={onClose} wide>
      <div className="stack sheet-body">
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <span className="small muted">{worker.role} · {money(s.wage)} {s.wageType === "daily" ? "per day" : "per month"} · <span className={"tag " + cls}>{label}</span></span>
          <Seg value={tab} onChange={setTab} options={[["month", "This month"], ["passbook", "Passbook"], ["loans", `Loans${loans.filter((l) => !l.done).length ? ` (${loans.filter((l) => !l.done).length})` : ""}`]]} />
        </div>

        {tab === "month" && (
          <>
            <div className="sal-lines">
              {line("Earlier balance", s.previousBalance ? money(s.previousBalance) : "—", () => setModal({ kind: "opening" }), s.previousBalance < 0 ? "neg" : "")}
              {line(`Earned · ${s.paidDays} of ${s.daysInMonth} days × ${money(s.perDay)}`, money(s.earned), null)}
              {s.auto.present + s.auto.weekoff > 0 && <div className="small muted sal-note">Includes {s.auto.weekoff ? `${s.auto.weekoff} weekly off` : ""}{s.auto.weekoff && s.auto.present ? " and " : ""}{s.auto.present ? `${s.auto.present} unmarked day(s) counted present` : ""} (Salary settings).</div>}
              {s.overtime > 0 && line(`Overtime · ${s.otHours} h × ${money(s.otRate)}`, `+ ${money(s.overtime)}`, null)}
              {adjustments.map((a) => line(`${a.amount > 0 ? "🎁 Bonus" : "➖ Deduction"} · ${a.note}`, `${a.amount > 0 ? "+" : "−"} ${money(Math.abs(a.amount))}`, () => setModal({ kind: "adjust", item: a }), a.amount < 0 ? "neg" : ""))}
              {s.loans.map((l) => line(`🏦 Loan instalment${l.note ? ` · ${l.note}` : ""} · ${money(l.leftAfter)} left after`, `− ${money(l.cut)}`, () => setTab("loans"), "neg"))}
              {advances.map((a) => line(`💵 Advance · ${fmtDay(a.date)}${a.note ? ` · ${a.note}` : ""}`, `− ${money(a.amount)}`, () => setModal({ kind: "advance", item: a }), "neg"))}
              {payments.map((p) => line(`✅ Paid · ${fmtDay(p.date)} · ${p.mode}`, `− ${money(p.amount)}`, () => setModal({ kind: "pay", item: p }), "neg"))}
              <div className="sal-line total"><span>{s.payable < 0 ? `${worker.name} owes you` : "Payable"}</span><b>{money(Math.abs(s.payable))}</b></div>
            </div>
            {!closed ? (
              <div className="btn-row">
                {s.payable > 0 && <button className="btn btn-primary" onClick={() => setModal({ kind: "pay", amount: s.payable })}>Pay {money(s.payable)}</button>}
                <button className="btn btn-sm" onClick={() => setModal({ kind: "advance" })}>+ Advance</button>
                <button className="btn btn-sm" onClick={() => setModal({ kind: "adjust" })}>± Bonus / deduction</button>
                <button className="btn btn-sm" onClick={() => setModal({ kind: "loan" })}>🏦 Give loan</button>
              </div>
            ) : (
              <p className="hint" style={{ margin: 0 }}>🔒 This month is closed. Reopen it on the Salary page to change anything.</p>
            )}
            <div className="btn-row">
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => salarySlipPdf(shop, worker, s, data.records.filter((r) => r.staffId === worker.id), adjustments))}>📄 Slip PDF</button>
              <a className="btn btn-sm btn-ghost" href={wa} target="_blank" rel="noopener noreferrer">💬 Send slip on WhatsApp</a>
            </div>
            {worker.wageHistory?.length > 1 && (
              <p className="small muted" style={{ margin: 0 }}>
                Wage history: {worker.wageHistory.map((h, i) => `${money(h.wage)}${h.wageType === "daily" ? "/day" : "/mo"} ${i === 0 ? "earlier" : `from ${monthLabel(h.from)}`}`).join(" · ")}
              </p>
            )}
          </>
        )}
        {tab === "passbook" && <Passbook worker={worker} month={month} />}
        {tab === "loans" && <Loans worker={worker} loans={loans} month={month} onEdit={(l) => setModal({ kind: "loan", item: l })} onNew={() => setModal({ kind: "loan" })} onChange={onChange} />}
      </div>
      {["advance", "adjust", "pay"].includes(modal?.kind) && <MoneyModal {...modal} worker={worker} month={month} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "loan" && <LoanModal worker={worker} loan={modal.item} month={month} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "opening" && <OpeningModal worker={worker} month={month} onClose={() => setModal(null)} onDone={done} />}
    </Modal>
  );
}

// Month by month like a bank passbook: what was earned, cut and paid, and the balance after each month.
function Passbook({ worker, month }) {
  const { shop } = useApp();
  const [pb, setPb] = useState(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(async () => setPb(await get(`/staff/${worker.id}/passbook?upto=${month}`)));
  }, [worker.id, month]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pb) return error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>;
  return (
    <div className="stack">
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table passbook">
          <thead><tr><th>Month</th><th className="num">Earned</th><th className="num">Cuts</th><th className="num">Paid</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {pb.months.map((m) => (
              <tr key={m.month}>
                <td>{new Date(m.month + "-01T12:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" })}<div className="small muted">{m.paidDays} days</div></td>
                <td className="num">{money(m.earned + m.overtime + m.bonus)}</td>
                <td className="num">{m.advance + m.loanCut + m.deduction ? `− ${money(m.advance + m.loanCut + m.deduction)}` : "—"}</td>
                <td className="num">{m.paid ? money(m.paid) : "—"}</td>
                <td className="num"><b style={{ color: m.payable < 0 ? "var(--danger)" : undefined }}>{money(m.payable)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
        {pb.months.length === 0 && <div className="empty">Nothing yet.</div>}
      </div>
      <p className="hint" style={{ margin: 0 }}>Balance = still to pay after that month (minus = the worker owes you). It carries into the next month.</p>
      {pb.months.length > 0 && <button className="btn btn-sm" style={{ justifySelf: "start" }} disabled={busy} onClick={() => run(() => passbookExcel(shop, worker, pb.months))}>📊 Download passbook (Excel)</button>}
    </div>
  );
}

function Loans({ worker, loans, month, onEdit, onNew, onChange }) {
  const toast = useToast();
  const { run } = useAction();
  const act = (l, body, msg) => run(async () => (await put(`/staff/loans/${l.id}`, body), toast(msg), onChange()));
  return (
    <div className="stack">
      {loans.length === 0 && <p className="small muted" style={{ margin: 0 }}>No loans. A loan is given once and cut from salary every month until it's repaid.</p>}
      {loans.map((l) => {
        const skipped = l.skips?.includes(month);
        return (
          <div key={l.id} className={"card stack loan-card" + (l.done ? " done" : "")}>
            <div className="btn-row" style={{ justifyContent: "space-between" }}>
              <b>🏦 {money(l.amount)}{l.note ? ` · ${l.note}` : ""}</b>
              <span className={"tag " + (l.done ? "good" : "warn")}>{l.done ? (l.closedMonth ? "Closed" : "Repaid ✓") : `${money(l.left)} left`}</span>
            </div>
            <div className="loan-bar"><span style={{ width: `${Math.min(100, (l.repaid / l.amount) * 100)}%` }} /></div>
            <div className="small muted">Given {fmtDay(l.date)} · {money(l.cut)}/month from {monthLabel(l.startMonth)} · repaid {money(l.repaid)}{l.skips?.length ? ` · skipped ${l.skips.map((m) => monthLabel(m).split(" ")[0]).join(", ")}` : ""}</div>
            {!l.done && (
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => onEdit(l)}>Edit</button>
                <button className="btn btn-sm" onClick={() => act(l, skipped ? { unskip: month } : { skip: month }, skipped ? "Instalment back on this month" : "No instalment this month")}>{skipped ? "Cut this month again" : `Skip ${monthLabel(month).split(" ")[0]}`}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => confirm("Close this loan? No more instalments will be cut (from this month).") && act(l, { closedMonth: month }, "Loan closed")}>Close loan</button>
              </div>
            )}
          </div>
        );
      })}
      <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={onNew}>🏦 Give a loan</button>
    </div>
  );
}

function LoanModal({ worker, loan, month, onClose, onDone }) {
  const [f, setF] = useState({ amount: loan?.amount ?? "", cut: loan?.cut ?? "", startMonth: loan?.startMonth || month, date: loan?.date || todayYmd(), note: loan?.note || "", mode: loan?.mode || "cash" });
  const { busy, error, run } = useAction();
  const months = f.amount && f.cut ? Math.ceil(Number(f.amount) / Number(f.cut)) : 0;
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { amount: Number(f.amount), cut: Number(f.cut), startMonth: f.startMonth, date: f.date, note: f.note, mode: f.mode };
      loan ? await put(`/staff/loans/${loan.id}`, body) : await post(`/staff/${worker.id}/loans`, body);
      onDone(loan ? "Loan updated" : "Loan saved");
    });
  };
  return (
    <Modal title={loan ? `Edit loan · ${worker.name}` : `Loan to ${worker.name}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label="Loan amount (₹)"><input type="number" min="1" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></Field>
          <Field label="Cut each month (₹)"><input type="number" min="1" required value={f.cut} onChange={(e) => setF({ ...f, cut: e.target.value })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Given on"><input type="date" value={f.date} max={todayYmd()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="First cut in"><input type="month" required value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: e.target.value })} /></Field>
        </div>
        <Seg value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={MODES} />
        <Field label="Note"><input maxLength={80} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. sister's wedding" /></Field>
        {months > 0 && <p className="small muted" style={{ margin: 0 }}>Repaid in about {months} month{months === 1 ? "" : "s"}. You can skip a month (e.g. festival) or close it early.</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {loan && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => confirm("Delete this loan and all its instalments?") && run(async () => (await api(`/staff/loans/${loan.id}`, { method: "DELETE" }), onDone("Loan deleted")))}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Balance from before you used the app (+ you owe them, − they owe you).
function OpeningModal({ worker, month, onClose, onDone }) {
  const ob = worker.openingBalance;
  const [f, setF] = useState({ amount: ob ? Math.abs(ob.amount) : "", sign: ob && ob.amount < 0 ? "-" : "+", month: ob?.month || month });
  const { busy, error, run } = useAction();
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const amount = Number(f.amount) || 0;
      await put(`/staff/${worker.id}`, { openingBalance: amount ? { amount: f.sign === "-" ? -amount : amount, month: f.month } : null });
      onDone(amount ? "Starting balance saved" : "Starting balance removed");
    });
  };
  return (
    <Modal title={`Starting balance · ${worker.name}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <p className="small muted" style={{ margin: 0 }}>
          The "earlier balance" is worked out from past months automatically. If you started using the app with something already pending, enter it once here.
        </p>
        <Seg value={f.sign} onChange={(v) => setF({ ...f, sign: v })} options={[["+", "I owe them salary"], ["-", "They owe me (old advance)"]]} />
        <div className="grid2">
          <Field label="Amount (₹)"><input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="From month"><input type="month" required value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Pay everyone due at once: one date and method, amounts can be changed.
function PayAllModal({ workers, data, month, onClose, onDone }) {
  const [rows, setRows] = useState(() => workers.map((w) => ({ id: w.id, name: w.name, amount: data.salary[w.id].payable, on: true })));
  const [date, setDate] = useState(todayYmd());
  const [mode, setMode] = useState("cash");
  const [addExpense, setAddExpense] = useState(true);
  const { busy, error, run } = useAction();
  const chosen = rows.filter((r) => r.on && Number(r.amount) > 0);
  const total = chosen.reduce((t, r) => t + Number(r.amount), 0);
  return (
    <Modal title={`Pay salaries · ${monthLabel(month)}`} onClose={onClose}>
      <div className="stack">
        <div className="pay-rows">
          {rows.map((r, i) => (
            <label key={r.id} className="pay-row">
              <input type="checkbox" checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <span>{r.name}</span>
              <input className="input" type="number" min="0" value={r.amount} disabled={!r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            </label>
          ))}
        </div>
        <div className="grid2">
          <Field label="Date"><input type="date" value={date} max={todayYmd()} onChange={(e) => setDate(e.target.value)} /></Field>
          <div className="field">Paid by<Seg value={mode} onChange={setMode} options={MODES} /></div>
        </div>
        <label className="check small"><input type="checkbox" checked={addExpense} onChange={(e) => setAddExpense(e.target.checked)} /> Add to Expenses (Salary) so profit includes it</label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !chosen.length}
            onClick={() => run(async () => onDone(await post("/staff/pay-all", { month, date, mode, addExpense, payments: chosen.map((r) => ({ staffId: r.id, amount: Number(r.amount) })) })))}
          >
            Pay {chosen.length} · {money(total)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SalarySettingsModal({ settings, onClose, onDone }) {
  const [f, setF] = useState({ ...settings });
  const { busy, error, run } = useAction();
  const toggleDay = (d) => setF({ ...f, weeklyOff: f.weeklyOff.includes(d) ? f.weeklyOff.filter((x) => x !== d) : [...f.weeklyOff, d].sort() });
  return (
    <Modal title="Salary settings" onClose={onClose}>
      <div className="stack">
        <div className="field">
          Weekly off day(s)
          <div className="chips">{WEEKDAYS.map((d, i) => <button key={d} type="button" className={"chip" + (f.weeklyOff.includes(i) ? " on" : "")} onClick={() => toggleDay(i)}>{d}</button>)}</div>
          <span className="hint">Unmarked days on these weekdays count as Week off (paid for monthly wages).</span>
        </div>
        <div className="field">
          Days you don't mark
          <Seg value={f.unmarked} onChange={(v) => setF({ ...f, unmarked: v })} options={[["none", "Not paid"], ["present", "Count as present"]]} />
          <span className="hint">"Count as present" suits shops that only mark absences. Only days up to today, after the joining date.</span>
        </div>
        <div className="field">
          Day rate for monthly wages
          <Seg value={f.dayBasis} onChange={(v) => setF({ ...f, dayBasis: v })} options={[["month", "÷ days in month"], ["30", "÷ 30"], ["26", "÷ 26 working days"]]} />
          <span className="hint">₹15,000 a month = {f.dayBasis === "30" ? "₹500" : f.dayBasis === "26" ? "₹577" : "₹484–536"} a day. With ÷ 26, week offs aren't paid days and a full month never pays more than the wage.</span>
        </div>
        <label className="check small"><input type="checkbox" checked={f.otAuto} onChange={(e) => setF({ ...f, otAuto: e.target.checked })} /> Overtime without a set rate = day rate ÷ shift hours</label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => (await put("/staff/settings", f), onDone()))}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// A short slip to send on WhatsApp.
function slipText(shop, worker, s) {
  const r = (n) => `₹${Math.round(Math.abs(n)).toLocaleString("en-IN")}`;
  const lines = [
    `*${shop.name}* · Salary ${monthLabel(s.month)}`,
    `${worker.name}`,
    `Days paid: ${s.paidDays} of ${s.daysInMonth}`,
    `Earned: ${r(s.earned)}`,
    s.overtime ? `Overtime (${s.otHours} h): +${r(s.overtime)}` : null,
    s.bonus ? `Bonus: +${r(s.bonus)}` : null,
    s.deduction ? `Deductions: -${r(s.deduction)}` : null,
    s.loanCut ? `Loan instalment: -${r(s.loanCut)}` : null,
    s.advance ? `Advances: -${r(s.advance)}` : null,
    s.previousBalance ? `Earlier balance: ${s.previousBalance < 0 ? "-" : "+"}${r(s.previousBalance)}` : null,
    s.paid ? `Paid: -${r(s.paid)}` : null,
    s.payable < 0 ? `*You owe: ${r(s.payable)}*` : `*Balance to pay: ${r(s.payable)}*`,
  ];
  return lines.filter(Boolean).join("\n");
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
