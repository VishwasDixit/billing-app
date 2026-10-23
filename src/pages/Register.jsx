import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { GoogleButton, OrDivider } from "../components/GoogleButton.jsx";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
import { OtpInput } from "../components/OtpInput.jsx";
import { useDogAuth } from "../lib/useDogAuth.js";
import { useResendTimer } from "./Login.jsx";

export default function Register() {
  const location = useLocation();
  const [emailOtp, setEmailOtp] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [pricing, setPricing] = useState(null);
  // Signed in with Google (here, or on the login page with no shop yet): the email is already proven.
  const [google, setGoogle] = useState(location.state?.google || null);
  const [f, setF] = useState({ shopName: "", name: google?.name || "", phone: "", email: google?.email || "", password: "" });
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [resendLeft, startResend] = useResendTimer();
  const { mood, error, busy, signIn, step } = useDogAuth();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    get("/auth/config")
      .then((c) => {
        setEmailOtp(c.emailOtp);
        setGoogleClientId(c.googleClientId || "");
        setPricing(c);
      })
      .catch(() => {});
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    if (google) return signIn(() => post("/auth/register", { ...f, googleCredential: google.credential }));
    if (!emailOtp) return signIn(() => post("/auth/register", f));
    const r = await step(() => post("/auth/register/start", f));
    if (r) {
      setCodeSent(true);
      setCode("");
      startResend();
    }
  };

  // Reads the email and name from the Google credential (verified again by the server).
  const fromGoogle = (credential) => {
    try {
      const bin = atob(credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"));
      const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      setGoogle({ credential, email: claims.email.toLowerCase(), name: claims.name || "" });
      setF((x) => ({ ...x, email: claims.email.toLowerCase(), name: x.name || claims.name || "" }));
    } catch {
      /* ignore a malformed credential */
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
              <p className="muted small" style={{ margin: 0 }}>
                {pricing?.plans
                  ? `${pricing.trialDays ? `${pricing.trialDays} days free. Then ` : ""}from ₹${pricing.plans.find((p) => p.id === "monthly")?.amount}/month (6-month and yearly plans save more). `
                  : ""}
                Your menu starts with a ready-made dhaba menu you can edit.
              </p>
            </div>
            {googleClientId && !google && (
              <>
                <GoogleButton clientId={googleClientId} onCredential={fromGoogle} text="signup_with" />
                <OrDivider />
              </>
            )}
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
            <Field
              label="Email"
              hint={google ? <>Verified by Google · <button type="button" className="link-btn" onClick={() => setGoogle(null)}>use another email</button></> : emailOtp ? "We'll send a 6-digit code to verify it." : undefined}
            >
              <input required type="email" autoComplete="email" readOnly={!!google} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value.trim() })} />
            </Field>
            <Field label="Password" hint="At least 6 characters">
              <input required type="password" minLength={6} autoComplete="new-password" value={f.password} onChange={set("password")} />
            </Field>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy}>
              {busy ? "Please wait…" : emailOtp && !google ? "Send verification code" : pricing?.trialDays === 0 ? "Create my shop" : "Start free trial"}
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
