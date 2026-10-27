import { useEffect, useState } from "react";
import { HELP_ASKS, helpText } from "../../shared/tableHelp.js";
import { bell } from "../lib/ringer.js";
import { askNotify, notifyPermission, notifySupported, pushSupported, pushNeedsHomeScreen, pushSubscription, pushOn, pushOff } from "../lib/notify.js";
import { useNavigate } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { useOrders, chime } from "../lib/orders.js";
import { money, fmtDateTime, todayYmd } from "../lib/format.js";
import { usePref } from "../lib/prefs.js";

const ICON = { out: "🔴", low: "🟠", expiring: "⏳", expired: "⛔", waste: "🗑️", variance: "🔍" };
const OPEN = ["new", "accepted", "preparing", "ready", "served"];

// Things waiting on the counter: new QR orders, tables asking for the bill, UPI payments to confirm.
function orderItems(st, isKitchen) {
  const out = st.orders
    .filter((o) => o.status === "new")
    .map((o) => ({ key: "o" + o.clientId, icon: "🍽️", at: o.createdAt, text: `${o.tableName || o.table}: new ${o.source === "qr" ? "QR " : ""}order #${o.orderNo} (${o.items.reduce((s, i) => s + i.qty, 0)} items)`, to: "/orders" }));
  for (const r of st.helpRequests.filter((x) => x.status === "open"))
    out.push({ key: "h" + r.id, icon: HELP_ASKS[r.kind]?.[0] || "💬", at: r.createdAt, text: `${r.tableName || r.table}${r.name ? ` · ${r.name}` : ""}: ${helpText(r)}${r.count > 1 ? ` (×${r.count})` : ""}`, to: "/orders" });
  if (isKitchen) return out;
  const asked = new Map();
  for (const o of st.orders) if (o.billRequest && OPEN.includes(o.status) && !asked.has(o.table)) asked.set(o.table, o);
  for (const o of asked.values())
    out.push({ key: "b" + o.table, icon: "🧾", at: o.billRequest.at, text: o.billRequest.method === "paid" ? `${o.tableName || o.table} has paid and is leaving: close the table` : `${o.tableName || o.table} asks for the bill · will pay ${o.billRequest.method === "upi" ? "by UPI" : "at the counter"}`, to: "/orders" });
  for (const o of st.orders.filter((x) => x.pay?.state === "claimed"))
    out.push({ key: "op" + o.clientId, icon: "💳", at: o.pay.claimedAt, text: `#${o.orderNo} · ${o.tableName || o.table} says paid ${money(o.pay.amount)} by UPI: confirm`, to: "/orders" });
  for (const o of st.orders.filter((x) => x.pay?.state === "refundDue"))
    out.push({ key: "rf" + o.clientId, icon: "↩️", at: o.updatedAt, text: `Refund ${money(o.pay.amount)} for cancelled order #${o.orderNo}`, to: "/orders" });
  for (const c of st.paymentClaims) out.push({ key: "p" + c.clientId, icon: "💰", at: c.customerPaid?.at, text: `${c.table || "A table"} says paid ${money(c.total)} by UPI: confirm`, to: "/orders" });
  return out;
}

export function useAlertCount(kitchenCount, isKitchen) {
  const st = useOrders();
  return (isKitchen ? st.waiting + (st.helpOpen || 0) : st.attention) + (kitchenCount || 0);
}

