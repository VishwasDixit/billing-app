import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store.jsx";
import { get, post } from "../lib/api.js";
import { outboxAll } from "../lib/offline.js";
import { fmtDateTime, money, todayYmd } from "../lib/format.js";
import { Modal, useAction, useToast } from "../components/ui.jsx";
import { printBill } from "../printer/index.js";
import { explainPrintError } from "../printer/transports.js";
import { shareBillPdf } from "../printer/pdf.js";

export default function Bills() {
  const { shop, sync, online } = useApp();
  const cur = shop.currency || "₹";
  const [from, setFrom] = useState(todayYmd());
  const [to, setTo] = useState(todayYmd());
  const [q, setQ] = useState("");
  const [udharOnly, setUdharOnly] = useState(false);
  const [bills, setBills] = useState([]);
  const [pending, setPending] = useState([]);
  const [open, setOpen] = useState(null);
  const { busy, error, run } = useAction();

  const load = useCallback(() => {
    run(async () => {
      setPending(await outboxAll(shop.id));
      const params = new URLSearchParams({ from, to, limit: "500" });
      if (udharOnly) params.set("mode", "credit");
      if (q.trim()) params.set("q", q.trim());
      const r = await get("/bills?" + params);
      setBills(r.bills);
    });
  }, [run, shop.id, from, to, q]);

  // Reload when the date range changes or queued bills finish uploading.
  useEffect(load, [from, to, sync.pending, udharOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingShown = pending.filter((b) => {
    const d = new Date(new Date(b.createdAt).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    return d >= from && d <= to && (!q || b.billNo.toLowerCase().startsWith(q.toLowerCase()));
  });
  const all = [...pendingShown.map((b) => ({ ...b, pending: true })), ...bills];
  const paid = all.filter((b) => b.status !== "void");
  const total = paid.reduce((s, b) => s + b.total, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Bills</h1>
        <div className="range-bar">
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span className="muted">to</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          <button className={"chip" + (udharOnly ? " on" : "")} onClick={() => setUdharOnly(!udharOnly)}>Udhar only</button>
          <form onSubmit={(e) => (e.preventDefault(), load())} style={{ display: "flex", gap: 6 }}>
            <input className="input" style={{ width: 130 }} placeholder="Bill no." value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn">Search</button>
          </form>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Bills</div><div className="value">{paid.length}</div></div>
        <div className="stat"><div className="label">Sales</div><div className="value">{money(total, cur)}</div></div>
        <div className="stat"><div className="label">Waiting to sync</div><div className="value">{pendingShown.length}</div></div>
      </div>

      {error && <div className="error" style={{ marginBottom: 10 }}>{online ? error : "Offline: showing only bills saved on this device."}</div>}

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Time</th>
              <th>Items</th>
              <th>Paid by</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {all.map((b) => (
              <tr key={b.clientId} className="click" onClick={() => setOpen(b)}>
                <td>
                  <b>{b.billNo}</b>{" "}
                  {b.pending && <span className={"tag " + (b.syncState ? "bad" : "warn")}>{b.syncState ? "not synced" : "syncing"}</span>}
                  {b.status === "void" && <span className="tag bad">void</span>}
                </td>
                <td className="muted">{fmtDateTime(b.createdAt)}</td>
                <td>{b.itemCount}</td>
                <td>
                  {(b.paymentMode === "credit" ? "UDHAR" : b.paymentMode?.toUpperCase())}
                  {b.customer && <div className="muted small">{b.customer.name}</div>}
                  {b.udhar && <UdharTag udhar={b.udhar} cur={cur} />}
                </td>
                <td className="num" style={b.status === "void" ? { textDecoration: "line-through", color: "var(--muted)" } : null}>{money(b.total, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!busy && all.length === 0 && <div className="empty">No bills in this range.</div>}
        {busy && all.length === 0 && <div className="empty">Loading…</div>}
      </div>

      {open && <BillDetail bill={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

const UDHAR_TAG = { open: ["bad", "Udhar open"], part: ["warn", "Part paid"], cleared: ["good", "Udhar cleared ✅"] };

function UdharTag({ udhar, cur }) {
  const [cls, label] = UDHAR_TAG[udhar.state];
  return <span className={"tag " + cls}>{label}{udhar.state === "part" ? ` · ${money(udhar.left, cur)} left` : ""}</span>;
}

export function BillDetail({ bill, onClose, onChanged }) {
  const { shop } = useApp();
  const cur = shop.currency || "₹";
  const toast = useToast();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();

  const reprint = async () => {
    try {
      await printBill(shop, bill);
      toast(`Bill ${bill.billNo} printed`);
    } catch (err) {
      const msg = explainPrintError(err);
      if (msg) toast(msg);
    }
  };

  return (
    <Modal
      title={`Bill ${bill.billNo}`}
      onClose={onClose}
      actions={
        voiding
          ? [
              <button key="c" className="btn" onClick={() => setVoiding(false)}>Back</button>,
              <button
                key="v"
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await post(`/bills/${bill.id}/void`, { reason });
                    toast(`Bill ${bill.billNo} voided`);
                    onChanged();
                    onClose();
                  })
                }
              >
                Void bill
              </button>,
            ]
          : [
              !bill.pending && bill.status !== "void" && (
                <button key="v" className="btn btn-danger" onClick={() => setVoiding(true)}>Void</button>
              ),
              <span key="s" className="spacer" />,
              <button key="p" className="btn" onClick={() => shareBillPdf(shop, bill)}>Share PDF</button>,
              <button key="r" className="btn btn-primary" onClick={reprint}>Reprint</button>,
            ]
      }
    >
      <p className="muted small" style={{ marginTop: -8 }}>
        {fmtDateTime(bill.createdAt)} · {bill.paymentMode === "credit" ? "UDHAR" : bill.paymentMode?.toUpperCase()}
        {bill.customer && <> · {bill.customer.name}{bill.customer.phone ? ` (${bill.customer.phone})` : ""}</>}
        {bill.udhar && <> · <UdharTag udhar={bill.udhar} cur={cur} /></>}
        {bill.status === "void" && <> · <span className="tag bad">void: {bill.voidReason}</span></>}
        {bill.pending && <> · <span className="tag warn">{bill.syncError || "waiting to upload"}</span></>}
      </p>
      <table className="table">
        <tbody>
          {bill.items.map((it, i) => (
            <tr key={i}>
              <td>
                {it.name} {it.variant && <span className="tag">{it.variant}</span>}
                <div className="muted small">{it.qty} × {money(it.rate, cur)}</div>
              </td>
              <td className="num">{money(it.amount, cur)}</td>
            </tr>
          ))}
          <tr><td className="muted">Subtotal</td><td className="num">{money(bill.subtotal, cur)}</td></tr>
          {bill.discount?.amount > 0 && <tr><td className="muted">Discount</td><td className="num">−{money(bill.discount.amount, cur)}</td></tr>}
          {bill.gst?.amount > 0 && <tr><td className="muted">GST ({bill.gst.percent}%)</td><td className="num">{money(bill.gst.amount, cur)}</td></tr>}
          <tr><td><b>Total</b></td><td className="num"><b>{money(bill.total, cur)}</b></td></tr>
          {bill.paymentMode === "credit" && (
            <>
              <tr><td className="muted">Paid now</td><td className="num">{money(bill.paidNow || 0, cur)}</td></tr>
              <tr><td className="muted">Udhar on this bill</td><td className="num due-text">{money(bill.creditAmount ?? bill.total, cur)}</td></tr>
            </>
          )}
        </tbody>
      </table>
      {voiding && (
        <div className="stack" style={{ marginTop: 12 }}>
          <label className="field">
            Reason for voiding (e.g. wrong items, customer cancelled)
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} />
          </label>
          <p className="hint">A void bill stays in records but is not counted in sales.</p>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
