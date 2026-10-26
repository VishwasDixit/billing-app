// Help tab: ask the restaurant (call a waiter, water, the bill, cutlery, or a question), quick
// answers that need no staff, and this phone's requests with the staff's replies.
import { useState } from "react";
import { post } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { promoSummary } from "../../../shared/promo.js";
import { HELP_ASKS } from "../../../shared/tableHelp.js";

const QUICK = ["waiter", "water", "bill", "cutlery"];
const ago = (t) => {
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const savedName = () => {
  try {
    return JSON.parse(localStorage.getItem("coContact") || "{}").name || "";
  } catch {
    return "";
  }
};

export function HelpTab({ token, data, table, offers, cur, device, requests, onSent, onOrders, onMenu }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [faq, setFaq] = useState(null);

  const ask = async (kind, body = {}) => {
    if (!table) return setError("Please choose your table first (at the top of the Menu).");
    setBusy(kind);
    setError("");
    try {
      await post(`/public/shop/${token}/help`, { table: table.id, deviceKey: device, kind, name: savedName(), ...body });
      setSent(kind === "question" ? "Question sent. The staff will answer here." : `${HELP_ASKS[kind][1]}: sent to the staff 👍`);
      if (kind === "question") setText("");
      await onSent();
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again, or call the staff." : err.message);
    } finally {
      setBusy("");
    }
  };

  const payText =
    data.payRule === "first"
      ? "You pay after placing your order, before it's cooked: online on this page, or at the counter."
      : data.payRule === "choose"
        ? "After ordering you can pay that order online right away, or pay at the end with your bill."
        : "You pay at the end. Tap “My orders” › Ask for the bill, then pay online or at the counter.";
  const faqs = [
    ["💳", "How do I pay?", <p key="p">{payText}{data.online ? " Online payments are secured by Cashfree (UPI, cards, netbanking)." : ""}</p>],
    ["⏱️", "Where is my order?", <p key="o">Open <button className="link-btn" onClick={onOrders}>My orders</button> to see live updates from the kitchen: Sent → Cooking → Ready → Served.</p>],
    ["✏️", "Can I change or cancel my order?", <p key="c">Once the kitchen starts, please ask the staff: send a question below or tap “Call a waiter”. You can always add more from the <button className="link-btn" onClick={onMenu}>menu</button>.</p>],
    [
      "🏷️",
      "Is there any discount?",
      offers.length ? (
        <div key="d">{offers.map((o) => <p key={o.code}><b>{o.code}</b>: {o.description || promoSummary(o, cur)}{o.minOrder > 0 ? ` (orders of ${money(o.minOrder, cur)}+)` : ""}</p>)}<p className="small muted">Type the code when you review your order.</p></div>
      ) : (
        <p key="d">No offers right now. Do check again later!</p>
      ),
    ],
  ];

  return (
    <div className="co-help">
      <section className="co-help-hero">
        <div className="co-help-wave">👋</div>
        <b>How can we help?</b>
        <span className="small">{table ? `Your request goes straight to the staff at ${table.name}.` : "Choose your table first, so the staff know where to come."}</span>
      </section>

      <div className="co-quick">
        {QUICK.map((k) => (
          <button key={k} className="co-quick-btn" disabled={!!busy} onClick={() => ask(k)}>
            <span>{HELP_ASKS[k][0]}</span>
            {busy === k ? "Sending…" : HELP_ASKS[k][1]}
          </button>
        ))}
      </div>

      <form className="co-ask" onSubmit={(e) => (e.preventDefault(), text.trim() && ask("question", { text: text.trim() }))}>
        <label htmlFor="co-q"><b>Ask a question</b></label>
        <textarea id="co-q" rows={2} maxLength={200} placeholder="e.g. Is the paneer tikka spicy? Do you have Jain food?" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="co-ask-row">
          <span className="small muted">{text.length}/200</span>
          <button className="btn btn-primary" disabled={!text.trim() || !!busy}>{busy === "question" ? "Sending…" : "Send"}</button>
        </div>
      </form>
      {sent && !error && <div className="co-pay paid small">✅ {sent}</div>}
      {error && <div className="error small">{error}</div>}

      {requests.length > 0 && (
        <section className="co-myasks">
          <h3>Your requests</h3>
          {requests.map((r) => (
            <div key={r.id} className={"co-askcard " + r.status}>
              <div className="co-askcard-top">
                <span>{HELP_ASKS[r.kind]?.[0]} {r.kind === "question" ? r.text : HELP_ASKS[r.kind]?.[1]}</span>
                <span className="small muted">{ago(r.createdAt)}</span>
              </div>
              {r.reply ? (
                <div className="co-reply">💬 {r.reply}</div>
              ) : (
                <div className="small muted">{r.status === "done" ? "Done ✓" : "Sent · waiting for the staff…"}</div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="co-faq">
        <h3>Quick answers</h3>
        {faqs.map(([icon, qn, ans], i) => (
          <div key={qn} className={"co-faq-item" + (faq === i ? " open" : "")}>
            <button onClick={() => setFaq(faq === i ? null : i)} aria-expanded={faq === i}>
              <span>{icon} {qn}</span>
              <span aria-hidden="true">{faq === i ? "−" : "+"}</span>
            </button>
            {faq === i && <div className="co-faq-a">{ans}</div>}
          </div>
        ))}
      </section>
    </div>
  );
}
