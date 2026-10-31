import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { get, post, put, del } from "../lib/api.js";
import { fmtDateTime, money } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { receiptText, reminderText, timeAgo, waLink } from "../lib/udhar.js";
import { BillDetail } from "./Bills.jsx";
import { InstaReward } from "../components/InstaReward.jsx";
import { LANGUAGE_OPTIONS, languageFor } from "../../shared/messages.js";

const STATE_TAG = {
  open: ["bad", "Udhar open"],
  part: ["warn", "Part paid"],
  cleared: ["good", "Cleared ✅"],
};

export default function CustomerDetail() {
  const { id } = useParams();
  const { shop, loadCustomers } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const [data, setData] = useState(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [openBill, setOpenBill] = useState(null);
  const { busy, error, run } = useAction();

  const load = useCallback(() => run(async () => setData(await get(`/customers/${id}`))), [id, run]);
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <div className="page">{error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>}</div>;
  const c = data.customer;
  const remind = waLink(c.phone, reminderText(c, shop));

  const showBill = (billNo) =>
    run(async () => {
      const r = await get(`/bills?q=${encodeURIComponent(billNo)}&limit=5`);
      const b = r.bills.find((x) => x.billNo === billNo);
      if (b) setOpenBill(b);
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/customers" className="small">← Udhar</Link>
          <h1>{c.name}</h1>
          <div className="muted small">
            {c.phone || "No phone"}
            {c.address && ` · ${c.address}`}
            {c.note && ` · ${c.note}`}
          </div>
        </div>
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
      </div>

      {(c.payLaterBlocked || c.unpaidCount > 0) && (
        <div className={"card shop-state " + (c.payLaterBlocked ? "closed" : "")} style={{ marginBottom: 16 }}>
          <b>{c.payLaterBlocked ? "🔒 Must pay before their food is cooked" : `⚠️ Left without paying ${c.unpaidCount} time${c.unpaidCount === 1 ? "" : "s"}`}</b>
          <span className="small muted">
            {c.unpaidCount > 0 && `Left without paying ${c.unpaidCount} time${c.unpaidCount === 1 ? "" : "s"}. `}
            {c.payLaterBlocked ? "Their QR orders must be paid first (online, or at the counter before cooking)." : "They can still pay after eating."}
          </span>
        </div>
      )}
      <label className="check" style={{ marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={c.payLaterBlocked}
          disabled={busy}
          onChange={(e) =>
            run(async () => {
              const u = await put(`/customers/${id}/pay-later`, { blocked: e.target.checked });
              setData((d) => ({ ...d, customer: u }));
              toast(u.payLaterBlocked ? `${c.name} must pay first from now on` : `${c.name} can pay later again`);
            })
          }
        />
        Must pay first (no paying after eating on QR orders)
      </label>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <div className="muted small">{c.due > 0 ? "Total due" : c.due < 0 ? "Advance paid" : "Account"}</div>
          <div style={{ fontSize: 30, fontWeight: 800 }} className={c.due > 0 ? "due-text" : "ok-text"}>
            {c.due === 0 ? "Settled ✅" : money(Math.abs(c.due), cur)}
          </div>
          {c.lastRemindedAt && <div className="hint">Reminded {timeAgo(c.lastRemindedAt)}</div>}
        </div>
        <div className="btn-row">
          {c.phone && <a className="btn" href={`tel:${c.phone}`}>📞 Call</a>}
          {c.due > 0 && remind && (
            <a className="btn btn-wa" href={remind} target="_blank" rel="noopener noreferrer" onClick={() => post(`/customers/${id}/reminded`).then(load).catch(() => {})}>
              📲 WhatsApp reminder
            </a>
          )}
          <InstaReward phone={c.phone} name={c.name} small={false} />
          <button className="btn btn-primary" onClick={() => setPaying(true)}>Receive payment</button>
        </div>
        {c.phone && <WaOffers phone={c.phone} />}
      </div>

      <div className="card">
        <h2>History</h2>
        {data.ledger.length === 0 && <div className="empty">No udhar bills or payments yet.</div>}
        {data.ledger.map((e) =>
          e.type === "bill" ? (
            <div className="ledger-row click" key={"b" + e.id} onClick={() => showBill(e.billNo)} style={{ cursor: "pointer" }}>
              <div>
                <b>Bill {e.billNo}</b>{" "}
                {e.void ? <span className="tag">void</span> : e.udhar && <span className={"tag " + STATE_TAG[e.udhar.state][0]}>{STATE_TAG[e.udhar.state][1]}{e.udhar.state === "part" ? ` · ${money(e.udhar.left, cur)} left` : ""}</span>}
                <div className="muted small">
                  {fmtDateTime(e.at)} · bill {money(e.total, cur)}{e.paidNow > 0 ? `, paid now ${money(e.paidNow, cur)}` : ""}
                </div>
              </div>
              <div className="amt debit">{e.void ? "—" : "+" + money(e.amount, cur)}</div>
              <div className="bal">{money(e.balance, cur)}</div>
            </div>
          ) : (
            <div className="ledger-row" key={"p" + e.id}>
              <div>
                <b>Payment received</b> <span className="tag good">{e.mode.toUpperCase()}</span>
                <div className="muted small">
                  {fmtDateTime(e.at)}{e.note ? ` · ${e.note}` : ""} ·{" "}
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ padding: "0 4px", fontSize: 12 }}
                    disabled={busy}
                    onClick={() =>
                      confirm(`Delete this ${money(e.amount, cur)} payment? The due goes back up.`) &&
                      run(async () => {
                        await del(`/customers/${id}/payments/${e.id}`);
                        toast("Payment deleted");
                        await load();
                        loadCustomers().catch(() => {});
                      })
                    }
                  >
                    delete
                  </button>
                </div>
              </div>
              <div className="amt credit">−{money(e.amount, cur)}</div>
              <div className="bal">{money(e.balance, cur)}</div>
            </div>
          )
        )}
      </div>

      {paying && (
        <ReceivePayment
          customer={c}
          cur={cur}
          shop={shop}
          onClose={() => setPaying(false)}
          onSaved={async () => {
            await load();
            loadCustomers().catch(() => {});
          }}
        />
      )}
      {editing && (
        <EditCustomer
          customer={c}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
            loadCustomers().catch(() => {});
          }}
        />
      )}
      {openBill && <BillDetail bill={openBill} onClose={() => setOpenBill(null)} onChanged={load} />}
    </div>
  );
}

