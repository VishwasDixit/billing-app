import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { get, post } from "../lib/api.js";
import { outboxAll } from "../lib/offline.js";
import { fmtDateTime, money, todayYmd } from "../lib/format.js";
import { Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { printBill } from "../printer/index.js";
import { explainPrintError } from "../printer/transports.js";
import { shareBillPdf } from "../printer/pdf.js";
import { DELETE_REASONS, BIN_DAYS, isOldBill } from "../../shared/billChanges.js";

export default function Bills() {
  const { shop, sync, online } = useApp();
  const cur = shop.currency || "₹";
  const [tab, setTab] = useState("bills");
  const [from, setFrom] = useState(todayYmd());
  const [to, setTo] = useState(todayYmd());
  const [q, setQ] = useState("");
  const [udharOnly, setUdharOnly] = useState(false);
  const [bills, setBills] = useState([]);
  const [pending, setPending] = useState([]);
  const [binCount, setBinCount] = useState(0);
  const [open, setOpen] = useState(null);
  const { busy, error, run } = useAction();

  const load = useCallback(() => {
    run(async () => {
      setPending(await outboxAll(shop.id));
      const params = new URLSearchParams({ from, to, limit: "500" });
      if (udharOnly) params.set("mode", "credit");
      if (q.trim()) params.set("q", q.trim());
      const [r, bin] = await Promise.all([get("/bills?" + params), get("/bills?bin=1&limit=1000")]);
      setBills(r.bills);
      setBinCount(bin.bills.length);
    });
  }, [run, shop.id, from, to, q, udharOnly]);

  // Reload when the date range changes or queued bills finish uploading.
  useEffect(load, [from, to, sync.pending, udharOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingShown = pending.filter((b) => {
    const d = new Date(new Date(b.createdAt).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
    return d >= from && d <= to && (!q || b.billNo.toLowerCase().startsWith(q.toLowerCase()));
  });
  const all = [...pendingShown.map((b) => ({ ...b, pending: true })), ...bills];
  const total = all.reduce((s, b) => s + b.total, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Bills</h1>
        <div className="admin-tabs">
          <Seg value={tab} onChange={setTab} options={[["bills", "Bill history"], ["bin", `🗑️ Deleted${binCount ? ` (${binCount})` : ""}`]]} />
        </div>
      </div>

      {tab === "bin" ? (
        <Bin onChanged={load} />
      ) : (
        <>
          <div className="range-bar" style={{ marginBottom: 12 }}>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button className={"chip" + (udharOnly ? " on" : "")} onClick={() => setUdharOnly(!udharOnly)}>Udhar only</button>
            <form onSubmit={(e) => (e.preventDefault(), load())} style={{ display: "flex", gap: 6 }}>
              <input className="input" style={{ width: 130 }} placeholder="Bill no." value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn">Search</button>
            </form>
          </div>

          <div className="stats">
            <div className="stat"><div className="label">Bills</div><div className="value">{all.length}</div></div>
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
                      <b>{b.billNo}</b> {b.pending && <span className={"tag " + (b.syncState ? "bad" : "warn")}>{b.syncState ? "not synced" : "syncing"}</span>}
                      <ChangeTags bill={b} />
                      {b.backdated && <span className="tag" title={b.enteredAt ? `Added on ${fmtDateTime(b.enteredAt)}` : undefined}>added later</span>}
                    </td>
                    <td className="muted">{fmtDateTime(b.createdAt)}</td>
                    <td>{b.itemCount}</td>
                    <td>
                      {b.paymentMode === "credit" ? "UDHAR" : b.paymentMode?.toUpperCase()}
                      {b.customer && <div className="muted small">{b.customer.name}</div>}
                      {b.udhar && <UdharTag udhar={b.udhar} cur={cur} />}
                    </td>
                    <td className="num">{money(b.total, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!busy && all.length === 0 && <div className="empty">No bills in this range.</div>}
            {busy && all.length === 0 && <div className="empty">Loading…</div>}
          </div>
        </>
      )}

      {open && <BillDetail bill={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function ChangeTags({ bill }) {
  return (
    <>
      {bill.restoredAt ? <span className="tag warn">restored</span> : bill.editedAt ? <span className="tag warn">edited</span> : null}
    </>
  );
}

const UDHAR_TAG = { open: ["bad", "Udhar open"], part: ["warn", "Part paid"], cleared: ["good", "Udhar cleared ✅"] };

function UdharTag({ udhar, cur }) {
  const [cls, label] = UDHAR_TAG[udhar.state];
  return <span className={"tag " + cls}>{label}{udhar.state === "part" ? ` · ${money(udhar.left, cur)} left` : ""}</span>;
}

// The owner PIN box, shown when Bill safety is on or the bill is more than a week old.
function OwnerPin({ shop, bill, pin, setPin }) {
  const old = isOldBill(bill);
  if (!shop.billPin && !old) return null;
  if (!shop.billPin) return <p className="error small" style={{ margin: 0 }}>This bill is more than a week old. Set an owner PIN in Settings › Bill safety to change it.</p>;
  return (
    <label className="field">
      Owner PIN{old ? " (bill is more than a week old)" : ""}
      <input className="pin-input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
    </label>
  );
}

export function BillDetail({ bill, onClose, onChanged }) {
  const { shop, online } = useApp();
  const cur = shop.currency || "₹";
  const toast = useToast();
  const nav = useNavigate();
  const [mode, setMode] = useState(null); // "delete" | "history"
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [foodMade, setFoodMade] = useState(null);
  const [cancelOrders, setCancelOrders] = useState(false);
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();
  const canChange = !bill.pending && bill.status === "paid";
  const made = foodMade ?? (reason ? DELETE_REASONS[reason].foodMade : null);

  const reprint = async () => {
    try {
      await printBill(shop, bill);
      toast(`Bill ${bill.billNo} printed`);
    } catch (err) {
      const msg = explainPrintError(err);
      if (msg) toast(msg);
    }
  };
  const remove = () =>
    run(async () => {
      await post(`/bills/${bill.id}/delete`, { reason, note, foodMade: made, cancelOrders, ...(pin && { pin }) });
      toast(`Bill ${bill.billNo} moved to Deleted`);
      onChanged();
      onClose();
    });

  const actions =
    mode === "delete"
      ? [
          <button key="c" className="btn" onClick={() => setMode(null)}>Back</button>,
          <button key="d" className="btn btn-danger" disabled={busy || !reason || (reason === "other" && note.trim().length < 3)} onClick={remove}>
            {busy ? "Deleting…" : "Delete bill"}
          </button>,
        ]
      : [
          canChange && (
            <button key="d" className="btn btn-danger" disabled={!online} title={online ? undefined : "Needs internet"} onClick={() => setMode("delete")}>Delete</button>
          ),
          canChange && (
            <button key="e" className="btn" disabled={!online} title={online ? undefined : "Needs internet"} onClick={() => nav("/", { state: { editBill: bill } })}>✏️ Edit</button>
          ),
          <span key="s" className="spacer" />,
          <button key="p" className="btn" onClick={() => shareBillPdf(shop, bill)}>Share PDF</button>,
          <button key="r" className="btn btn-primary" onClick={reprint}>Reprint</button>,
        ];

  return (
    <Modal title={`Bill ${bill.billNo}`} onClose={onClose} actions={actions}>
      <p className="muted small" style={{ marginTop: -8 }}>
        {fmtDateTime(bill.createdAt)} · {bill.paymentMode === "credit" ? "UDHAR" : bill.paymentMode?.toUpperCase()}
        {bill.customer && <> · {bill.customer.name}{bill.customer.phone ? ` (${bill.customer.phone})` : ""}</>}
        {bill.udhar && <> · <UdharTag udhar={bill.udhar} cur={cur} /></>}
        {bill.table && <> · {bill.table}</>}
        {" "}<ChangeTags bill={bill} />
        {bill.backdated && <> · <span className="tag">added later{bill.enteredAt ? ` on ${fmtDateTime(bill.enteredAt)}` : ""}</span></>}
        {bill.pending && <> · <span className="tag warn">{bill.syncError || "waiting to upload"}</span></>}
      </p>
      {bill.pending && <p className="hint" style={{ marginTop: 0 }}>This bill is still uploading. You can edit or delete it once it's saved online.</p>}
      {mode !== "delete" && (
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
            {bill.discount?.amount > 0 && <tr><td className="muted">{bill.promo?.code ? `Promo ${bill.promo.code}` : "Discount"}</td><td className="num">−{money(bill.discount.amount, cur)}</td></tr>}
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
      )}

      {mode !== "delete" && bill.revisions?.length > 0 && <History bill={bill} cur={cur} />}

      {mode === "delete" && (
        <div className="stack">
          <div className="field">
            Why delete bill {bill.billNo} ({money(bill.total, cur)})?
            <div className="reason-grid">
              {Object.entries(DELETE_REASONS).map(([k, r]) => (
                <button key={k} type="button" className={"chip" + (reason === k ? " on" : "")} onClick={() => (setReason(k), setFoodMade(null))}>{r.label}</button>
              ))}
            </div>
          </div>
          {reason && (
            <>
              <label className="field">
                {reason === "other" ? "What happened? (needed)" : "Note (optional)"}
                <input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder={reason === "nopay" ? "e.g. UPI showed failed, customer left" : ""} />
              </label>
              <div className="field">
                Was the food made?
                <Seg value={made ? "yes" : "no"} onChange={(v) => setFoodMade(v === "yes")} options={[["no", "No, put stock back"], ["yes", "Yes, it was used"]]} />
              </div>
              {bill.orderIds?.length > 0 && (
                <label className="check small">
                  <input type="checkbox" checked={cancelOrders} onChange={(e) => setCancelOrders(e.target.checked)} /> Cancel this table's orders too (otherwise they go back to the table to bill again)
                </label>
              )}
              {bill.paymentMode === "credit" && bill.paidNow > 0 && (
                <p className="hint" style={{ margin: 0 }}>⚠️ {bill.customer?.name || "The customer"} already paid {money(bill.paidNow, cur)} on this bill. It will show as an advance on their udhar.</p>
              )}
              <OwnerPin shop={shop} bill={bill} pin={pin} setPin={setPin} />
              <p className="hint" style={{ margin: 0 }}>
                The bill moves to <b>Deleted</b> for {BIN_DAYS} days and is not counted in sales. You can restore it from there. The bill number is never reused, and the owner sees every deleted bill.
              </p>
            </>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

// Who changed what: every edit, delete and restore, newest first.
function History({ bill, cur }) {
  return (
    <div className="card stack bill-history">
      <b className="small">History</b>
      {[...bill.revisions].reverse().map((r, i) => (
        <div key={i} className="small">
          <b>{r.action === "restore" ? "♻️ Restored" : "✏️ Edited"}</b> · {fmtDateTime(r.at)} · by {r.by}
          <div className="muted">
            {r.reasonLabel}
            {r.note ? ` · ${r.note}` : ""}
            {r.action === "edit" && ` · was ${money(r.before.total, cur)} (${r.before.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${r.before.paymentMode === "credit" ? "udhar" : r.before.paymentMode})`}
          </div>
        </div>
      ))}
    </div>
  );
}

// Deleted bills: kept 30 days, can be restored, can't be removed by hand.
function Bin({ onChanged }) {
  const { shop } = useApp();
  const cur = shop.currency || "₹";
  const toast = useToast();
  const [list, setList] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();
  const load = () => run(async () => setList((await get("/bills?bin=1&limit=1000")).bills));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const daysLeft = (b) => (b.purgeAt ? Math.max(0, Math.ceil((new Date(b.purgeAt) - Date.now()) / 864e5)) : null);
  const restore = (b) =>
    run(async () => {
      await post(`/bills/${b.id}/restore`, pin ? { pin } : {});
      toast(`Bill ${b.billNo} restored`);
      setRestoring(null);
      setPin("");
      load();
      onChanged();
    });
  const excel = () =>
    run(async () => {
      const { default: writeExcelFile } = await import("write-excel-file/browser");
      const head = ["Bill", "Bill date", "Amount", "Paid by", "Reason", "Note", "Food made", "Deleted by", "Deleted on", "Removed on"].map((v) => ({ value: v, fontWeight: "bold" }));
      const rows = list.map((b) => [
        b.billNo, fmtDateTime(b.createdAt), b.total, b.paymentMode, b.status === "void" ? "Voided" : DELETE_REASONS[b.deleteReason]?.label || b.deleteReason,
        b.deleteNote || b.voidReason || "", b.foodMade == null ? "" : b.foodMade ? "Yes" : "No", b.deletedBy || b.voidedBy || "",
        fmtDateTime(b.deletedAt || b.voidedAt), b.purgeAt ? fmtDateTime(b.purgeAt) : "kept",
      ]);
      await writeExcelFile([head, ...rows], { columns: head.map(() => ({ width: 16 })), stickyRowsCount: 1 }).toFile(`${shop.name.replace(/\W+/g, "-")}-deleted-bills.xlsx`);
    });

  if (!list) return error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>;
  return (
    <div className="stack">
      <div className="btn-row">
        <p className="small muted" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          Deleted bills stay here for {BIN_DAYS} days, then clear by themselves. They're not counted in sales, reports or the dashboard. A one-line record (number, amount, reason, who) is always kept.
        </p>
        {list.length > 0 && <button className="btn btn-sm" disabled={busy} onClick={excel}>📊 Download (Excel)</button>}
      </div>
      {list.length === 0 && <div className="empty">🗑️ No deleted bills.</div>}
      {list.map((b) => {
        const left = daysLeft(b);
        return (
          <div key={b.id} className="card bin-row">
            <div className="bin-main">
              <div>
                <b>{b.billNo}</b> · {money(b.total, cur)} · <span className="muted small">{b.paymentMode === "credit" ? "udhar" : b.paymentMode}</span>
              </div>
              <div className="small">
                <span className="tag bad">{b.status === "void" ? "Voided" : DELETE_REASONS[b.deleteReason]?.label || b.deleteReason}</span>
                {(b.deleteNote || b.voidReason) && <> {b.deleteNote || b.voidReason}</>}
              </div>
              <div className="small muted">
                Bill of {fmtDateTime(b.createdAt)} · deleted {fmtDateTime(b.deletedAt || b.voidedAt)} by {b.deletedBy || b.voidedBy || "—"}
                {b.foodMade === false && " · stock put back"}
              </div>
              <div className="small muted">{left == null ? "Voided before the bin existed: kept" : left === 0 ? "Clears today" : `Clears in ${left} day${left === 1 ? "" : "s"}`}</div>
            </div>
            {restoring === b.id ? (
              <div className="stack bin-restore">
                <OwnerPin shop={shop} bill={b} pin={pin} setPin={setPin} />
                <div className="btn-row">
                  <button className="btn btn-sm" onClick={() => (setRestoring(null), setPin(""))}>Cancel</button>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => restore(b)}>Restore</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-sm" onClick={() => (shop.billPin || isOldBill(b) ? setRestoring(b.id) : restore(b))}>♻️ Restore</button>
            )}
          </div>
        );
      })}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
