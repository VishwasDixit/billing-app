// iPhone / iPad in the browser: how to add the app to the Home Screen (its own icon, full
// screen, and order alerts on the lock screen, which iOS only allows for Home Screen apps).
import { useState } from "react";
import { pushNeedsHomeScreen } from "../lib/notify.js";

const KEY = "iosInstallHiddenUntil";
const hiddenNow = () => {
  try {
    return Date.now() < Number(localStorage.getItem(KEY) || 0);
  } catch {
    return false;
  }
};
const inChrome = () => /CriOS/.test(navigator.userAgent);

export function IosInstallSteps() {
  const share = inChrome() ? "the Share button ⬆︎ at the top right, next to the address" : "the Share button ⬆︎ in Safari's bar (at the bottom, or the top on iPad)";
  return (
    <ol className="ios-steps">
      <li><span aria-hidden="true">⬆︎</span><div>Tap <b>{share}</b>.</div></li>
      <li><span aria-hidden="true">➕</span><div>Scroll down and tap <b>Add to Home Screen</b>. Keep “Open as Web App” on, then tap <b>Add</b>.</div></li>
      <li><span aria-hidden="true">📱</span><div>Open <b>Billing</b> from the Home Screen and sign in once more. Then turn on alerts in 🔔 Alerts.</div></li>
    </ol>
  );
}

export function IosInstallBar({ compact = false }) {
  const [hidden, setHidden] = useState(hiddenNow);
  const [open, setOpen] = useState(false);
  if (typeof window === "undefined" || !pushNeedsHomeScreen() || hidden) return null;
  const hide = () => {
    try {
      localStorage.setItem(KEY, String(Date.now() + 14 * 864e5));
    } catch {
      /* private mode */
    }
    setHidden(true);
  };
  return (
    <>
      <div className={"setupbar ios" + (compact ? " compact" : "")} role="status">
        <img src="/apple-touch-icon.png" alt="" width="32" height="32" />
        <span className="setup-text">
          <b>Get the iPhone app</b>
          <span className="small">Its own icon, full screen, and order alerts even when the phone is locked.</span>
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>Install</button>
        <button className="ios-x" onClick={hide} aria-label="Not now">✕</button>
      </div>
      {open && (
        <div className="more-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="more-sheet" role="dialog" aria-label="Install on iPhone">
            <div className="more-grab" aria-hidden="true" />
            <div className="ios-head">
              <img src="/apple-touch-icon.png" alt="" width="56" height="56" />
              <div>
                <b>Install Billing on this iPhone</b>
                <div className="small muted">Free, takes 10 seconds, no App Store needed.</div>
              </div>
            </div>
            <IosInstallSteps />
            <p className="small muted">Order alerts on the lock screen need iOS 16.4 or newer (Settings › General › About › iOS Version). Bluetooth printing on iPhone still needs the Bluefy browser.</p>
            <button className="btn btn-primary btn-lg" onClick={() => setOpen(false)}>Got it</button>
          </div>
        </div>
      )}
    </>
  );
}