function ReceivePayment({ customer, cur, shop, onClose, onSaved }) {
  const toast = useToast();
  const [amount, setAmount] = useState(customer.due > 0 ? customer.due : "");
  const [mode, setMode] = useState("cash");
  const [note, setNote] = useState("");
  const [done, setDone] = useState(null); // { amount, balance }
  const { busy, error, run } = useAction();

  const save = (value) =>
    run(async () => {
      const amt = Number(value);
      if (!(amt > 0)) throw new Error("Enter the amount received.");
      const r = await post(`/customers/${customer.id}/payments`, { amount: amt, mode, note });
      await onSaved();
      toast(r.due <= 0 ? `${customer.name}'s udhar is fully cleared ✅` : `Received ${money(amt, cur)}. ${money(r.due, cur)} still due.`);
      setDone({ amount: amt, balance: r.due });
    });

  if (done) {
    const link = waLink(customer.phone, receiptText(customer, shop, done.amount, done.balance));
    return (
      <Modal title={done.balance <= 0 ? "Udhar cleared ✅" : "Payment saved"} onClose={onClose} actions={<button className="btn" onClick={onClose}>Done</button>}>
        <p>
          Received <b>{money(done.amount, cur)}</b> from {customer.name}.{" "}
          {done.balance > 0 ? <>Still due: <b className="due-text">{money(done.balance, cur)}</b></> : done.balance < 0 ? <>Advance: <b>{money(-done.balance, cur)}</b></> : "The account is settled."}
        </p>
        {link && (
          <a className="btn btn-wa btn-block" href={link} target="_blank" rel="noopener noreferrer">
            Send receipt on WhatsApp
          </a>
        )}
      </Modal>
    );
  }

  return (
    <Modal title={`Receive payment · ${customer.name}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), save(amount))}>
        {customer.due > 0 && (
          <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => save(customer.due)}>
            Received full {money(customer.due, cur)} – clear udhar
          </button>
        )}
        <div className="muted small" style={{ textAlign: "center" }}>{customer.due > 0 ? "or a part payment:" : ""}</div>
        <Field label="Amount received">
          <input type="number" min="0.01" step="0.01" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="field">
          Paid by
          <Seg value={mode} onChange={setMode} options={[["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["bank", "Bank"]]} />
        </div>
        <Field label="Note (optional)">
          <input maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save payment</button>
        </div>
      </form>
    </Modal>
  );
}

function EditCustomer({ customer, onClose, onSaved }) {
  const { shop } = useApp();
  const [f, setF] = useState({ name: customer.name, phone: customer.phone || "", address: customer.address || "", note: customer.note || "", language: customer.language || "" });
  const shopLang = LANGUAGE_OPTIONS.find(([c]) => c === languageFor({}, shop))?.[1];
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Edit customer" onClose={onClose}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), run(async () => (await put(`/customers/${customer.id}`, f), onSaved())))}>
        <Field label="Name"><input required maxLength={60} value={f.name} onChange={set("name")} /></Field>
        <Field label="Phone"><input type="tel" inputMode="tel" pattern="[0-9+\- ]{10,15}" maxLength={15} value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Address"><input maxLength={160} value={f.address} onChange={set("address")} /></Field>
        <Field label="Note"><input maxLength={160} value={f.note} onChange={set("note")} /></Field>
        <Field label="Message language">
          <select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>
            <option value="">Shop default ({shopLang})</option>
            {LANGUAGE_OPTIONS.filter(([c]) => c !== "custom" || shop.reminderLanguage === "custom").map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Auto WhatsApp: whether this customer agreed to offers (only they can turn it on, when ordering).
function WaOffers({ phone }) {
  const [w, setW] = useState(null);
  const { busy, run } = useAction();
  useEffect(() => {
    get(`/wa-contacts/${encodeURIComponent(phone)}`).then(setW, () => {});
  }, [phone]);
  if (!w || (!w.ready && !w.optIn && !w.optedOut)) return null;
  const stop = () => run(async () => setW({ ...w, ...(await put(`/wa-contacts/${encodeURIComponent(phone)}`, { optIn: false })) }));
  return (
    <div className="small" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>📲 WhatsApp offers: {w.optIn ? <b className="ok-text">on</b> : w.optedOut ? <b>stopped</b> : <span className="muted">not asked yet</span>}</span>
      {w.lastSentAt && <span className="muted">· last sent {timeAgo(w.lastSentAt)}</span>}
      {w.lastError && <span className="due-text">· last message failed: {w.lastError.title}</span>}
      {w.optIn && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={stop}>Stop messages</button>}
    </div>
  );
}
