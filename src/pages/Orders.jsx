import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Modal, useToast } from "../components/ui.jsx";
import { ItemPicture } from "../components/ItemPicture.jsx";
import { useOrders, allOrders, isOpen, refreshOrders, setOrderStatus, createStaffOrder, confirmPayment } from "../lib/orders.js";
import { StockPanel } from "../components/Stock.jsx";
import { printKot } from "../printer/index.js";
import { explainPrintError } from "../printer/transports.js";
import { usePref } from "../lib/prefs.js";

export const STATUS_LABEL = { new: "New", accepted: "To cook", preparing: "Cooking", ready: "Ready", served: "Served", billed: "Paid", rejected: "Rejected" };
const STATUS_TAG = { new: "warn", accepted: "accent", preparing: "accent", ready: "good", served: "", billed: "", rejected: "bad" };
export const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`;
};
const itemsText = (o) => o.items.map((i) => `${i.qty}× ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", ");

// Refreshes the order list every few seconds while a screen that shows orders is open.
export function useOrderPolling(ms = 5000) {
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && refreshOrders().catch(() => {});
    tick();
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}

// Prints a KOT if this device is set to, and explains printer problems without losing the order.
export function useKotPrinter() {
  const { shop } = useApp();
  const toast = useToast();
  const [auto] = usePref("kotAuto", true);
  const [copies] = usePref("kotCopies", 1);
  return async (order, { force = false, reprint = false } = {}) => {
    if (!auto && !force) return;
    try {
      await printKot(shop, order, { copies, reprint });
    } catch (err) {
      const msg = explainPrintError(err);
      toast(`KOT #${order.orderNo} not printed${msg ? `: ${msg}` : ""}`);
    }
  };
}

