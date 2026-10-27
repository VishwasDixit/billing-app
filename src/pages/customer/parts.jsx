// The customer page's order pieces: review sheet, paying for an order (Cashfree, UPI, counter),
// and the table's bill. Moved here unchanged from CustomerOrder.jsx.
import { useEffect, useState } from "react";
import { post } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { qrSvg } from "../../../shared/billQr.js";
import { lineKey, couponNudge } from "./common.js";
import { deliveryLine, freeDeliveryGap } from "../../../shared/tableGroups.js";

export function Review({ token, table, lines, cur, total, setNote, onClose, onPlaced, payRule, offers, initialCode, delivery = null }) {
  const [note, setOrderNote] = useState("");
  // Name and mobile are needed to order; remembered on this phone for next time.
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem("coContact") || "{}");
    } catch {
      return {};
    }
  })();
  const [name, setName] = useState(saved.name || "");
  const [phone, setPhone] = useState(saved.phone || "");
  const mobile = phone.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  const contactOk = name.trim().length >= 2 && /^[6-9]\d{9}$/.test(mobile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Promo code: checked by the server with its own prices (and this mobile, for once-per-mobile codes).
  const [code, setCode] = useState(initialCode || "");
  const [promo, setPromo] = useState(null); // { code, amount }
  const [promoErr, setPromoErr] = useState("");
  const [checking, setChecking] = useState(false);
  const items = lines.map((l) => ({ itemId: l.itemId, variant: l.variant, qty: l.qty, note: l.note }));
  const applyCode = async (c = code) => {
    c = c.trim().toUpperCase();
    if (!c) return;
    setChecking(true);
    setPromoErr("");
    try {
      const r = await post(`/public/shop/${token}/promo`, { code: c, items, phone: mobile, table: table.id });
      setPromo({ code: r.code, amount: r.amount });
      setCode(r.code);
    } catch (err) {
      setPromo(null);
      setPromoErr(err.offline ? "No internet on this phone. Please try again." : err.message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (initialCode) applyCode(initialCode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Far tables: a delivery charge on smaller orders (the server adds the same line).
  const charge = deliveryLine({ delivery }, total)?.rate || 0;
  const gap = freeDeliveryGap({ delivery }, total);
  const toPay = Math.max(0, total - (promo?.amount || 0)) + charge;
  const place = async () => {
    if (!contactOk) return setError(name.trim().length < 2 ? "Please enter your name." : "Please enter a 10-digit mobile number.");
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("coContact", JSON.stringify({ name: name.trim(), phone: mobile }));
    } catch {
      /* private mode */
    }
    try {
      const r = await post(`/public/shop/${token}/orders`, {
        table: table.id,
        items,
        note,
        name: name.trim(),
        phone: mobile,
        ...(promo && { promo: promo.code }),
      });
      onPlaced({ id: r.orderId, key: r.key, orderNo: r.orderNo, total: r.total, status: r.status, pay: r.pay, promo: r.promo || null, tableName: table.name, items: lines, createdAt: new Date().toISOString() });
    } catch (err) {
      // The code stopped working (used up, wrong time, used on this mobile): say so and let them order without it.
      if (err.data?.code === "PROMO") {
        setPromo(null);
        setPromoErr(err.message);
        setError("");
      } else setError(err.offline ? "No internet on this phone. Please try again, or order with the staff." : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="co-sheet">
        <div className="co-order-head">
          <b>Your order · {table.name}</b>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Edit</button>
        </div>
        {lines.map((l) => (
          <div key={lineKey(l.itemId, l.variant)} className="co-line">
            <div className="co-line-top">
              <span>{l.qty}× {l.name}{l.variant ? ` (${l.variant})` : ""}</span>
              <span>{money(l.qty * l.rate, cur)}</span>
            </div>
            <input className="input" placeholder="Note for the kitchen (e.g. less spicy)" maxLength={80} value={l.note} onChange={(e) => setNote(lineKey(l.itemId, l.variant), e.target.value)} />
          </div>
        ))}
        <input className="input" placeholder="Any other request (optional)" maxLength={160} value={note} onChange={(e) => setOrderNote(e.target.value)} />
        <div className="co-contact">
          <input className="input" placeholder="Your name *" autoComplete="name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="input" placeholder="Mobile number *" type="tel" inputMode="tel" autoComplete="tel" maxLength={16} value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <span className="small muted">So the restaurant can reach you about your order.</span>
        </div>
        <div className="co-promo">
          {promo ? (
            <div className="co-line-top">
              <span>🏷 <b>{promo.code}</b> applied</span>
              <span>−{money(promo.amount, cur)} <button className="link-btn" onClick={() => (setPromo(null), setCode(""))}>Remove</button></span>
            </div>
          ) : (
            <form className="co-promo-row" onSubmit={(e) => (e.preventDefault(), applyCode())}>
              <input className="input" placeholder="Have a promo code?" autoCapitalize="characters" maxLength={20} value={code} onChange={(e) => (setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")), setPromoErr(""))} />
              <button className="btn" disabled={!code || checking}>{checking ? "…" : "Apply"}</button>
            </form>
          )}
          {!promo && !code && offers.length > 0 && (
            <div className="chips">
              {offers.map((o) => (
                <button key={o.code} className="chip" onClick={() => applyCode(o.code)}>🏷 {o.code}</button>
              ))}
            </div>
          )}
          {promoErr && <div className="error small">{promoErr}</div>}
          {!promo && (() => {
            const n = couponNudge(offers, total);
            if (!n) return null;
            return n.unlocked ? (
              <button className="co-nudge done link-btn" onClick={() => applyCode(n.offer.code)}>🎉 {n.offer.code} unlocked: tap to apply</button>
            ) : (
              <div className="co-nudge">
                <span>Add <b>{money(Math.ceil(n.short), cur)}</b> more to use <b>{n.offer.code}</b>{n.offer.description ? ` · ${n.offer.description}` : ""}</span>
                <i className="co-nudge-bar"><i style={{ width: `${Math.round(n.progress * 100)}%` }} /></i>
              </div>
            );
          })()}
        </div>
        {(promo || delivery) && <div className="co-line-top small muted"><span>Items</span><span>{money(total, cur)}</span></div>}
        {delivery && (
          <div className="co-line-top small muted">
            <span>🛵 Delivery charge</span>
            <span>{charge ? money(charge, cur) : "Free"}</span>
          </div>
        )}
        {gap > 0 && (
          <div className="co-nudge">
            <span>🛵 Add <b>{money(Math.ceil(gap), cur)}</b> more for <b>free delivery</b> · <button className="link-btn" onClick={onClose}>Add more</button></span>
          </div>
        )}
        <div className="co-line-top"><b>Total</b><b>{money(toPay, cur)}</b></div>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy || !contactOk} onClick={place}>{busy ? "Sending…" : "Place order"}</button>
        <p className="small muted" style={{ margin: 0, textAlign: "center" }}>
          {payRule === "first" ? "Please pay after placing the order. It's cooked once the payment is confirmed." : payRule === "choose" ? "You can pay now by UPI, or at the end." : "You pay after your meal."}
        </p>
      </div>
    </div>
  );
}

const upiLinkFor = (upi, amount, note) =>
  "upi://pay?" +
  new URLSearchParams({ pa: upi.id, pn: upi.name.slice(0, 40), am: Number(amount).toFixed(2), cu: "INR", tn: note })
    .toString()
    .replace(/\+/g, "%20");

// One button per UPI app. The plain upi:// link lets the phone pick, and phones often stick to one
// app (WhatsApp, or on iPhone whichever installed last), so each app gets its own button.
const isIOS = () => !/Android/i.test(navigator.userAgent) && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
function upiApps(link) {
  const q = link.slice(link.indexOf("?") + 1);
  return [
    { id: "gpay", label: "Google Pay", icon: "🟢", href: `${isIOS() ? "gpay" : "tez"}://upi/pay?${q}` },
    { id: "phonepe", label: "PhonePe", icon: "🟣", href: `phonepe://pay?${q}` },
    { id: "paytm", label: "Paytm", icon: "🔵", href: `paytmmp://pay?${q}` },
    { id: "other", label: "Other UPI app", icon: "📱", href: link },
  ];
}

function PayWithApps({ link, amount, upiId }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(upiId).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 2000)),
      () => {}
    );
  return (
    <div className="stack">
      <div className="small"><b>Pay {amount} with</b></div>
      <div className="upi-apps">
        {upiApps(link).map((a) => (
          <a key={a.id} className={"upi-app " + a.id} href={a.href}>
            <span aria-hidden="true">{a.icon}</span>
            {a.label}
          </a>
        ))}
      </div>
      <div className="small muted">Nothing opened? Try another app, scan the QR, or pay to the UPI ID.</div>
      <details className="small">
        <summary>Paying from another phone? Show QR</summary>
        <div className="co-qr" dangerouslySetInnerHTML={{ __html: qrSvg(link, 200) }} />
      </details>
      {upiId && (
        <button type="button" className="btn btn-sm btn-ghost upi-copy" onClick={copy}>
          {copied ? "✓ Copied" : `📋 Copy UPI ID · ${upiId}`}
        </button>
      )}
    </div>
  );
}

// Paying for one order while ordering (when the shop allows it): UPI now, at the counter, or at the end.
// Cashfree's checkout script, loaded only when someone pays online.
function loadCashfree() {
  if (window.Cashfree) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't open the payment page. Check the internet and try again."));
    document.head.appendChild(s);
  });
}

export function OrderPay({ token, order, cur, upiOn, onlineOn, onChange }) {
  const p = order.pay;
  const [open, setOpen] = useState(false);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!p || p.rule === "end") return null;
  if (["rejected", "billed"].includes(order.status) && !["refundDue", "refunded"].includes(p.state)) return null;
  const amount = money(p.amount ?? order.total, cur);
  const send = async (method) => {
    setBusy(true);
    setError("");
    try {
      await post(`/public/shop/${token}/orders/${order.id}/pay`, { key: order.key, method, utr });
      setOpen(false);
      await onChange();
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again." : err.message);
    } finally {
      setBusy(false);
    }
  };
  const online = onlineOn || order.online;
  const laterOk = order.laterOk ?? p.payLater !== false;
  // Opens Cashfree's payment page; it comes back to this page, which then checks the result.
  const payOnline = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await post(`/public/shop/${token}/orders/${order.id}/pay-online`, { key: order.key });
      if (!r.paymentSessionId) return await onChange();
      await loadCashfree();
      await window.Cashfree({ mode: r.mode }).checkout({ paymentSessionId: r.paymentSessionId, redirectTarget: "_self" });
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again." : err.message);
      setBusy(false);
    }
  };
  const link = order.upi && upiLinkFor(order.upi, p.amount ?? order.total, `Order #${order.orderNo} · ${order.tableName}`);
  if (p.state === "paid")
    return (
      <div className="co-pay paid">
        ✅ Paid {amount}{p.method === "counter" ? " at the counter" : p.method === "online" ? " online" : ""}{order.bill ? ` · Bill ${order.bill.billNo}` : ""}
        {order.bill && (
          <details className="small co-mini-bill">
            <summary>See bill</summary>
            {order.bill.items.map((i, k) => (
              <div key={k} className="co-line-top"><span>{i.qty}× {i.name}{i.variant ? ` (${i.variant})` : ""}</span><span>{money(i.amount, cur)}</span></div>
            ))}
            {order.bill.discount?.amount > 0 && <div className="co-line-top"><span>{order.promo ? `Promo ${order.promo.code}` : "Discount"}</span><span>−{money(order.bill.discount.amount, cur)}</span></div>}
            {order.bill.gst?.amount > 0 && <div className="co-line-top"><span>GST</span><span>{money(order.bill.gst.amount, cur)}</span></div>}
            <div className="co-line-top"><b>Total</b><b>{money(order.bill.total, cur)}</b></div>
          </details>
        )}
      </div>
    );
  if (p.state === "claimed") return <div className="co-pay wait">⏳ Thanks! Waiting for the staff to confirm your {amount}.</div>;
  if (p.state === "refundDue") return <div className="co-pay wait">↩️ This order was cancelled. The shop will return your {amount}.</div>;
  if (p.state === "refunded") return <div className="co-pay">↩️ {amount} returned to you.</div>;
  if (p.state === "end") {
    return (
      <div className="co-pay small">
        You'll pay at the end.{" "}
        {p.rule === "choose" && online && <button className="link-btn" disabled={busy} onClick={payOnline}>Pay now online instead</button>}
        {p.rule === "choose" && !online && upiOn && <button className="link-btn" onClick={() => setOpen(true)}>Pay now instead</button>}
        {error && <div className="error small">{error}</div>}
        {open && <UpiPanel link={link} upiId={order.upi?.id} amount={amount} utr={utr} setUtr={setUtr} busy={busy} error={error} onPaid={() => send("upi")} />}
      </div>
    );
  }
  // choose (not decided) or due (pay first)
  return (
    <div className="co-pay stack">
      {p.notReceived && <div className="error small">The staff couldn't find your payment. Please pay again or pay at the counter.</div>}
      {p.failed && <div className="error small">❌ Your payment didn't go through. No money was taken. Please try again{laterOk && p.state === "choose" ? ", or pay at the end" : ""}.</div>}
      {p.payLater === false && p.state === "due" && !p.failed && <div className="small muted">This order needs to be paid before it's cooked.</div>}
      {p.state === "due" && <b className="small">💳 Please pay {amount} to send this order to the kitchen.</b>}
      {p.state === "due" && p.method === "counter" && <div className="small">💵 Pay {amount} at the counter. Your order is cooked once the staff confirm it.</div>}
      {online && <button className="btn btn-primary" disabled={busy} onClick={payOnline}>{busy ? "Opening payment…" : `💳 Pay ${amount} online`}</button>}
      {online && <div className="small muted" style={{ textAlign: "center" }}>UPI, cards, netbanking or wallets · secured by Cashfree</div>}
      {!online && upiOn && link && !open && <button className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>📱 Pay {amount} now (UPI)</button>}
      {open && <UpiPanel link={link} upiId={order.upi?.id} amount={amount} utr={utr} setUtr={setUtr} busy={busy} error={error} onPaid={() => send("upi")} />}
      <div className="btn-row">
        {p.state === "due" && p.method !== "counter" && <button className="btn btn-sm" disabled={busy} onClick={() => send("counter")}>💵 Pay at the counter</button>}
        {p.state === "choose" && laterOk && <button className="btn btn-sm" disabled={busy} onClick={() => send("end")}>Pay at the end</button>}
      </div>
      {!open && error && <div className="error small">{error}</div>}
    </div>
  );
}

function UpiPanel({ link, upiId, amount, utr, setUtr, busy, error, onPaid }) {
  return (
    <div className="stack co-upi">
      <PayWithApps link={link} amount={amount} upiId={upiId} />
      <input className="input" placeholder="UPI reference no. (optional)" maxLength={30} value={utr} onChange={(e) => setUtr(e.target.value.replace(/\s/g, ""))} />
      {error && <div className="error small">{error}</div>}
      <button className="btn" disabled={busy} onClick={onPaid}>{busy ? "Sending…" : "✔️ I have paid"}</button>
    </div>
  );
}

// The table's bill on the customer's phone: ask for it, see it, pay by UPI or at the counter.
export function BillBox({ token, mine, cur, onAsk, onChange }) {
  const latest = [...mine].reverse();
  const withBill = latest.find((o) => o.bill);
  const open = latest.filter((o) => ["accepted", "preparing", "ready", "served"].includes(o.status));
  const request = open.find((o) => o.billRequest)?.billRequest;
  if (withBill && !open.length) return <BillCard token={token} order={withBill} cur={cur} onChange={onChange} />;
  if (!open.length) return null;
  // Orders already paid while ordering (or paid and waiting for the staff to confirm).
  const isPaid = (o) => ["paid", "claimed"].includes(o.pay?.state);
  const paid = open.filter(isPaid);
  const due = open.filter((o) => !isPaid(o));
  const paidSum = paid.reduce((s, o) => s + (o.pay?.amount ?? o.total), 0);
  const dueSum = due.reduce((s, o) => s + o.total, 0);
  if (!due.length) {
    const waiting = paid.some((o) => o.pay?.state === "claimed");
    return (
      <div className="card co-bill-ask done">
        <b>✅ Your orders are paid ({money(paidSum, cur)})</b>
        <div className="small">
          {waiting ? "The staff are confirming your payment. " : ""}Nothing more to pay.{" "}
          {request ? "The staff will close your table. Thank you!" : "When you're done, let the staff know you're leaving."}
        </div>
        {!request && <button className="btn btn-sm" onClick={() => onAsk("paid")}>👋 We're done, close our table</button>}
      </div>
    );
  }
  if (request) {
    return (
      <div className="card co-bill-ask done">
        <b>🧾 Bill requested</b>
        <div className="small">
          {paidSum > 0 && `${money(paidSum, cur)} already paid. `}
          {request.method === "upi" ? `You'll pay the rest${paidSum ? "" : ` (${money(dueSum, cur)})`} online by UPI.` : `You'll pay the rest at the cash counter.`} The staff is preparing your bill; it will appear here.
        </div>
      </div>
    );
  }
  return (
    <button className="btn btn-lg co-bill-btn" onClick={() => onAsk()}>
      🧾 Get the bill{paidSum > 0 ? ` · ${money(dueSum, cur)} left to pay` : ""}
    </button>
  );
}

export function BillAsk({ token, mine, onClose, onDone }) {
  const o = [...mine].reverse().find((x) => ["accepted", "preparing", "ready", "served"].includes(x.status));
  const openMine = mine.filter((x) => ["accepted", "preparing", "ready", "served"].includes(x.status));
  const paidSum = openMine.filter((x) => ["paid", "claimed"].includes(x.pay?.state)).reduce((s, x) => s + (x.pay?.amount ?? x.total), 0);
  const dueSum = openMine.filter((x) => !["paid", "claimed"].includes(x.pay?.state)).reduce((s, x) => s + x.total, 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ask = async (method) => {
    setBusy(true);
    setError("");
    try {
      await post(`/public/shop/${token}/bill-request`, { orderId: o.id, key: o.key, method });
      await onDone();
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again or ask the staff." : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="co-sheet">
        <b>How would you like to pay?</b>
        {dueSum > 0 && paidSum > 0 && <div className="small muted">{money(paidSum, "₹")} is already paid · {money(dueSum, "₹")} left</div>}
        {o?.upi && (
          <button className="pay-method main" disabled={busy} onClick={() => ask("upi")}>
            <span className="pm-icon">📱</span>
            <span><b>Pay online (UPI)</b><small>GPay, PhonePe, Paytm or any UPI app, right from your phone</small></span>
          </button>
        )}
        <button className="pay-method" disabled={busy} onClick={() => ask("counter")}>
          <span className="pm-icon">💵</span>
          <span><b>Pay at cash counter</b><small>Cash, card or UPI at the counter</small></span>
        </button>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-ghost" onClick={onClose}>Not yet</button>
      </div>
    </div>
  );
}

export function BillCard({ token, order, cur, onChange }) {
  const b = order.bill;
  const prepaid = b.prepaid || 0;
  const balance = Math.max(0, Math.round((b.total - prepaid) * 100) / 100);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upiLink =
    order.upi &&
    "upi://pay?" +
      new URLSearchParams({ pa: order.upi.id, pn: order.upi.name.slice(0, 40), am: Number(balance).toFixed(2), cu: "INR", tn: `Bill ${b.billNo}` })
        .toString()
        .replace(/\+/g, "%20");
  const paidClaim = async () => {
    setBusy(true);
    setError("");
    try {
      await post(`/public/shop/${token}/bills/${b.id}/paid`, { orderId: order.id, key: order.key, utr });
      await onChange();
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again." : err.message);
    } finally {
      setBusy(false);
    }
  };
  const upi = b.paymentMode === "upi";
  return (
    <div className="card co-bill">
      <div className="co-order-head">
        <b>🧾 Your bill · {b.billNo}</b>
        <span className="small muted">{order.tableName}</span>
      </div>
      <div className="co-bill-lines">
        {b.items.map((i, k) => (
          <div key={k} className="co-line-top small">
            <span>{i.qty}× {i.name}{i.variant ? ` (${i.variant})` : ""}</span>
            <span>{money(i.amount ?? i.qty * i.rate, cur)}</span>
          </div>
        ))}
      </div>
      {(b.discount?.amount > 0 || b.gst?.amount > 0) && (
        <div className="small muted">
          Subtotal {money(b.subtotal, cur)}
          {b.discount?.amount > 0 && ` · Discount −${money(b.discount.amount, cur)}`}
          {b.gst?.amount > 0 && ` · GST ${money(b.gst.amount, cur)}`}
        </div>
      )}
      <div className="co-line-top co-bill-total"><b>Total</b><b>{money(b.total, cur)}</b></div>
      {prepaid > 0 && (
        <>
          <div className="co-line-top small"><span>Already paid with your order{prepaid >= b.total ? "s" : ""}</span><span>−{money(prepaid, cur)}</span></div>
          <div className="co-line-top"><b>To pay now</b><b>{money(balance, cur)}</b></div>
        </>
      )}

      {b.paymentConfirmed || balance <= 0 ? (
        <div className="co-paid">✅ Payment received. Thank you, visit again!</div>
      ) : upi && upiLink ? (
        b.customerPaid ? (
          <div className="co-note">⏳ Thanks! Waiting for the shop to confirm your payment.</div>
        ) : (
          <div className="stack">
            <PayWithApps link={upiLink} amount={money(balance, cur)} upiId={order.upi?.id} />
            <input className="input" placeholder="UPI reference no. (optional)" maxLength={30} value={utr} onChange={(e) => setUtr(e.target.value.replace(/\s/g, ""))} />
            {error && <div className="error">{error}</div>}
            <button className="btn btn-lg" disabled={busy} onClick={paidClaim}>{busy ? "Sending…" : "✔️ I have paid"}</button>
          </div>
        )
      ) : (
        <div className="co-note">💵 Please pay {money(balance, cur)} at the cash counter.</div>
      )}
    </div>
  );
}
