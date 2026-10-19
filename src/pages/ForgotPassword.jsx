import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { OtpInput } from "../components/OtpInput.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";
import { useResendTimer } from "./Login.jsx";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(null); // message once the code is sent
  const [resendLeft, startResend] = useResendTimer();
  const { mood, error, busy, signIn, step } = useDogAuth();

  const send = async (e) => {
    e?.preventDefault();
    const r = await step(() => post("/auth/otp/send", { email, purpose: "reset" }));
    if (r) {
      setSent(r.message);
      setCode("");
      startResend();
    }
  };

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} caption={mood === "idle" ? "Lost your key? I'll help you get back in 🔑" : undefined} />
        <h1>Reset password</h1>
        {!sent ? (
          <form className="stack" onSubmit={send}>
            <Field label="Your account email">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            </Field>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Sending…" : "Send reset code"}</button>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), signIn(() => post("/auth/password/reset", { email, code, password })))}>
            <p className="small" style={{ margin: 0, textAlign: "center" }}>
              {sent} <br />
              <b>{email}</b> · <button type="button" className="link-btn" onClick={() => setSent(null)}>change</button>
            </p>
            <OtpInput value={code} onChange={setCode} error={mood === "fail"} disabled={busy} />
            <Field label="New password" hint="At least 6 characters">
              <input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>{busy ? "Saving…" : "Set new password & log in"}</button>
            <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
              <button type="button" className="link-btn" disabled={resendLeft > 0 || busy} onClick={send}>
                {resendLeft > 0 ? `Resend in ${resendLeft}s` : "Send a new code"}
              </button>
            </p>
          </form>
        )}
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          <Link to="/">Back to log in</Link>
        </p>
      </div>
    </div>
  );
}
