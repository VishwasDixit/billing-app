import { useEffect, useState } from "react";
import { get, post } from "../lib/api.js";
import { currentStaff, setCurrentStaff, signOutStaff, onStaffChange, touchStaff } from "../lib/kitchen.js";
import { useApp } from "../lib/store.jsx";

// On a kitchen phone, entries say who made them: tap your name and enter your 4-digit PIN.
// ensureStaff() resolves once someone is signed in (asks only if needed).
let ask = null;
export function ensureStaff(isKitchen) {
  if (!isKitchen) return Promise.resolve(null);
  const s = currentStaff();
  if (s) {
    touchStaff();
    return Promise.resolve(s);
  }
  return new Promise((resolve, reject) => (ask ? ask({ resolve, reject }) : reject(new Error("Please sign in with your PIN."))));
}

export function useCurrentStaff() {
  const [s, setS] = useState(currentStaff);
  useEffect(() => onStaffChange(setS), []);
  return s;
}

// Mounted once on the kitchen phone; shows the PIN pad when asked.
export function StaffGate() {
  const { user } = useApp();
  const [req, setReq] = useState(null);
  useEffect(() => {
    ask = (r) => setReq(r);
    return () => (ask = null);
  }, []);
  if (user.role !== "kitchen" || !req) return null;
  return (
    <PinPad
      onDone={(staff) => {
        req.resolve(staff);
        setReq(null);
      }}
      onCancel={() => {
        req.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        setReq(null);
      }}
    />
  );
}

function PinPad({ onDone, onCancel }) {
  const [staff, setStaff] = useState(null);
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get("/staff").then((r) => setStaff(r.staff), (e) => setError(e.message));
  }, []);
  const press = async (d) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    setError("");
    if (next.length === 4) {
      setBusy(true);
      try {
        const r = await post("/staff/verify-pin", { staffId: who.id, pin: next });
        setCurrentStaff(r.token, r.staff);
        onDone(r.staff);
      } catch (err) {
        setError(err.message);
        setPin("");
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <div className="modal-back pin-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal pin-modal" role="dialog" aria-label="Who is this?">
        {!who ? (
          <>
            <h3>Who is this?</h3>
            {!staff && !error && <div className="empty">Loading…</div>}
            {staff?.length === 0 && <p className="small">No staff with a PIN yet. The owner can add staff in Setup › Staff.</p>}
            <div className="pin-names">
              {staff?.map((s) => (
                <button key={s.id} className="btn btn-lg" onClick={() => setWho(s)}>
                  {s.name}
                  <span className="small muted"> · {s.role}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h3>{who.name}, enter your PIN</h3>
            <div className="pin-dots" aria-label={`${pin.length} of 4 digits`}>
              {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? "on" : ""} />)}
            </div>
            <div className="pin-keys">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) =>
                d === "" ? <span key={i} /> : (
                  <button key={i} className="btn btn-lg" disabled={busy} onClick={() => (d === "⌫" ? setPin(pin.slice(0, -1)) : press(d))}>{d}</button>
                )
              )}
            </div>
            <button className="link-btn" onClick={() => (setWho(null), setPin(""), setError(""))}>Not {who.name}?</button>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Small bar on the kitchen phone: who is signed in, and "Switch".
export function StaffBar() {
  const s = useCurrentStaff();
  if (!s) return null;
  return (
    <div className="staff-bar">
      👤 <b>{s.name}</b>
      <button className="link-btn" onClick={signOutStaff}>Switch</button>
    </div>
  );
}
