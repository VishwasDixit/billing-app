import { useEffect, useRef, useState } from "react";

// Google's official "Sign in with Google" button. Renders nothing until a client ID is set.
let scriptPromise = null;
function loadGsi() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't load Google sign-in. Check your internet."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function GoogleButton({ clientId, onCredential, text = "continue_with" }) {
  const box = useRef(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const [failed, setFailed] = useState("");

  useEffect(() => {
    if (!clientId || clientId === "test") return;
    let alive = true;
    loadGsi()
      .then((google) => {
        if (!alive || !box.current) return;
        google.accounts.id.initialize({ client_id: clientId, callback: (r) => handler.current(r.credential), ux_mode: "popup" });
        google.accounts.id.renderButton(box.current, { theme: "outline", size: "large", shape: "pill", text, width: Math.min(box.current.offsetWidth || 320, 400) });
      })
      .catch((e) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [clientId, text]);

  if (!clientId) return null;
  return (
    <>
      <div ref={box} className="google-btn" />
      {failed && <div className="small muted" style={{ textAlign: "center" }}>{failed}</div>}
    </>
  );
}

export const OrDivider = () => <div className="or-divider"><span>or</span></div>;
