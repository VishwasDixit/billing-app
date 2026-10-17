import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { Field, useAction } from "../components/ui.jsx";

export default function Login() {
  const { login } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  return (
    <div className="auth">
      <form className="card stack" onSubmit={(e) => (e.preventDefault(), run(() => login(email, password)))}>
        <div>
          <img className="logo-mark" src="/icon.svg" alt="" />
          <h1>Log in</h1>
          <p className="muted small">Billing, printing and sales reports for your shop.</p>
        </div>
        <Field label="Email">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          New shop? <Link to="/register">Start your 7-day free trial</Link>
        </p>
      </form>
    </div>
  );
}
