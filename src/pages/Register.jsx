import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { Field, useAction } from "../components/ui.jsx";

export default function Register() {
  const { register } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ shopName: "", name: "", phone: "", email: "", password: "" });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await register(f);
      nav("/");
    });
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <div>
          <img className="logo-mark" src="/icon.svg" alt="" />
          <h1>Register your shop</h1>
          <p className="muted small">7 days free. Then ₹49/month or ₹400/year. Your menu starts with a ready-made dhaba menu you can edit.</p>
        </div>
        <Field label="Shop name">
          <input required minLength={2} maxLength={40} value={f.shopName} onChange={set("shopName")} />
        </Field>
        <div className="grid2">
          <Field label="Your name">
            <input required minLength={2} maxLength={40} autoComplete="name" value={f.name} onChange={set("name")} />
          </Field>
          <Field label="Phone">
            <input required type="tel" inputMode="tel" autoComplete="tel" pattern="[0-9+\- ]{10,15}" value={f.phone} onChange={set("phone")} />
          </Field>
        </div>
        <Field label="Email">
          <input required type="email" autoComplete="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Password" hint="At least 6 characters">
          <input required type="password" minLength={6} autoComplete="new-password" value={f.password} onChange={set("password")} />
        </Field>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? "Creating…" : "Start free trial"}
        </button>
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          Already registered? <Link to="/">Log in</Link>
        </p>
      </form>
    </div>
  );
}
