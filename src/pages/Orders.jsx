import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Modal, useToast } from "../components/ui.jsx";
import { ItemPicture } from "../components/ItemPicture.jsx";
import { useOrders, allOrders, isOpen, refreshOrders, setOrderStatus, createStaffOrder, confirmPayment, orderPayment, closeTable, leftUnpaid, answerHelp } from "../lib/orders.js";
import { HELP_ASKS, helpText, QUICK_REPLIES } from "../../shared/tableHelp.js";
import { put } from "../lib/api.js";
import { printBill } from "../printer/index.js";
import { shareBillPdf } from "../printer/pdf.js";
import { StockPanel } from "../components/Stock.jsx";
import { printKot } from "../printer/index.js";
import { explainPrintError } from "../printer/transports.js";
import { usePref } from "../lib/prefs.js";
import { storeOpen } from "../../shared/hours.js";
import { groupOf, groupPrice, deliveryLine, servedAt } from "../../shared/tableGroups.js";
import { addonText, addonGroupsFor, addonKey, addonsTotal, lineLabel } from "../../shared/addons.js";
import { Customize } from "./customer/Customize.jsx";

export const STATUS_LABEL = { new: "New", accepted: "To cook", preparing: "Cooking", ready: "Ready", served: "Served", billed: "Paid", rejected: "Rejected", unpaid: "Left unpaid" };
const STATUS_TAG = { new: "warn", accepted: "accent", preparing: "accent", ready: "good", served: "", billed: "", rejected: "bad", unpaid: "bad" };
export const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`;
};
const itemsText = (o) => o.items.map((i) => `${i.qty}× ${lineLabel(i)}`).join(", ");

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
  const [tableQ, setTableQ] = useState("");
  // Busy tables only by default; "Show all tables" is remembered on this phone.
  const [showAll, setShowAll] = usePref("tablesShowAll", false);
  const cur = shop.currency || "₹";
  useOrderPolling(5000);

  const orders = allOrders(st);
  // Orders paid online go to the kitchen by themselves: print their KOT once on this device.
  useEffect(() => {
    const fresh = orders.filter((o) => o.acceptedBy === "Online payment" && o.status === "accepted" && Date.now() - new Date(o.acceptedAt || o.updatedAt) < 30 * 60e3);
    if (!fresh.length) return;
    let done = [];
    try {
      done = JSON.parse(localStorage.getItem("kotOnlineDone") || "[]");
    } catch {
      /* none yet */
    }
    const todo = fresh.filter((o) => !done.includes(o.clientId));
    if (!todo.length) return;
    try {
      localStorage.setItem("kotOnlineDone", JSON.stringify([...done, ...todo.map((o) => o.clientId)].slice(-200)));
    } catch {
      /* storage blocked */
    }
    (async () => {
      for (const o of todo) await kot(o);
    })();
  }, [orders]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = orders.filter((o) => o.status === "new");
  const tables = shop.tables || [];
  const qrHours = shop.qrOrdering ? storeOpen(shop.hours, new Date(), shop.closure) : null;
  const byTable = useMemo(() => {
    const m = new Map(tables.map((t) => [t.id, []]));
    for (const o of orders) if (isOpen(o) && o.status !== "new") (m.get(o.table) || m.set(o.table, []).get(o.table)).push(o);
    return m;
  }, [orders, tables]);

  // Big restaurants: search, busy tables first, and a sensible number of tiles at once.
  const shownTables = useMemo(() => {
    let list = tables;
    if (tableQ) list = list.filter((t) => t.name.toLowerCase().includes(tableQ.toLowerCase()));
    // A search looks through every table, so a free one can be found to take an order.
    if (!showAll && !tableQ) list = list.filter((t) => byTable.get(t.id)?.length);
    else if (tables.length > 40) list = [...list.filter((t) => byTable.get(t.id)?.length), ...list.filter((t) => !byTable.get(t.id)?.length)];
    return list;
  }, [tables, tableQ, showAll, byTable]);
  const busyCount = tables.filter((t) => byTable.get(t.id)?.length).length;

  const accept = async (o) => {
    try {
      await setOrderStatus(o, "accepted");
      await kot({ ...o, status: "accepted" });
    } catch (err) {
      toast(err.message);
    }
  };
  // A QR order's payment: confirm (pay-first orders go to the kitchen and print the KOT), reject, refund done.
  const payAction = async (o, action) => {
    try {
      const saved = await orderPayment(o, action);
      if (action === "confirm" && o.status === "new" && saved.status === "accepted") await kot(saved);
      // The paid order is now a saved bill: print it for the customer and the records.
      if (action === "confirm" && saved.bill) {
        try {
          await printBill(shop, saved.bill);
          toast(`₹${saved.pay.amount} confirmed · Bill ${saved.bill.billNo} saved and printed`);
        } catch (err) {
          const msg = explainPrintError(err);
          toast(`Bill ${saved.bill.billNo} saved${msg ? ` (not printed: ${msg})` : ""}. Reprint or share it from Bills.`);
          if (msg && confirm(`Printer not ready. Share bill ${saved.bill.billNo} as PDF instead?`)) await shareBillPdf(shop, saved.bill);
        }
        return;
      }
      toast(action === "confirm" ? `₹${saved.pay.amount} for #${o.orderNo} confirmed` : action === "reject" ? `Told the customer the payment wasn't found` : "Refund noted");
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
            {(user.role === "owner" || user.role === "admin") && <Link className="btn btn-primary" to="/settings/tables">Set up tables</Link>}
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
          {qrHours && !qrHours.open && <span className="tag">{qrHours.closedByHand ? "🔴 Shop closed for QR orders" : `🌙 QR orders closed · opens ${qrHours.opensAt}`}</span>}
          {!st.online && <span className="tag warn">Offline · orders saved on this phone</span>}
          {st.pending.length > 0 && <span className="tag warn">{st.pending.length} to upload</span>}
          <button className="btn" onClick={() => setStockOpen(true)}>🥟 Stock</button>
          <Link className="btn" to="/kitchen">🍳 Kitchen screen</Link>
        </div>
      </div>
      {stockOpen && <StockPanel onClose={() => setStockOpen(false)} />}

      {st.helpRequests.length > 0 && (
        <section className="stack" style={{ marginBottom: 16 }}>
          <h2>Table requests ({st.helpRequests.length})</h2>
          {st.helpRequests.map((r) => (
            <HelpRequest key={r.id} r={r} />
          ))}
        </section>
      )}

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

      {st.orderPay.filter((o) => o.status !== "new" || o.pay.state !== "due").length > 0 && (
        <section className="stack" style={{ marginBottom: 16 }}>
          <h2>Order payments</h2>
          {st.orderPay.filter((o) => o.status !== "new" || o.pay.state !== "due").map((o) => (
            <div key={o.clientId} className={"card order-card " + (o.pay.state === "refundDue" ? "refund" : "new")}>
              {o.pay.state === "refundDue" ? (
                <>
                  <div className="order-top"><b>↩️ Refund {money(o.pay.amount, cur)} · #{o.orderNo} · {o.tableName}</b><span className="small muted">{ago(o.updatedAt)}</span></div>
                  {o.pay.method === "online" ? (
                    <>
                      <div className="small">This order was cancelled after the customer paid online. Send the money back through Cashfree (it reaches them in a few days).</div>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => confirm("Already refunded from the Cashfree dashboard?") && payAction(o, "refunded")}>Refunded already</button>
                        <button className="btn btn-sm btn-primary" onClick={() => payAction(o, "refund-online")}>↩️ Refund via Cashfree</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="small">This order was cancelled after the customer paid{o.pay.state === "refundDue" && o.pay.confirmedAt ? "" : " (check your UPI app first)"}. Give the money back, then mark it.</div>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}><button className="btn btn-sm btn-primary" onClick={() => payAction(o, "refunded")}>Refund done</button></div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="order-top"><b>#{o.orderNo} · {o.tableName} says paid {money(o.pay.amount, cur)} by UPI</b><span className="small muted">{ago(o.pay.claimedAt || o.updatedAt)}</span></div>
                  {o.pay.utr && <div className="small">UPI reference: <b>{o.pay.utr}</b></div>}
                  <div className="small muted">Check your UPI app or soundbox for this amount, then confirm.</div>
                  <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn btn-sm" onClick={() => payAction(o, "reject")}>Not received</button>
                    <button className="btn btn-sm btn-primary" onClick={() => payAction(o, "confirm")}>✅ Received{o.pay.rule === "first" && o.status === "new" ? " → send to kitchen" : ""}</button>
                  </div>
                </>
              )}
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
                {o.customerName && (
                  <div className="small">
                    For <b>{o.customerName}</b>
                    {o.customerPhone && <> · <a href={`tel:${o.customerPhone}`}>📞 {o.customerPhone}</a></>}
                  </div>
                )}
                <ul className="order-items">
                  {o.items.map((i, k) => (
                    <li key={k}>
                      <b>{i.qty}×</b> {i.name}{i.variant ? ` (${i.variant})` : ""}
                      {i.addons?.length > 0 && <div className="small">+ {addonText(i.addons)}</div>}
                      {i.note && <div className="small muted">↳ {i.note}</div>}
                    </li>
                  ))}
                </ul>
                {o.note && <div className="small">📝 {o.note}</div>}
                <CustomerInstructions o={o} />
                <PayChip o={o} cur={cur} />
                <div className="order-top">
                  <b>{money(o.total, cur)}</b>
                  <div className="btn-row">
                    <button className="btn btn-sm btn-danger" onClick={() => reject(o)}>Reject</button>
                    {o.pay?.rule === "first" && o.pay.state !== "paid" ? (
                      <button className="btn btn-sm btn-primary" onClick={() => payAction(o, "confirm")}>
                        {o.pay.state === "claimed" ? "✅ UPI received" : "💵 Cash received"} → send to kitchen
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-primary" onClick={() => accept(o)}>Accept &amp; send to kitchen</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 style={{ marginBottom: 8 }}>{showAll ? "All tables" : `Busy tables (${busyCount})`}</h2>
      {tables.length > 0 && (
        <div className="table-tools">
          <input className="input" type="search" placeholder="Find a table" value={tableQ} onChange={(e) => setTableQ(e.target.value)} />
          <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all tables ({tables.length})</label>
        </div>
      )}
      {!shownTables.length && tables.length > 0 && (
        <div className="empty">
          {tableQ ? "No table with that name." : <>No busy tables right now. <button className="link-btn" onClick={() => setShowAll(true)}>Show all tables</button> to take an order.</>}
        </div>
      )}
      <div className="table-grid">
        {shownTables.slice(0, 200).map((t) => {
          const list = byTable.get(t.id) || [];
          const total = list.reduce((s, o) => s + (o.total || 0), 0);
          const ready = list.some((o) => o.status === "ready");
          const since = list[0]?.createdAt;
          const billReq = list.find((o) => o.billRequest)?.billRequest;
          const who = list.find((o) => o.customerName);
          return (
            <button key={t.id} className={"table-tile" + (list.length ? (ready ? " ready" : " busy") : "") + (billReq ? " wants-bill" : "")} onClick={() => setTableId(t.id)}>
              <b>{t.name}</b>
              {list.length ? (
                <>
                  <span>{money(total, cur)}</span>
                  <span className="small">{list.length} order{list.length === 1 ? "" : "s"} · {ago(since)}</span>
                  {who && <span className="small table-who">👤 {who.customerName}</span>}
                  {ready && <span className="tag good">food ready</span>}
                  {billReq && <span className="tag warn">🧾 Bill · {billReq.method === "upi" ? "UPI" : billReq.method === "paid" ? "all paid ✓" : "Counter"}</span>}
                </>
              ) : (
                <span className="small muted">Free</span>
              )}
            </button>
          );
        })}
      </div>
      {shownTables.length > 200 && <p className="small muted">Showing 200 of {shownTables.length} tables (busy ones first). Search to find the others.</p>}

      {openTable && (
        <TableSheet
          table={openTable}
          orders={byTable.get(openTable.id) || []}
          cur={cur}
          onClose={() => setTableId(null)}
          onAdd={() => (setAdding(openTable), setTableId(null))}
          onReprint={(o) => kot(o, { force: true, reprint: true })}
          onBill={isKitchen ? null : (list) => {
            const req = list.find((o) => o.billRequest)?.billRequest;
            // Orders paid while ordering already have their own bill: they're closed with the table, not billed again.
            const billed = list.filter((o) => o.billClientId);
            const toBill = list.filter((o) => !o.billClientId);
            if (!toBill.length) return;
            const lines = new Map();
            for (const o of toBill)
              for (const i of o.items) {
                const k = `${i.itemId || i.name}|${i.variant || ""}|${i.rate}|${addonText(i.addons)}`;
                const l = lines.get(k);
                lines.set(k, l ? { ...l, qty: l.qty + i.qty } : { itemId: i.itemId || i.name, name: i.name, variant: i.variant || "", category: i.category || "", rate: i.rate, qty: i.qty, ...(i.addons?.length && { addons: i.addons }), ...(i.charge && { charge: true }), ...(i.free && { free: i.free }) });
              }
            // Orders paid but without their own bill (older ones) come off what's left to collect.
            const paid = toBill.filter((o) => o.pay?.state === "paid");
            const claimed = toBill.filter((o) => o.pay?.state === "claimed");
            if (claimed.length && !confirm(`${claimed.map((o) => `#${o.orderNo}`).join(", ")} say they paid by UPI but it isn't confirmed yet. Bill anyway? (It will be collected again unless you confirm it first.)`)) return;
            nav("/", {
              state: {
                tableBill: {
                  table: openTable.id,
                  tableName: openTable.name,
                  orderIds: list.map((o) => o.clientId),
                  orderNos: toBill.map((o) => o.orderNo),
                  lines: [...lines.values()],
                  payMode: req?.method === "upi" || req?.method === "paid" ? "upi" : req ? "cash" : undefined,
                  customer: toBill.find((o) => o.customer)?.customer || billed.find((o) => o.customer)?.customer || null,
                  prepaid: Math.round(paid.reduce((s, o) => s + (o.pay.amount || 0), 0) * 100) / 100,
                  // Promo codes customers used on these orders become the bill's discount.
                  promo: toBill.some((o) => o.promo?.amount > 0)
                    ? { code: [...new Set(toBill.filter((o) => o.promo).map((o) => o.promo.code))].join(", "), amount: Math.round(toBill.reduce((s, o) => s + (o.promo?.amount || 0), 0) * 100) / 100 }
                    : null,
                  prepaidOrderNos: paid.map((o) => o.orderNo),
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

// Who ordered at this table (QR customers), with a tap-to-call number.
function TableContacts({ orders }) {
  const seen = new Map();
  for (const o of orders) if (o.customerName || o.customerPhone) seen.set(o.customerPhone || o.customerName, o);
  if (!seen.size) return null;
  return (
    <div className="table-contacts">
      {[...seen.values()].map((o) => (
        <div key={o.clientId} className="order-top">
          <span>👤 <b>{o.customerName || "Customer"}</b></span>
          {o.customerPhone && <a className="btn btn-sm" href={`tel:${o.customerPhone}`}>📞 {o.customerPhone.replace(/(\d{5})(\d{5})/, "$1 $2")}</a>}
        </div>
      ))}
    </div>
  );
}

function TableSheet({ table, orders, cur, onClose, onAdd, onBill, onReprint }) {
  const toast = useToast();
  const unbilled = orders.filter((o) => !o.billClientId);
  const total = unbilled.reduce((s, o) => s + (o.total || 0), 0);
  const allPaid = orders.length > 0 && !unbilled.length;
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
            🧾 {orders.find((o) => o.billRequest).billRequest.method === "paid"
              ? "The customers have paid their orders and are leaving. Bill the table to close it."
              : `The customer asked for the bill · will pay ${orders.find((o) => o.billRequest).billRequest.method === "upi" ? "online by UPI" : "at the counter"}`}
          </div>
        )}
        <TableContacts orders={orders} />
        {orders.map((o) => (
          <div key={o.clientId} className="order-line">
            <div className="order-top">
              <span>
                <b>#{o.orderNo}</b> <span className={"tag " + STATUS_TAG[o.status]}>{STATUS_LABEL[o.status]}</span>
                {(o.pending || o.statusPending) && <span className="tag warn" style={{ marginLeft: 4 }}>not uploaded</span>}
              </span>
              <span className="small muted">{o.source === "qr" ? "QR" : "Staff"} · {ago(o.createdAt)} · {money(o.total, cur)}</span>
            </div>
            {o.customerName && <div className="small muted">For {o.customerName}</div>}
            <div className="small">{itemsText(o)}</div>
            <PayChip o={o} cur={cur} />
            <div className="btn-row">
              {o.status !== "served" && <button className="btn btn-sm" onClick={() => move(o, "served")}>Mark served</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => onReprint(o)}>🖨️ Reprint KOT</button>
            </div>
          </div>
        ))}
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <button className="btn" onClick={onAdd}>+ Add order</button>
          {onBill && !allPaid && orders.length > 0 && (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                if (!confirm(`${table.name} left without paying? Its unpaid orders will be closed as unpaid (not counted as sales).`)) return;
                try {
                  const r = await leftUnpaid(table.id);
                  toast(`${table.name} closed as unpaid`);
                  for (const c of r.customers) {
                    if (c.blocked) toast(`${c.name} must now pay online (left without paying ${c.unpaidCount}×)`);
                    else if (confirm(`${c.name} (${c.phone}) has left without paying ${c.unpaidCount} time${c.unpaidCount === 1 ? "" : "s"}. Make them pay before their food is cooked from now on?`)) {
                      await put(`/customers/${c.id}/pay-later`, { blocked: true });
                      toast(`${c.name} must now pay first`);
                    }
                  }
                  onClose();
                } catch (e) {
                  toast(e.message);
                }
              }}
            >
              🚫 Left without paying
            </button>
          )}
          {onBill &&
            (allPaid ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  const cooking = orders.filter((o) => o.status !== "served");
                  if (cooking.length && !confirm(`${cooking.map((o) => `#${o.orderNo}`).join(", ")} ${cooking.length === 1 ? "isn't" : "aren't"} served yet. Closing removes ${cooking.length === 1 ? "it" : "them"} from the kitchen screen. Close anyway?`)) return;
                  closeTable(table.id).then(() => (toast(`${table.name} closed`), onClose()), (e) => toast(e.message));
                }}
              >
                Everything is paid ✓ · Close table
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!orders.length} onClick={() => onBill(orders)}>
                Bill {table.name} · {money(total, cur)}
              </button>
            ))}
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
  // Far tables (a table group): their own prices, and a delivery charge unless it's picked up.
  const group = groupOf(shop, table.id);
  const priceOf = (m, v) => groupPrice(group, m.id, v.label || "", v.price);
  const [pickup, setPickup] = useState(false);
  const active = menu.filter((m) => m.active !== false);
  const cats = ["All", ...new Set(active.map((m) => m.category || "Other"))];
  const shown = active.filter((m) => (cat === "All" || (m.category || "Other") === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const [custom, setCustom] = useState(null); // { m, v }: picking add-ons for this dish and size
  const groupsOf = (m) => addonGroupsFor(shop.addonGroups, m);
  const qtyOf = (m, v) => [...lines.values()].filter((l) => l.itemId === m.id && l.variant === (v.label || "")).reduce((s, l) => s + l.qty, 0);
  // One line per dish, size and add-ons; the rate includes the add-ons.
  const addLine = (m, v, picked, d) =>
    setLines((prev) => {
      const k = `${m.id}|${v.label || ""}|${addonKey(picked.map((a) => a.id))}`;
      const next = new Map(prev);
      const qty = (next.get(k)?.qty || 0) + d;
      const addons = picked.map(({ name, price }) => ({ name, price }));
      if (qty <= 0) next.delete(k);
      else next.set(k, { key: k, itemId: m.id, name: m.name, variant: v.label || "", category: m.category || "", rate: priceOf(m, v) + addonsTotal(addons), qty: Math.min(qty, 99), note: next.get(k)?.note || "", ...(addons.length && { addons }) });
      return next;
    });
  const add = (m, v, d) => {
    if (d > 0 && m.soldOut && !qtyOf(m, v) && !confirm(`${m.name} is marked sold out. Add it anyway?`)) return;
    if (d > 0 && groupsOf(m).length) return setCustom({ m, v });
    if (d < 0) {
      const of = [...lines.values()].filter((l) => l.itemId === m.id && l.variant === (v.label || ""));
      if (of.length > 1) return toast("Take it off in the list below (it has different add-ons).");
      if (of[0]) return setLines((prev) => {
        const next = new Map(prev);
        if (of[0].qty <= 1) next.delete(of[0].key);
        else next.set(of[0].key, { ...of[0], qty: of[0].qty - 1 });
        return next;
      });
      return;
    }
    addLine(m, v, [], d);
  };
  const list = [...lines.values()];
  const food = list.reduce((s, l) => s + l.qty * l.rate, 0);
  const delivery = pickup ? null : deliveryLine(group, food);
  const total = food + (delivery?.rate || 0);
  const place = async () => {
    setBusy(true);
    try {
      onPlaced(await createStaffOrder({ table: table.id, tableName: table.name, items: delivery ? [...list, delivery] : list, note }));
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
              const n = qtyOf(m, v);
              return (
                <div key={m.id + v.label} className={"picker-row" + (m.soldOut ? " out" : "")}>
                  <ItemPicture item={m} size={36} />
                  <span className="picker-name">
                    {m.name}{v.label ? ` (${v.label})` : ""}<span className="small muted"> {money(priceOf(m, v), cur)}</span>
                    {groupsOf(m).length > 0 && <span className="small muted"> · 🧀 add-ons</span>}
                    {!servedAt(m, table.id) && <span className="tag" style={{ marginLeft: 4 }}>not for this table</span>}
                    {m.soldOut ? <span className="tag bad" style={{ marginLeft: 4 }}>sold out</span> : typeof m.stock === "number" && <span className="tag warn" style={{ marginLeft: 4 }}>{m.stock} left</span>}
                  </span>
                  <div className="qty">
                    <button onClick={() => add(m, v, -1)} disabled={!n} aria-label="Less">−</button>
                    <span className="picker-qty">{n}</span>
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
              <div key={l.key} className="order-top">
                <span className="small">
                  <b>{l.qty}×</b> {lineLabel(l)}
                  {l.addons?.length > 0 && <button className="link-btn" style={{ marginLeft: 6 }} onClick={() => setLines((prev) => { const next = new Map(prev); next.delete(l.key); return next; })} aria-label={`Remove ${lineLabel(l)}`}>✕</button>}
                </span>
                <input
                  className="input"
                  style={{ maxWidth: 180, padding: "4px 8px", fontSize: 13 }}
                  placeholder="Kitchen note"
                  maxLength={80}
                  value={l.note}
                  onChange={(e) => setLines((prev) => new Map(prev).set(l.key, { ...l, note: e.target.value }))}
                />
              </div>
            ))}
            <input className="input" placeholder="Note for the whole order (optional)" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} />
            {group?.delivery?.charge > 0 && (
              <div className="order-top small">
                <span>🛵 {group.name}: {delivery ? `delivery charge ${money(delivery.rate, cur)}` : pickup ? "no delivery charge (picked up)" : "free delivery"}</span>
                <label className="check small"><input type="checkbox" checked={pickup} onChange={(e) => setPickup(e.target.checked)} /> Picked up</label>
              </div>
            )}
          </div>
        )}
        {custom && (
          <Customize
            m={{ ...custom.m, variants: [{ ...custom.v, price: priceOf(custom.m, custom.v) }], addons: groupsOf(custom.m) }}
            cur={cur}
            onClose={() => setCustom(null)}
            onAdd={({ addonIds, qty }) => {
              const picked = groupsOf(custom.m).flatMap((g) => g.options.filter((o) => addonIds.includes(o.id)));
              addLine(custom.m, custom.v, picked, qty);
              setCustom(null);
            }}
          />
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

// A customer asking from their table: quick replies, a typed reply, or done.
function HelpRequest({ r }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (body) => {
    setBusy(true);
    try {
      await answerHelp(r, body);
      setText("");
      if (body.done) toast(`${r.tableName}: done ✓`);
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const [icon] = HELP_ASKS[r.kind] || ["💬"];
  return (
    <div className={"card order-card help-req" + (r.status === "open" ? " new" : "")}>
      <div className="order-top">
        <b>{icon} {r.tableName}{r.name ? ` · ${r.name}` : ""}</b>
        <span className="small muted">{ago(r.createdAt)}{r.count > 1 ? ` · asked ${r.count}×` : ""}</span>
      </div>
      <div className="help-req-text">{helpText(r)}</div>
      {r.reply && <div className="small muted">↳ {r.repliedBy || "Staff"}: {r.reply}</div>}
      <div className="btn-row">
        {r.status === "open" && QUICK_REPLIES.map((q) => <button key={q} className="btn btn-sm" disabled={busy} onClick={() => act({ reply: q })}>{q}</button>)}
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act({ done: true })}>Done ✓</button>
      </div>
      {r.kind === "question" && r.status === "open" && (
        <form className="inline" onSubmit={(e) => (e.preventDefault(), text.trim() && act({ reply: text.trim() }))}>
          <input className="input" placeholder="Type a reply…" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-sm" disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}

// How a QR order is being paid, for staff.
function PayChip({ o, cur }) {
  const p = o.pay;
  const promo = (
    <>
      {o.promo?.amount > 0 && <span className="tag">🏷 {o.promo.code} −{money(o.promo.amount, cur)}</span>}
      {p?.payLater === false && p.state !== "paid" && <span className="tag warn">⚠️ Must pay first</span>}
      {p?.mismatch && p.state !== "paid" && <span className="tag bad">⚠️ Online amount didn't match: check Cashfree</span>}
      {p?.failedAt && !["paid", "refundDue", "refunded"].includes(p.state) && <span className="tag">Online payment failed</span>}
    </>
  );
  const hasExtra = o.promo?.amount > 0 || p?.payLater === false || p?.mismatch || p?.failedAt;
  if (!p || p.rule === "end" || (p.state === "end" && p.rule !== "choose")) return hasExtra ? <div className="pay-chip-row">{promo}</div> : null;
  const amt = money(p.amount ?? o.total, cur);
  const [cls, text] = {
    paid: ["good", `💳 Paid ${amt}${p.method === "counter" ? " (counter)" : p.method === "online" ? " online ✓" : ""}`],
    claimed: ["warn", `⏳ Says paid ${amt} by UPI`],
    due: ["bad", p.method === "counter" ? `🕒 Will pay ${amt} at the counter` : `🕒 Waiting for payment ${amt}`],
    choose: ["", "Not paid yet"],
    end: ["", "Pays at the end"],
    refundDue: ["bad", `↩️ Refund ${amt}`],
    refunded: ["", `↩️ Refunded ${amt}`],
  }[p.state] || ["", ""];
  return text || hasExtra ? <div className="pay-chip-row">{text && <span className={"tag " + cls}>{text}</span>}{promo}</div> : null;
}

// What the customer added after the order was accepted (QR page › My orders), marked NEW for 10 minutes.
export function CustomerInstructions({ o, kitchen = false }) {
  const ins = o.instructions;
  if (!ins?.cooking && !ins?.delivery) return null;
  const fresh = ins.at && Date.now() - new Date(ins.at).getTime() < 10 * 60e3;
  return (
    <div className={"cust-ins" + (kitchen ? " big" : "")}>
      {fresh && <span className="tag warn">NEW</span>}
      {ins.cooking && <div>👨‍🍳 <b>Cooking:</b> {ins.cooking}</div>}
      {ins.delivery && <div>🛵 <b>Delivery:</b> {ins.delivery}</div>}
    </div>
  );
}
