import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { DoorDog } from "../components/DoorDog.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";

const CODE_KEY = "staffCode";
const readCode = () => {
  try {
    return localStorage.getItem(CODE_KEY) || "";
  } catch {
    return "";
  }
};
const ACCESS = { kitchen: "Kitchen", manager: "Billing" };

// Staff sign in on their own phone: the shop's staff code (once), their name, their 4-digit PIN.
export default function StaffLogin() {
  const [code, setCode] = useState(readCode);
  const [shop, setShop] = useState(null); // { name, staff }
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [codeError, setCodeError] = useState("");
  const { mood, error, busy, signIn } = useDogAuth();

  const findShop = async (c = code) => {
    setLoading(true);
    setCodeError("");
    try {
      const r = await get(`/auth/staff-names?code=${encodeURIComponent(c.trim().toUpperCase())}`);
      setShop({ name: r.shop.name, staff: r.staff });
      try {
        localStorage.setItem(CODE_KEY, c.trim().toUpperCase());
      } catch {
        /* private mode */
      }
    } catch (err) {
      setCodeError(err.message);
    } finally {
      setLoading(false);
    }
  };
  // The phone remembers the code: go straight to the names.
  useEffect(() => {
    if (code.length === 6) findShop(code);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const press = async (d) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      const ok = await signIn(() => post("/auth/staff-login", { code: code.trim().toUpperCase(), staffId: who.id, pin: next }));
      if (!ok) setPin("");
    }
  };
  const changeShop = () => {
    setShop(null);
    setWho(null);
    setPin("");
    setCode("");
  };

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} />
        {!shop ? (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), findShop())}>
            <div>
              <h1>Staff login</h1>
              <p className="muted small" style={{ margin: 0 }}>For cooks and counter staff. Ask the owner for the shop's 6-letter staff code (Staff page).</p>
            </div>
            <label className="field">
              Shop staff code
              <input
                className="staff-code-input"
                required
                autoFocus
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="e.g. GH7K2Q"
              />
            </label>
            {codeError && <div className="error">{codeError}</div>}
            <button className="btn btn-primary btn-lg" disabled={loading || code.length !== 6}>{loading ? "Finding…" : "Next"}</button>
          </form>
        ) : !who ? (
          <div className="stack">
            <div>
              <h1>{shop.name}</h1>
              <p className="muted small" style={{ margin: 0 }}>Who are you?</p>
            </div>
            <div className="pin-names">
              {shop.staff.map((s) => (
                <button key={s.id} className="btn btn-lg" onClick={() => setWho(s)}>
                  {s.name}
                  <span className="small muted"> · {ACCESS[s.access]}</span>
                </button>
              ))}
            </div>
            {shop.staff.length === 0 && <p className="small">No staff can sign in yet. The owner sets <b>App access</b> and a PIN for each worker on the Staff page.</p>}
            <button className="link-btn small" onClick={changeShop}>Different shop?</button>
          </div>
        ) : (
          <div className="stack pin-modal" style={{ width: "100%" }}>
            <h3 style={{ margin: 0 }}>{who.name}, enter your PIN</h3>
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
            {error && <div className="error">{error}</div>}
            <button className="link-btn small" onClick={() => (setWho(null), setPin(""))}>Not {who.name}?</button>
          </div>
        )}
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          Shop owner? <Link to="/">Log in with email</Link>
        </p>
      </div>
    </div>
  );
}