// Lock-screen alerts (Web Push) for this device: null while checking, then "on", "off",
// "home" (iPhone: add to Home Screen first), "unsupported" or "not-set-up" (no server keys).
function useLockScreenAlerts() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pushNeedsHomeScreen()) return setState("home");
    if (!pushSupported()) return setState("unsupported");
    Promise.all([get("/push/key"), pushSubscription()]).then(
      ([k, sub]) => setState(!k.publicKey ? "not-set-up" : sub ? "on" : "off"),
      () => setState("off")
    );
  }, []);
  const toggle = async (on) => {
    setBusy(true);
    setError("");
    try {
      if (on) {
        const r = await pushOn();
        setState(r === "on" ? "on" : r === "denied" ? "off" : r);
        if (r === "denied") setError("Notifications are blocked for this site in the browser settings.");
      } else {
        await pushOff();
        setState("off");
      }
    } catch (e) {
      setError(e.message || "Couldn't change it. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return { state, busy, error, toggle };
}

function LockScreenRow({ state, busy, error, toggle, onPerm }) {
  if (state === "home")
    return <span className="small muted">🔒 For alerts on the lock screen, add this app to the Home Screen (Share › Add to Home Screen), open it from there and turn them on here. Needs iOS 16.4 or newer.</span>;
  if (!state || state === "unsupported" || state === "not-set-up") return null;
  return (
    <>
      <label className="check small">
        <input type="checkbox" checked={state === "on"} disabled={busy} onChange={async (e) => (await toggle(e.target.checked), onPerm(notifyPermission()))} /> 🔒 Alerts on the lock screen (even when the app is closed)
      </label>
      {error && <div className="error small">{error}</div>}
    </>
  );
}

// 🔔 in the top bar on wide screens.
export function AlertsButton({ count, onClick, open }) {
  return (
    <button type="button" className={"alerts-btn" + (open ? " active" : "") + (count ? " has" : "")} onClick={onClick} aria-label={`Alerts${count ? `: ${count}` : ""}`}>
      <span aria-hidden="true">🔔</span>
      <span className="alerts-lbl">Alerts</span>
      {count > 0 && <span className="alerts-badge">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

// The list: table requests first, then kitchen alerts. `sheet` = phone bottom sheet, else a dropdown.
export function AlertsPanel({ onClose, isKitchen, isOwner, sheet, onKitchenChange }) {
  const nav = useNavigate();
  const st = useOrders();
  const [kitchen, setKitchen] = useState(null);
  const [sound, setSound] = usePref("alertSound", true);
  const [bellMode, setBellMode] = usePref("bellMode", "loop");
  const [remindMin, setRemindMin] = usePref("remindMin", 5);
  const [notifyOn, setNotifyOn] = usePref("notifyOn", true);
  const [perm, setPerm] = useState(notifyPermission());
  const [changes, setChanges] = useState(null);
  const lock = useLockScreenAlerts();
  const load = () => get("/kitchen/alerts").then((r) => setKitchen(r.alerts), () => setKitchen([]));
  useEffect(() => {
    load();
    if (isOwner) get(`/bills/changes?from=${todayYmd()}&to=${todayYmd()}`).then(setChanges, () => {});
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (to) => (onClose(), nav(to));
  const seen = async (a) => {
    await post(`/kitchen/alerts/${a.id}/dismiss`).catch(() => {});
    load();
    onKitchenChange?.();
  };
  const orders = orderItems(st, isKitchen);

  return (
    <div className={sheet ? "more-back" : "alerts-back"} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={sheet ? "more-sheet alerts-sheet" : "alerts-drop"} role="dialog" aria-label="Alerts">
        {sheet && <div className="more-grab" aria-hidden="true" />}
        <div className="alerts-head">
          <b>🔔 Alerts</b>
          <button className="link-btn" onClick={onClose}>Close</button>
        </div>
        <div className="alerts-list">
          {orders.length > 0 && <div className="alerts-group">Tables &amp; orders</div>}
          {orders.map((i) => (
            <button key={i.key} className="alerts-item" onClick={() => go(i.to)}>
              <span aria-hidden="true">{i.icon}</span>
              <span className="alerts-text">{i.text}</span>
            </button>
          ))}
          {kitchen?.length > 0 && <div className="alerts-group">Kitchen</div>}
          {kitchen?.map((a) => (
            <div key={a.id} className={"alerts-item " + (a.level === "high" ? "bad" : a.level === "warn" ? "warn" : "")}>
              <span aria-hidden="true">{ICON[a.type] || "•"}</span>
              <button className="alerts-text link-like" onClick={() => go("/kitchen-manage?tab=alerts")}>
                {a.message}
                <span className="small muted"> · {fmtDateTime(a.updatedAt)}</span>
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => seen(a)}>Seen</button>
            </div>
          ))}
          {changes?.items.length > 0 && <div className="alerts-group">Bill changes today</div>}
          {changes?.flags.map((f, i) => (
            <button key={"f" + i} className="alerts-item bad" onClick={() => go("/dashboard")}>
              <span aria-hidden="true">⚠️</span>
              <span className="alerts-text">{f}</span>
            </button>
          ))}
          {changes?.items.slice(0, 8).map((x) => (
            <button key={x.id} className="alerts-item" onClick={() => go("/bills")}>
              <span aria-hidden="true">{x.action === "delete" ? "🗑️" : x.action === "edit" ? "✏️" : "♻️"}</span>
              <span className="alerts-text">
                Bill {x.billNo} {x.action === "delete" ? "deleted" : x.action === "edit" ? "edited" : "restored"} · {money(x.total)} · {x.reasonLabel} · {x.by}
                <span className="small muted"> · {fmtDateTime(x.at)}</span>
              </span>
            </button>
          ))}
          {kitchen && !kitchen.length && !orders.length && !changes?.items.length && <div className="empty small">✅ All clear. Nothing needs you right now.</div>}
          {!kitchen && <div className="empty small">Loading…</div>}
        </div>
        <div className="alerts-foot">
          <div className="bell-settings">
            <label className="check small">
              <input type="checkbox" checked={sound} onChange={(e) => (setSound(e.target.checked), e.target.checked && bell({ force: true }))} /> 🔊 Bell on this device
            </label>
            {sound && (
              <div className="bell-row small">
                <select value={bellMode} onChange={(e) => setBellMode(e.target.value)} aria-label="Bell style">
                  <option value="loop">Ring until stopped</option>
                  <option value="once">Ring once</option>
                </select>
                <select value={remindMin} onChange={(e) => setRemindMin(Number(e.target.value))} aria-label="Remind every">
                  {[2, 5, 10, 15].map((m) => <option key={m} value={m}>Remind every {m} min</option>)}
                  <option value={0}>No reminders</option>
                </select>
                <button className="btn btn-sm" onClick={() => bell({ force: true })}>🔔 Test</button>
              </div>
            )}
            {notifySupported() &&
              (perm === "granted" ? (
                <label className="check small">
                  <input type="checkbox" checked={notifyOn} onChange={(e) => setNotifyOn(e.target.checked)} /> 📲 Notifications when the app isn't on screen
                </label>
              ) : perm === "denied" ? (
                <span className="small muted">📲 Notifications are blocked for this site in the browser settings.</span>
              ) : (
                <button className="btn btn-sm" onClick={async () => setPerm(await askNotify())}>📲 Turn on notifications</button>
              ))}
            <LockScreenRow {...lock} onPerm={setPerm} />
          </div>
          <button className="link-btn small" onClick={() => go("/kitchen-manage?tab=alerts")}>All kitchen alerts →</button>
        </div>
      </div>
    </div>
  );
}
