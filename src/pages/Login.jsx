import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { Field } from "../components/ui.jsx";
import { DoorDog } from "../components/DoorDog.jsx";
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
  const [config, setConfig] = useState({ emailOtp: false, googleClientId: "", trialDays: 3, plans: null });
  useEffect(() => {
    get("/auth/config").then(setConfig).catch(() => {});
  }, []);
  return config;
}

export default function Login() {
  const navigate = useNavigate();
  const { googleClientId, trialDays } = useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { mood, error, busy, signIn } = useDogAuth();

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

        <p className="small auth-links">
          <Link to="/find-email">Forgot email?</Link>
          <Link to="/forgot">Forgot password?</Link>
        </p>

        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          New shop? <Link to="/register">{trialDays ? `Start your ${trialDays}-day free trial` : "Create your shop"}</Link>
        </p>
      </div>
    </div>
  );
}
