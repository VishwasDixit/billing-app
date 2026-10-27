// The bar on every staff screen while something waits: a swinging bell while it rings, with
// Open Orders / Stop; otherwise when the next reminder rings. Offers phone notifications once.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRinger, stopRinging, nextReminderAt, remindMinutes } from "../lib/ringer.js";
import { askNotify, notifyPermission } from "../lib/notify.js";

export function RingBar({ attention, what, kitchen = false }) {
  const { ringing, lastAlertAt } = useRinger();
  const nav = useNavigate();
  const [, tick] = useState(0);
  const [perm, setPerm] = useState(notifyPermission());
  useEffect(() => {
    if (!attention) return;
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [attention]);
  if (!attention && !ringing) return null;
  const due = nextReminderAt({ lastAlertAt, intervalMin: remindMinutes(), attention });
  const mins = due ? Math.max(1, Math.ceil((due - Date.now()) / 60000)) : null;
  const askPerm = perm === "default" && (
    <button className="btn btn-sm ring-notify" onClick={async () => setPerm(await askNotify())}>🔔 Turn on notifications</button>
  );
  if (ringing)
    return (
      <div className="ringbar ringing" role="alert">
        <span className="ring-bell" aria-hidden="true">🔔</span>
        <div className="ring-text">
          <b>{what()}</b>
          <span>{kitchen ? "New in the kitchen" : "Needs someone now"}</span>
        </div>
        <div className="ring-actions">
          {!kitchen && <button className="btn btn-sm ring-open" onClick={() => (stopRinging(), nav("/orders"))}>Open Orders</button>}
          <button className="btn btn-sm ring-stop" onClick={stopRinging}>🔕 Stop</button>
        </div>
        {askPerm}
      </div>
    );
  return (
    <div className="ringbar waiting">
      <span aria-hidden="true">🔔</span>
      <span className="ring-text-small">
        <b>{what()}</b> waiting{mins ? ` · bell again in ${mins} min` : ""}
      </span>
      {!kitchen && <button className="link-btn" onClick={() => nav("/orders")}>Open Orders →</button>}
      {askPerm}
    </div>
  );
}
