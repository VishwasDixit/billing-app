import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";

// Forgot which email the shop was registered with: look it up by phone number.
export default function FindEmail() {
  const [phone, setPhone] = useState("");
  const [accounts, setAccounts] = useState(null);
  const { mood, error, busy, step } = useDogAuth();

  const find = async (e) => {
    e.preventDefault();
    const r = await step(() => post("/auth/find-email", { phone }));
    if (r) setAccounts(r.accounts);
  };

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} caption={mood === "idle" ? (accounts ? "Found it! Use this email to log in 🐾" : "Let me sniff out your email 🐾") : undefined} />
        <h1>Find your email</h1>
        {!accounts ? (
          <form className="stack" onSubmit={find}>
            <Field label="Phone number you registered with">
              <input type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Searching…" : "Find my email"}</button>
          </form>
        ) : (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>Your shop{accounts.length > 1 ? "s are" : " is"} registered with:</p>
            {accounts.map((a) => (
              <div key={a.email + a.shop} className="found-email">
                <b>{a.email}</b>
                {a.shop && <span className="small muted">{a.shop}</span>}
              </div>
            ))}
            <p className="hint" style={{ margin: 0 }}>Part of the email is hidden for safety. Check your inboxes for one that matches.</p>
            <Link className="btn btn-primary btn-lg" to="/">Log in</Link>
            <button type="button" className="link-btn" onClick={() => setAccounts(null)}>Try another number</button>
          </div>
        )}
        <p className="small muted auth-links">
          <Link to="/">Back to log in</Link>
          <Link to="/forgot">Forgot password?</Link>
        </p>
      </div>
    </div>
  );
}
