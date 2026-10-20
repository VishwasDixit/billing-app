import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { OtpInput } from "../components/OtpInput.jsx";
import { GoogleButton, OrDivider } from "../components/GoogleButton.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";
import { useResendTimer, useAuthConfig } from "./Login.jsx";

export default function ForgotPassword() {
  const { emailOtp, googleClientId } = useAuthConfig();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(null); // message once the code is sent
  const [googleSession, setGoogleSession] = useState(null); // signed in with Google, new password next
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

  const google = async (credential) => {
    const s = await step(() => post("/auth/google", { credential }));
    if (s) setGoogleSession(s);
  };

  const passwordField = (
    <Field label="New password" hint="At least 6 characters">
      <input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
    </Field>
  );

  let body;
  if (googleSession) {
    body = (
      <form
        className="stack"
        onSubmit={(e) => (e.preventDefault(), signIn(async () => (await post("/auth/password", { password }), googleSession)))}
      >
        <p className="small" style={{ margin: 0, textAlign: "center" }}>
          Google confirmed <b>{googleSession.user.email}</b>. Set a new password:
        </p>
        {passwordField}
        {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Saving…" : "Save password & open my shop"}</button>
      </form>
    );
  } else if (sent) {
    body = (
      <form className="stack" onSubmit={(e) => (e.preventDefault(), signIn(() => post("/auth/password/reset", { email, code, password })))}>
        <p className="small" style={{ margin: 0, textAlign: "center" }}>
          {sent} <br />
          <b>{email}</b> · <button type="button" className="link-btn" onClick={() => setSent(null)}>change</button>
        </p>
        <OtpInput value={code} onChange={setCode} error={mood === "fail"} disabled={busy} />
        {passwordField}
        {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>{busy ? "Saving…" : "Set new password & log in"}</button>
        <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
          <button type="button" className="link-btn" disabled={resendLeft > 0 || busy} onClick={send}>
            {resendLeft > 0 ? `Resend in ${resendLeft}s` : "Send a new code"}
          </button>
        </p>
      </form>
    );
  } else {
    body = (
      <>
        {googleClientId && (
          <>
            <p className="small muted" style={{ margin: 0, textAlign: "center" }}>Registered with a Gmail address? Confirm it with Google:</p>
            <GoogleButton clientId={googleClientId} onCredential={google} />
          </>
        )}
        {googleClientId && emailOtp && <OrDivider />}
        {emailOtp ? (
          <form className="stack" onSubmit={send}>
            <Field label="Your account email">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            </Field>
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Sending…" : "Email me a reset code"}</button>
          </form>
        ) : (
          !googleClientId && (
            <p className="small" style={{ margin: 0, textAlign: "center" }}>
              Password reset isn't available right now. Please ask the app admin to reset it for you.
            </p>
          )
        )}
        {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
      </>
    );
  }

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} caption={mood === "idle" ? "Lost your key? I'll help you get back in 🔑" : undefined} />
        <h1>Reset password</h1>
        {body}
        <p className="small muted auth-links">
          <Link to="/">Back to log in</Link>
          <Link to="/find-email">Forgot email?</Link>
        </p>
      </div>
    </div>
  );
}
