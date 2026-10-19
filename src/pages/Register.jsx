import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { OtpInput } from "../components/OtpInput.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";
import { useResendTimer } from "./Login.jsx";

export default function Register() {
  const [emailOtp, setEmailOtp] = useState(false);
  const [f, setF] = useState({ shopName: "", name: "", phone: "", email: "", password: "" });
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [resendLeft, startResend] = useResendTimer();
  const { mood, error, busy, signIn, step } = useDogAuth();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    get("/auth/config").then((c) => setEmailOtp(c.emailOtp)).catch(() => {});
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    if (!emailOtp) return signIn(() => post("/auth/register", f));
    const r = await step(() => post("/auth/register/start", f));
    if (r) {
      setCodeSent(true);
      setCode("");
      startResend();
    }
  };

  const verify = (value = code) => signIn(() => post("/auth/register/verify", { email: f.email, code: value }));

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} caption={codeSent && mood === "idle" ? "I'll wait right here for your code 🐾" : undefined} />
        {!codeSent ? (
          <form className="stack" onSubmit={submit}>
            <div>
              <h1>Register your shop</h1>
              <p className="muted small" style={{ margin: 0 }}>7 days free. Then ₹49/month or ₹400/year. Your menu starts with a ready-made dhaba menu you can edit.</p>
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
            <Field label="Email" hint={emailOtp ? "We'll send a 6-digit code to verify it." : undefined}>
              <input required type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value.trim() })} />
            </Field>
            <Field label="Password" hint="At least 6 characters">
              <input required type="password" minLength={6} autoComplete="new-password" value={f.password} onChange={set("password")} />
            </Field>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy}>
              {busy ? "Please wait…" : emailOtp ? "Send verification code" : "Start free trial"}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), verify())}>
            <div>
              <h1>Verify your email</h1>
              <p className="small muted" style={{ margin: 0 }}>
                We sent a 6-digit code to <b>{f.email}</b> ·{" "}
                <button type="button" className="link-btn" onClick={() => setCodeSent(false)}>change</button>
              </p>
            </div>
            <OtpInput value={code} onChange={setCode} onComplete={verify} error={mood === "fail"} disabled={busy} />
            {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>{busy ? "Checking…" : "Verify & start free trial"}</button>
            <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
              Didn't get it? Check spam, or{" "}
              <button type="button" className="link-btn" disabled={resendLeft > 0 || busy} onClick={submit}>
                {resendLeft > 0 ? `resend in ${resendLeft}s` : "send a new code"}
              </button>
            </p>
          </form>
        )}
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          Already registered? <Link to="/">Log in</Link>
        </p>
      </div>
    </div>
  );
}
