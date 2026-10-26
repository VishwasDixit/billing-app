import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { post } from "../lib/api.js";
import { money } from "../lib/format.js";
import { Seg, useToast } from "../components/ui.jsx";
import { NewCustomer } from "../components/CustomerPicker.jsx";
import { reminderText, remindedToday, timeAgo, waLink, waNumber } from "../lib/udhar.js";

export default function Customers() {
  const { customers, shop, loadCustomers, online } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const cur = shop.currency || "₹";
  const [tab, setTab] = useState("due");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [queue, setQueue] = useState(null); // { list, index, sent }

  useEffect(() => {
    loadCustomers().catch(() => {});
  }, [loadCustomers]);

  const owing = customers.filter((c) => c.due > 0);
  const totalDue = owing.reduce((s, c) => s + c.due, 0);
  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (tab === "due" ? owing : customers)
        .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.phone || "").includes(term))
        .sort((a, z) => z.due - a.due || a.name.localeCompare(z.name)),
    [customers, tab, term] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const remindable = owing.filter((c) => waNumber(c.phone) && c.id).sort((a, z) => z.due - a.due);
  const notToday = remindable.filter((c) => !remindedToday(c.lastRemindedAt));
  const noPhone = owing.filter((c) => !waNumber(c.phone));

  const startQueue = (includeToday) => {
    const list = includeToday ? remindable : notToday;
    if (!list.length) return toast(remindable.length ? "Everyone with dues was already reminded today." : "No customers with dues have a phone number.");
    setQueue({ list, index: 0, sent: 0 });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Udhar</h1>
        <div className="btn-row">
          <button className="btn btn-wa" disabled={!remindable.length} onClick={() => startQueue(false)}>
            📲 Remind all ({notToday.length})
          </button>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add customer</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Total udhar due</div><div className={"value" + (totalDue > 0 ? " due-text" : "")}>{money(totalDue, cur)}</div></div>
        <div className="stat"><div className="label">Customers owing</div><div className="value">{owing.length}</div></div>
        <div className="stat"><div className="label">All customers</div><div className="value">{customers.length}</div></div>
      </div>

      {queue && (
        <ReminderQueue
          queue={queue}
          shop={shop}
          cur={cur}
          onChange={setQueue}
          onDone={(sent) => {
            setQueue(null);
            toast(`Reminders sent: ${sent}`);
            loadCustomers().catch(() => {});
          }}
        />
      )}

      <div className="range-bar" style={{ marginBottom: 12 }}>
        <Seg value={tab} onChange={setTab} options={[["due", `Due (${owing.length})`], ["all", `All (${customers.length})`]]} />
        <input className="input" style={{ maxWidth: 260 }} type="search" placeholder="Search name or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
        {remindable.length > notToday.length && (
          <button className="btn btn-sm btn-ghost" onClick={() => startQueue(true)}>Remind again (incl. today)</button>
        )}
      </div>

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Customer</th><th>Last activity</th><th className="num">Due</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr
                key={c.clientId}
                className="click"
                onClick={() => (c.id ? nav(`/customers/${c.id}`) : toast(online ? "Still saving this customer, try again in a moment." : "This customer opens after the app is back online."))}
              >
                <td>
                  <b>{c.name}</b> {c.pending && <span className="tag warn">not synced</span>}
                  {c.payLaterBlocked && <span className="tag bad">Must pay first</span>}
                  {c.unpaidCount > 0 && !c.payLaterBlocked && <span className="tag warn">didn't pay ×{c.unpaidCount}</span>}
                  <div className="muted small">{c.phone || "No phone"}{c.lastRemindedAt ? ` · reminded ${timeAgo(c.lastRemindedAt)}` : ""}</div>
                </td>
                <td className="muted small">
                  {c.lastPaymentAt ? `Paid ${timeAgo(c.lastPaymentAt)}` : c.lastBillAt ? `Bill ${timeAgo(c.lastBillAt)}` : "—"}
                </td>
                <td className="num">
                  {c.due > 0 ? <span className="due-text">{money(c.due, cur)}</span> : c.due < 0 ? <span className="ok-text">Advance {money(-c.due, cur)}</span> : <span className="tag good">Settled ✅</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="empty">{tab === "due" ? "No pending udhar. 🎉" : "No customers yet. Choose “Udhar” as the payment on a bill, or add a customer."}</div>
        )}
      </div>

      {noPhone.length > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          {noPhone.length} customer{noPhone.length > 1 ? "s" : ""} with dues {noPhone.length > 1 ? "have" : "has"} no phone number ({noPhone.map((c) => c.name).join(", ")}). Add it to send reminders.
        </p>
      )}

      {adding && (
        <NewCustomer
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            toast(`${c.name} added`);
            if (c.id) nav(`/customers/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

// Steps through every customer with dues: open WhatsApp with the message ready, tap Send, then Next.
function ReminderQueue({ queue, shop, cur, onChange, onDone }) {
  const { list, index, sent } = queue;
  const c = list[index];
  const [opened, setOpened] = useState(false);
  useEffect(() => setOpened(false), [index]);
  const link = waLink(c.phone, reminderText(c, shop));
  const next = (didSend) => {
    const s = sent + (didSend ? 1 : 0);
    if (index + 1 >= list.length) onDone(s);
    else onChange({ ...queue, index: index + 1, sent: s });
  };

  return (
    <div className="remind-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <b>Reminder {index + 1} of {list.length}</b>
        <button className="btn btn-sm btn-ghost" onClick={() => onDone(sent)}>Stop</button>
      </div>
      <div>
        <div style={{ fontSize: 18 }}><b>{c.name}</b> · <span className="due-text">{money(c.due, cur)}</span></div>
        <div className="muted small">{c.phone}</div>
      </div>
      <pre className="diag-log" style={{ minHeight: 0 }}>{reminderText(c, shop)}</pre>
      <div className="btn-row">
        <a
          className="btn btn-wa btn-lg"
          style={{ flex: 1 }}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            setOpened(true);
            post(`/customers/${c.id}/reminded`).catch(() => {});
          }}
        >
          Open WhatsApp
        </a>
        <button className={"btn btn-lg" + (opened ? " btn-primary" : "")} onClick={() => next(opened)}>
          {index + 1 >= list.length ? "Finish" : opened ? "Next →" : "Skip"}
        </button>
      </div>
      <p className="hint" style={{ margin: 0 }}>Tap “Open WhatsApp”, press Send in WhatsApp, then come back and tap Next.</p>
    </div>
  );
}
