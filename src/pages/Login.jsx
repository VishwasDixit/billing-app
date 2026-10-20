import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { OtpInput } from "../components/OtpInput.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";
import { GoogleButton, OrDivider } from "../components/GoogleButton.jsx";

export function useResendTimer() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(45)];
}

// Login/sign-up options the server offers (email codes, Google).
export function useAuthConfig() {
  const [config, setConfig] = useState({ emailOtp: false, googleClientId: "" });
  useEffect(() => {
    get("/auth/config").then(setConfig).catch(() => {});
  }, []);
  return config;
}

export default function Login() {
  const navigate = useNavigate();
  const [emailOtp, setEmailOtp] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [mode, setMode] = useState("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [note, setNote] = useState("");
  const [resendLeft, startResend] = useResendTimer();
  const { mood, error, busy, signIn, step } = useDogAuth();

  useEffect(() => {
    get("/auth/config")
      .then((c) => {
        setEmailOtp(c.emailOtp);
        setGoogleClientId(c.googleClientId || "");
        if (c.emailOtp) setMode("code");
      })
      .catch(() => {});
  }, []);

  const sendCode = async (e) => {
    e?.preventDefault();
    const r = await step(() => post("/auth/otp/send", { email, purpose: "login" }));
    if (r) {
      setCodeSent(true);
      setCode("");
      setNote(r.message);
      startResend();
    }
  };

  const verify = (value = code) => signIn(() => post("/auth/otp/login", { email, code: value }));

  // No shop for this Google account yet: continue to sign-up with it filled in.
  const google = (credential) =>
    signIn(async () => {
      try {
        return await post("/auth/google", { credential });
      } catch (err) {
        if (err.data?.code === "NO_ACCOUNT") navigate("/register", { state: { google: { credential, email: err.data.email, name: err.data.name } } });
        throw err;
      }
    });

  return (
    <div className="auth">
      <div className="card stack">
        <DoorDog mood={mood} />
        <div>
          <h1>Log in</h1>
          <p className="muted small" style={{ margin: 0 }}>Billing, printing and sales reports for your shop.</p>
        </div>

        {googleClientId && (
          <>
            <GoogleButton clientId={googleClientId} onCredential={google} />
            <OrDivider />
          </>
        )}

        {emailOtp && (
          <div className="auth-tabs" role="tablist">
            <button type="button" className={mode === "code" ? "on" : ""} onClick={() => setMode("code")}>Email code</button>
            <button type="button" className={mode === "password" ? "on" : ""} onClick={() => setMode("password")}>Password</button>
          </div>
        )}

        {mode === "code" ? (
          !codeSent ? (
            <form className="stack" onSubmit={sendCode}>
              <Field label="Email">
                <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value.trim())} />
              </Field>
              {error && <div className="error">{error}</div>}
              <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Sending…" : "Send login code"}</button>
            </form>
          ) : (
            <form className="stack" onSubmit={(e) => (e.preventDefault(), verify())}>
              <p className="small" style={{ margin: 0, textAlign: "center" }}>
                {note} <br />
                <b>{email}</b> ·{" "}
                <button type="button" className="link-btn" onClick={() => setCodeSent(false)}>change</button>
              </p>
              <OtpInput value={code} onChange={setCode} onComplete={verify} error={mood === "fail"} disabled={busy} />
              {error && <div className="error" style={{ textAlign: "center" }}>{error}</div>}
              <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>{busy ? "Checking…" : "Log in"}</button>
              <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
                Didn't get it? Check spam, or{" "}
                <button type="button" className="link-btn" disabled={resendLeft > 0 || busy} onClick={sendCode}>
                  {resendLeft > 0 ? `resend in ${resendLeft}s` : "send a new code"}
                </button>
              </p>
            </form>
          )
        ) : (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), signIn(() => post("/auth/login", { email, password })))}>
            <Field label="Email">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            </Field>
            <Field label="Password">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
          </form>
        )}

        <p className="small auth-links">
          <Link to="/find-email">Forgot email?</Link>
          <Link to="/forgot">Forgot password?</Link>
        </p>

        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          New shop? <Link to="/register">Start your 7-day free trial</Link>
        </p>
      </div>
    </div>
  );
}
