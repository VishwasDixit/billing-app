import { useEffect, useState } from "react";
import { waLink } from "../lib/udhar.js";
import { get } from "../lib/api.js";
import { withTable } from "../lib/orderLink.js";

// Customers are matched on the last 10 digits of their mobile.
const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

// Steps through customers one by one (udhar reminders, or an offer): open WhatsApp with the
// message ready, tap Send, then Next.
export function SendQueue({ queue, title, amount, textFor, onOpen, onChange, onDone }) {
  const { list, index, sent } = queue;
  const c = list[index];
  const [opened, setOpened] = useState(false);
  const [tables, setTables] = useState({});
  useEffect(() => setOpened(false), [index]);
  useEffect(() => {
    get("/customers/last-tables").then((r) => setTables(r.tables || {}), () => {});
  }, []);
  const text = withTable(textFor(c), tables[last10(c.phone)]);
  const link = waLink(c.phone, text);
  const next = (didSend) => {
    const s = sent + (didSend ? 1 : 0);
    if (index + 1 >= list.length) onDone(s);
    else onChange({ ...queue, index: index + 1, sent: s });
  };

  return (
    <div className="remind-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <b>{title} {index + 1} of {list.length}</b>
        <button className="btn btn-sm btn-ghost" onClick={() => onDone(sent)}>Stop</button>
      </div>
      <div>
        <div style={{ fontSize: 18 }}><b>{c.name}</b>{amount(c) && <> · <span className="due-text">{amount(c)}</span></>}</div>
        <div className="muted small">{c.phone}</div>
      </div>
      <pre className="diag-log" style={{ minHeight: 0 }}>{text}</pre>
      <div className="btn-row">
        <a
          className="btn btn-wa btn-lg"
          style={{ flex: 1 }}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            setOpened(true);
            onOpen(c);
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