export default function Orders() {
  const { shop, user } = useApp();
  const isKitchen = user.role === "kitchen";
  const st = useOrders();
  const toast = useToast();
  const nav = useNavigate();
  const kot = useKotPrinter();
  const [tableId, setTableId] = useState(null);
  const [adding, setAdding] = useState(null); // table to add an order for
  const [stockOpen, setStockOpen] = useState(false);
  const cur = shop.currency || "₹";
  useOrderPolling(5000);

  const orders = allOrders(st);
  const waiting = orders.filter((o) => o.status === "new");
  const tables = shop.tables || [];
  const byTable = useMemo(() => {
    const m = new Map(tables.map((t) => [t.id, []]));
    for (const o of orders) if (isOpen(o) && o.status !== "new") (m.get(o.table) || m.set(o.table, []).get(o.table)).push(o);
    return m;
  }, [orders, tables]);

  const accept = async (o) => {
    try {
      await setOrderStatus(o, "accepted");
      await kot({ ...o, status: "accepted" });
    } catch (err) {
      toast(err.message);
    }
  };
  const reject = async (o) => {
    const reason = prompt(`Reject order #${o.orderNo}? Reason for the customer (optional):`, "");
    if (reason === null) return;
    try {
      await setOrderStatus(o, "rejected", reason);
    } catch (err) {
      toast(err.message);
    }
  };

  if (!tables.length) {
    return (
      <div className="page">
        <div className="page-head"><h1>Orders</h1></div>
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h2>🍽️ Table orders, KOT &amp; QR ordering</h2>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Add your tables in <b>Settings › Tables &amp; QR ordering</b> and tap <b>Save settings</b>.</li>
            <li>Take orders for a table here; the <b>KOT</b> prints for the kitchen (works without internet).</li>
            <li>Turn on <b>QR ordering</b> and print the table QR codes so customers can order from their phones.</li>
            <li>Open the <b>Kitchen screen</b> on a tablet, and bill each table at the end.</li>
          </ol>
          <div className="btn-row">
            {!isKitchen && <Link className="btn btn-primary" to="/settings#tables">Set up tables</Link>}
            <Link className="btn" to="/kitchen">🍳 Kitchen screen</Link>
          </div>
        </div>
      </div>
    );
  }

  const openTable = tables.find((t) => t.id === tableId);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Orders</h1>
        <div className="btn-row">
          {!st.online && <span className="tag warn">Offline · orders saved on this phone</span>}
          {st.pending.length > 0 && <span className="tag warn">{st.pending.length} to upload</span>}
          <button className="btn" onClick={() => setStockOpen(true)}>🥟 Stock</button>
          <Link className="btn" to="/kitchen">🍳 Kitchen screen</Link>
        </div>
      </div>
      {stockOpen && <StockPanel onClose={() => setStockOpen(false)} />}

      {st.paymentClaims.length > 0 && (
        <section className="stack" style={{ marginBottom: 16 }}>
          <h2>Payments to confirm ({st.paymentClaims.length})</h2>
          {st.paymentClaims.map((c) => (
            <div key={c.clientId} className="card order-card new">
              <div className="order-top">
                <b>{c.table || "Table"} says paid {money(c.total, cur)} by UPI</b>
                <span className="small muted">Bill {c.billNo} · {ago(c.customerPaid.at)}</span>
              </div>
              {c.customerPaid.utr && <div className="small">UPI reference: <b>{c.customerPaid.utr}</b></div>}
              <div className="small muted">Check your UPI app or bank for this payment, then confirm.</div>
              <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-sm" onClick={() => confirmPayment(c, "cash").then(() => toast("Marked as paid in cash"), (e) => toast(e.message))}>Paid in cash instead</button>
                <button className="btn btn-sm btn-primary" onClick={() => confirmPayment(c, "upi").then(() => toast(`Payment for ${c.table} confirmed`), (e) => toast(e.message))}>
                  ✅ Payment received
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {waiting.length > 0 && (
        <section className="stack" style={{ marginBottom: 16 }}>
          <h2>New QR orders ({waiting.length})</h2>
          <div className="order-cards">
            {waiting.map((o) => (
              <div key={o.clientId} className="card order-card new">
                <div className="order-top">
                  <b>#{o.orderNo} · {o.tableName}</b>
                  <span className="small muted">{ago(o.createdAt)}</span>
                </div>
                {o.customerName && <div className="small">For {o.customerName}</div>}
                <ul className="order-items">
                  {o.items.map((i, k) => (
                    <li key={k}><b>{i.qty}×</b> {i.name}{i.variant ? ` (${i.variant})` : ""}{i.note && <div className="small muted">↳ {i.note}</div>}</li>
                  ))}
                </ul>
                {o.note && <div className="small">📝 {o.note}</div>}
                <div className="order-top">
                  <b>{money(o.total, cur)}</b>
                  <div className="btn-row">
                    <button className="btn btn-sm btn-danger" onClick={() => reject(o)}>Reject</button>
                    <button className="btn btn-sm btn-primary" onClick={() => accept(o)}>Accept &amp; send to kitchen</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 style={{ marginBottom: 8 }}>Tables</h2>
      <div className="table-grid">
        {tables.map((t) => {
          const list = byTable.get(t.id) || [];
          const total = list.reduce((s, o) => s + (o.total || 0), 0);
          const ready = list.some((o) => o.status === "ready");
          const since = list[0]?.createdAt;
          const billReq = list.find((o) => o.billRequest)?.billRequest;
          return (
            <button key={t.id} className={"table-tile" + (list.length ? (ready ? " ready" : " busy") : "") + (billReq ? " wants-bill" : "")} onClick={() => setTableId(t.id)}>
              <b>{t.name}</b>
              {list.length ? (
                <>
                  <span>{money(total, cur)}</span>
                  <span className="small">{list.length} order{list.length === 1 ? "" : "s"} · {ago(since)}</span>
                  {ready && <span className="tag good">food ready</span>}
                  {billReq && <span className="tag warn">🧾 Bill · {billReq.method === "upi" ? "UPI" : "Counter"}</span>}
                </>
              ) : (
                <span className="small muted">Free</span>
              )}
            </button>
          );
        })}
      </div>

      {openTable && (
        <TableSheet
          table={openTable}
          orders={byTable.get(openTable.id) || []}
          cur={cur}
          onClose={() => setTableId(null)}
          onAdd={() => (setAdding(openTable), setTableId(null))}
          onReprint={(o) => kot(o, { force: true, reprint: true })}
          onBill={isKitchen ? null : (list) => {
            const lines = new Map();
            for (const o of list)
              for (const i of o.items) {
                const k = `${i.itemId || i.name}|${i.variant || ""}|${i.rate}`;
                const l = lines.get(k);
                lines.set(k, l ? { ...l, qty: l.qty + i.qty } : { itemId: i.itemId || i.name, name: i.name, variant: i.variant || "", category: i.category || "", rate: i.rate, qty: i.qty });
              }
            const req = list.find((o) => o.billRequest)?.billRequest;
            nav("/", {
              state: {
                tableBill: {
                  table: openTable.id,
                  tableName: openTable.name,
                  orderIds: list.map((o) => o.clientId),
                  orderNos: list.map((o) => o.orderNo),
                  lines: [...lines.values()],
                  payMode: req?.method === "upi" ? "upi" : req ? "cash" : undefined,
                },
              },
            });
          }}
        />
      )}
      {adding && (
        <OrderPicker
          table={adding}
          onClose={() => setAdding(null)}
          onPlaced={async (o) => {
            setAdding(null);
            toast(`Order #${o.orderNo} for ${o.tableName} sent to the kitchen`);
            await kot(o);
          }}
        />
      )}
    </div>
  );
}

function TableSheet({ table, orders, cur, onClose, onAdd, onBill, onReprint }) {
  const toast = useToast();
  const total = orders.reduce((s, o) => s + (o.total || 0), 0);
  const move = async (o, status) => {
    try {
      await setOrderStatus(o, status);
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <Modal title={table.name} onClose={onClose} wide>
      <div className="stack">
        {orders.length === 0 && <div className="empty">No open orders. Tap “Add order” to take one.</div>}
        {orders.find((o) => o.billRequest) && (
          <div className="banner warn" style={{ borderRadius: 8 }}>
            🧾 The customer asked for the bill · will pay {orders.find((o) => o.billRequest).billRequest.method === "upi" ? "online by UPI" : "at the counter"}
          </div>
        )}
        {orders.map((o) => (
          <div key={o.clientId} className="order-line">
            <div className="order-top">
              <span>
                <b>#{o.orderNo}</b> <span className={"tag " + STATUS_TAG[o.status]}>{STATUS_LABEL[o.status]}</span>
                {(o.pending || o.statusPending) && <span className="tag warn" style={{ marginLeft: 4 }}>not uploaded</span>}
              </span>
              <span className="small muted">{o.source === "qr" ? "QR" : "Staff"} · {ago(o.createdAt)} · {money(o.total, cur)}</span>
            </div>
            <div className="small">{itemsText(o)}</div>
            <div className="btn-row">
              {o.status !== "served" && <button className="btn btn-sm" onClick={() => move(o, "served")}>Mark served</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => onReprint(o)}>🖨️ Reprint KOT</button>
            </div>
          </div>
        ))}
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <button className="btn" onClick={onAdd}>+ Add order</button>
          {onBill && (
            <button className="btn btn-primary" disabled={!orders.length} onClick={() => onBill(orders)}>
              Bill {table.name} · {money(total, cur)}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Waiter's order: pick dishes for a table. Saved on this phone first, so it works offline.
function OrderPicker({ table, onClose, onPlaced }) {
  const { menu, shop } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [lines, setLines] = useState(() => new Map());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const active = menu.filter((m) => m.active !== false);
  const cats = ["All", ...new Set(active.map((m) => m.category || "Other"))];
  const shown = active.filter((m) => (cat === "All" || (m.category || "Other") === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const add = (m, v, d) => {
    if (d > 0 && m.soldOut && !lines.get(`${m.id}|${v.label}`) && !confirm(`${m.name} is marked sold out. Add it anyway?`)) return;
    setLines((prev) => {
      const k = `${m.id}|${v.label}`;
      const next = new Map(prev);
      const qty = (next.get(k)?.qty || 0) + d;
      if (qty <= 0) next.delete(k);
      else next.set(k, { itemId: m.id, name: m.name, variant: v.label || "", category: m.category || "", rate: v.price, qty, note: next.get(k)?.note || "" });
      return next;
    });
  };
  const list = [...lines.values()];
  const total = list.reduce((s, l) => s + l.qty * l.rate, 0);
  const place = async () => {
    setBusy(true);
    try {
      onPlaced(await createStaffOrder({ table: table.id, tableName: table.name, items: list, note }));
    } catch (err) {
      toast(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`New order · ${table.name}`} onClose={onClose} wide>
      <div className="stack">
        <input className="input" type="search" placeholder="Search menu…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">{cats.map((c) => <button key={c} className={"chip" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>{c}</button>)}</div>
        <div className="picker-list">
          {shown.map((m) =>
            m.variants.map((v) => {
              const l = lines.get(`${m.id}|${v.label}`);
              return (
                <div key={m.id + v.label} className={"picker-row" + (m.soldOut ? " out" : "")}>
                  <ItemPicture item={m} size={36} />
                  <span className="picker-name">
                    {m.name}{v.label ? ` (${v.label})` : ""}<span className="small muted"> {money(v.price, cur)}</span>
                    {m.soldOut ? <span className="tag bad" style={{ marginLeft: 4 }}>sold out</span> : typeof m.stock === "number" && <span className="tag warn" style={{ marginLeft: 4 }}>{m.stock} left</span>}
                  </span>
                  <div className="qty">
                    <button onClick={() => add(m, v, -1)} disabled={!l} aria-label="Less">−</button>
                    <span className="picker-qty">{l?.qty || 0}</span>
                    <button onClick={() => add(m, v, 1)} aria-label="More">+</button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {list.length > 0 && (
          <div className="stack picker-summary">
            {list.map((l) => (
              <div key={l.itemId + l.variant} className="order-top">
                <span className="small"><b>{l.qty}×</b> {l.name}{l.variant ? ` (${l.variant})` : ""}</span>
                <input
                  className="input"
                  style={{ maxWidth: 180, padding: "4px 8px", fontSize: 13 }}
                  placeholder="Kitchen note"
                  maxLength={80}
                  value={l.note}
                  onChange={(e) => setLines((prev) => new Map(prev).set(`${l.itemId}|${l.variant}`, { ...l, note: e.target.value }))}
                />
              </div>
            ))}
            <input className="input" placeholder="Note for the whole order (optional)" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !list.length} onClick={place}>
            Send to kitchen · {money(total, cur)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
