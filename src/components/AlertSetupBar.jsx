// Slim bars on staff screens until this device is ready for orders in the background:
// the bell's sound is unlocked (browsers block it after a reload until a tap), and alerts reach
// it when the app is closed (Web Push). Each goes away by itself once done.
import { useEffect, useState } from "react";
import { get } from "../lib/api.js";
import { audioReady, onAudioChange, soundOn } from "../lib/sound.js";
import { notifyPermission, pushSupported, pushNeedsHomeScreen, pushSubscription, pushTurnedOff, pushOn, onPushChange } from "../lib/notify.js";

const HIDE = "alertSetupHidden";
const hiddenNow = () => {
  try {
    return sessionStorage.getItem(HIDE) === "1";
  } catch {
    return false;
  }
};

function usePushMissing() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!pushSupported() || pushNeedsHomeScreen()) return;
    let alive = true;
    const check = () =>
      Promise.all([get("/push/key"), pushSubscription()]).then(
        ([k, sub]) => alive && setMissing(!!k.publicKey && !sub && !pushTurnedOff()),
        () => {}
      );
    check();
    const off = onPushChange(check);
    return () => ((alive = false), off());
  }, []);
  return [missing, setMissing];
}

export function AlertSetupBar() {
  const [audioOk, setAudioOk] = useState(() => !soundOn() || audioReady());
  const [pushMissing, setPushMissing] = usePushMissing();
  const [hidden, setHidden] = useState(hiddenNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => onAudioChange(() => setAudioOk(!soundOn() || audioReady())), []);

  if (!audioOk)
    return (
      <div className="setupbar sound" role="status">
        <span>🔇 <b>Tap anywhere</b> to switch on the order bell for this screen.</span>
      </div>
    );
  if (!pushMissing || hidden) return null;
  const blocked = notifyPermission() === "denied";
  const hide = () => {
    try {
      sessionStorage.setItem(HIDE, "1");
    } catch {
      /* private mode */
    }
    setHidden(true);
  };
  const turnOn = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await pushOn();
      if (r === "on") setPushMissing(false);
      else if (r === "denied") setError("Notifications are blocked. Allow them for this site in the browser's site settings (🔒 next to the address).");
      else setError("This browser can't get alerts when it's closed.");
    } catch (e) {
      setError(e.message || "Couldn't turn it on. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setupbar push" role="status">
      <span className="setup-text">
        🔕 This device won't get order alerts when the app is in the background or closed.
        {(error || blocked) && <span className="small"> {error || "Notifications are blocked: allow them for this site in the browser's site settings (🔒 next to the address)."}</span>}
      </span>
      {!blocked && <button className="btn btn-sm btn-primary" disabled={busy} onClick={turnOn}>{busy ? "Turning on…" : "🔔 Turn on alerts"}</button>}
      <button className="link-btn small" onClick={hide} aria-label="Hide for now">Not now</button>
    </div>
  );
}
