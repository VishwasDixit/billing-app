import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { money } from "../lib/format.js";
import { defaultImageFor } from "../../shared/menuImages.js";
import { qrSvg } from "../../shared/billQr.js";
import { promoSummary } from "../../shared/promo.js";

// The page a customer sees after scanning a table's QR code: menu, cart, order status.
const STEPS = [
  ["new", "Sent", "Waiting for the staff to confirm"],
  ["accepted", "In the kitchen", "Your order is being prepared"],
  ["preparing", "Cooking", "Your food is being cooked"],
  ["ready", "Ready", "Your food is ready and on its way"],
  ["served", "Served", "Enjoy your meal!"],
];
const stepIndex = (s) => Math.max(0, STEPS.findIndex(([k]) => k === s));
const lineKey = (id, v) => `${id}|${v}`;

function loadMine(token) {
  try {
    return JSON.parse(localStorage.getItem(`myOrders:${token}`) || "[]");
  } catch {
    return [];
  }
}
function saveMine(token, list) {
  try {
    localStorage.setItem(`myOrders:${token}`, JSON.stringify(list.slice(-10)));
  } catch {
    /* ignore */
  }
}

export default function CustomerOrder() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const tableId = params.get("t") || "";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState(() => new Map());
  const [picker, setPicker] = useState(null);
  const [review, setReview] = useState(false);
  const [mine, setMine] = useState(() => loadMine(token));
  const [view, setView] = useState(() =>
    loadMine(token).some((o) => !["rejected", "billed"].includes(o.status) || (o.bill && o.bill.paymentMode === "upi" && !o.bill.paymentConfirmed)) ? "status" : "menu"
  );
  const [billAsk, setBillAsk] = useState(false);
  const [offerCode, setOfferCode] = useState("");
  const [tableQ, setTableQ] = useState("");
  const refreshMine = async () => {
    const next = await Promise.all(mine.map((o) => get(`/public/shop/${token}/orders/${o.id}?k=${o.key}`).then((s) => ({ ...o, ...s, checkedAt: Date.now() }), () => o)));
    setMine(next);
    saveMine(token, next);
  };

  useEffect(() => {
    get(`/public/shop/${token}`).then(setData, (e) => setError(e.message));
  }, [token]);
  // Closed for the night: check again every minute so ordering opens on time.
  useEffect(() => {
    if (!data?.ordering?.closedForHours) return;
    const t = setInterval(() => get(`/public/shop/${token}`).then(setData, () => {}), 60000);
    return () => clearInterval(t);
  }, [token, data?.ordering?.closedForHours]);

  // Keep my recent orders' status fresh.
  useEffect(() => {
    if (!mine.length) return;
    const tick = async () => {
      const next = await Promise.all(
        mine.map((o) =>
          (o.status === "rejected" || (o.status === "billed" && (o.bill?.paymentConfirmed || o.bill?.paymentMode !== "upi"))) && o.checkedAt && Date.now() - o.checkedAt > 60000
            ? o
            : get(`/public/shop/${token}/orders/${o.id}?k=${o.key}`).then((s) => ({ ...o, ...s, checkedAt: Date.now() }), () => o)
        )
      );
      setMine(next);
      saveMine(token, next);
    };
    const t = setInterval(tick, 6000);
    tick();
    return () => clearInterval(t);
  }, [token, mine.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = data?.tables.find((t) => t.id === tableId);
  // Offers for this table only (some codes are for some tables).
  const offers = (data?.offers || []).filter((o) => !o.tables?.length || o.tables.includes(tableId));
  const cur = data?.shop.currency || "₹";
  const categories = useMemo(() => ["All", ...new Set((data?.menu || []).map((m) => m.category))], [data]);
  const shown = (data?.menu || []).filter((m) => (cat === "All" || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const lines = [...cart.values()];
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.rate, 0);

  const add = (m, v, d = 1) =>
    setCart((prev) => {
      const k = lineKey(m.id, v.label || "");
      const next = new Map(prev);
      const l = next.get(k);
      const qty = (l?.qty || 0) + d;
      if (qty <= 0) next.delete(k);
      else next.set(k, { itemId: m.id, name: m.name, variant: v.label || "", rate: v.price, qty: Math.min(qty, 99), note: l?.note || "" });
      return next;
    });
  const qtyOf = (id) => lines.filter((l) => l.itemId === id).reduce((s, l) => s + l.qty, 0);

  if (error) return <div className="co-page"><div className="co-empty">😕 {error}</div></div>;
  if (!data) return <div className="co-page"><div className="co-empty">Loading menu…</div></div>;

  return (
    <div className="co-page">
      <header className="co-head">
        {data.shop.logo ? <img src={data.shop.logo} alt="" /> : <span className="co-logo">🍽️</span>}
        <div>
          <b>{data.shop.name}</b>
          <div className="small muted">{table ? table.name : "Choose your table"}</div>
        </div>
        {mine.length > 0 && (
          <button className="btn btn-sm" onClick={() => setView(view === "status" ? "menu" : "status")}>
            {view === "status" ? "Menu" : "My orders"}
          </button>
        )}
      </header>

      {!data.ordering.open &&
        (data.ordering.closedForHours ? (
          <div className="co-closed">
            <div className="co-closed-moon">🌙</div>
            <b>{data.ordering.reason}</b>
            {data.hours && <span className="small muted">Ordering hours: {data.hours}</span>}
            <span className="small muted">Have a look at the menu meanwhile 👇</span>
          </div>
        ) : (
          <div className="co-note">{data.ordering.reason} You can still see the menu.</div>
        ))}

      {!table && data.ordering.open && (
        <div className="co-tables">
          <p>Which table are you at?</p>
          {data.tables.length > 30 && (
            <input className="input" type="search" inputMode="numeric" placeholder="Table name or number" value={tableQ} onChange={(e) => setTableQ(e.target.value)} style={{ marginBottom: 8 }} />
          )}
          <div className="co-table-grid">
            {data.tables.filter((t) => !tableQ || t.name.toLowerCase().includes(tableQ.toLowerCase())).slice(0, 120).map((t) => (
              <button key={t.id} className="btn" onClick={() => setParams({ t: t.id })}>{t.name}</button>
            ))}
          </div>
        </div>
      )}

      {view === "status" ? (
        <div className="co-status">
          <BillBox
            token={token}
            mine={mine}
            cur={cur}
            onAsk={async (method) => {
              if (method !== "paid") return setBillAsk(true);
              // Everything is paid: just tell the staff the table is done.
              const o = [...mine].reverse().find((x) => ["accepted", "preparing", "ready", "served"].includes(x.status));
              try {
                await post(`/public/shop/${token}/bill-request`, { orderId: o.id, key: o.key, method: "paid" });
              } catch {
                /* the staff can still close it */
              }
              await refreshMine();
            }}
            onChange={refreshMine}
          />
          {[...mine].reverse().filter((o) => o.status !== "billed").map((o) => (
            <div key={o.id} className="card co-order">
              <div className="co-order-head">
                <b>Order #{o.orderNo}</b>
                <span className="small muted">{o.tableName} · {money(o.total, cur)}{o.promo ? ` · 🏷 ${o.promo.code} −${money(o.promo.amount, cur)}` : ""}</span>
              </div>
              {o.status === "rejected" ? (
                <div className="error">Sorry, this order couldn't be taken{o.reason ? `: ${o.reason}` : "."} Please ask the staff.</div>
              ) : (
                <>
                  <ol className="co-steps">
                    {STEPS.map(([k, label], i) => (
                      <li key={k} className={i < stepIndex(o.status) ? "done" : i === stepIndex(o.status) ? "now" : ""}>{label}</li>
                    ))}
                  </ol>
                  <div className="small">{o.status === "billed" ? "Paid. Thank you!" : STEPS[stepIndex(o.status)][2]}</div>
                </>
              )}
              <div className="small muted">{(o.items || []).map((i) => `${i.qty}× ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", ")}</div>
              <OrderPay token={token} order={o} cur={cur} upiOn={data.upi} onChange={refreshMine} />
            </div>
          ))}
          {mine.some((o) => o.status === "new") && (
            <p className="small muted" style={{ textAlign: "center" }}>If no one confirms your order in a few minutes, please call the staff.</p>
          )}
          {table && data.ordering.open && <button className="btn btn-primary btn-lg" onClick={() => setView("menu")}>+ Order more</button>}
        </div>
      ) : (
        <>
          {offers.length > 0 && data.ordering.open && (
            <div className="co-offers">
              {offers.map((o) => (
                <button key={o.code} className="co-offer" onClick={() => setOfferCode(o.code)} aria-pressed={offerCode === o.code}>
                  <b>🏷 {o.code}</b>
                  <span>{o.description || promoSummary(o, cur)}</span>
                  {o.description && <small>{promoSummary(o, cur)}</small>}
                  <small className="co-offer-use">{offerCode === o.code ? "✓ Will be applied at checkout" : "Tap to use"}</small>
                </button>
              ))}
            </div>
          )}
          <div className="co-tools">
            <input className="input" type="search" placeholder="Search dishes…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="chips co-chips">
            {categories.map((c) => (
              <button key={c} className={"chip" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          <div className="co-menu">
            {shown.map((m) => (
              <div key={m.id} className="co-item">
                <img src={m.image || defaultImageFor(m.name, m.category)} alt="" loading="lazy" onError={(e) => (e.currentTarget.src = defaultImageFor(m.name, m.category))} />
                <div className="co-item-text">
                  <b>{m.name}</b>
                  {m.note && <div className="small muted">{m.note}</div>}
                  <div className="small">{m.variants.map((v) => `${v.label ? v.label + " " : ""}${money(v.price, cur)}`).join(" · ")}</div>
                  {m.left != null && <div className="small" style={{ color: "var(--warn)", fontWeight: 600 }}>Only {m.left} left</div>}
                </div>
                {table && data.ordering.open && (
                  m.variants.length > 1 ? (
                    <button className="btn btn-sm co-add" onClick={() => setPicker(m)}>{qtyOf(m.id) ? `${qtyOf(m.id)} added` : "Add +"}</button>
                  ) : qtyOf(m.id) ? (
                    <div className="qty co-qty">
                      <button onClick={() => add(m, m.variants[0], -1)} aria-label="Less">−</button>
                      <span>{qtyOf(m.id)}</span>
                      <button onClick={() => add(m, m.variants[0], 1)} aria-label="More">+</button>
                    </div>
                  ) : (
                    <button className="btn btn-sm co-add" onClick={() => add(m, m.variants[0], 1)}>Add +</button>
                  )
                )}
              </div>
            ))}
            {shown.length === 0 && <div className="co-empty">No dishes match.</div>}
          </div>
          {count > 0 && (
            <button className="co-cartbar" onClick={() => setReview(true)}>
              <span>{count} item{count === 1 ? "" : "s"} · {money(total, cur)}</span>
              <b>Review order →</b>
            </button>
          )}
        </>
      )}

      {picker && (
        <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && setPicker(null)}>
          <div className="co-sheet">
            <b>{picker.name}</b>
            {picker.variants.map((v) => {
              const l = cart.get(lineKey(picker.id, v.label || ""));
              return (
                <div key={v.label} className="co-variant">
                  <span>{v.label} · {money(v.price, cur)}</span>
                  <div className="qty co-qty">
                    <button onClick={() => add(picker, v, -1)} disabled={!l} aria-label="Less">−</button>
                    <span>{l?.qty || 0}</span>
                    <button onClick={() => add(picker, v, 1)} aria-label="More">+</button>
                  </div>
                </div>
              );
            })}
            <button className="btn btn-primary" onClick={() => setPicker(null)}>Done</button>
          </div>
        </div>
      )}

      {billAsk && (
        <BillAsk
          token={token}
          mine={mine}
          onClose={() => setBillAsk(false)}
          onDone={async () => {
            setBillAsk(false);
            await refreshMine();
          }}
        />
      )}

      {review && (
        <Review
          token={token}
          table={table}
          lines={lines}
          cur={cur}
          total={total}
          setNote={(k, note) => setCart((prev) => new Map(prev).set(k, { ...prev.get(k), note }))}
          onClose={() => setReview(false)}
          payRule={data.payRule}
          offers={offers}
          initialCode={offerCode}
          onPlaced={(o) => {
            const next = [...mine, o];
            setMine(next);
            saveMine(token, next);
            setCart(new Map());
            setOfferCode("");
            setReview(false);
            setView("status");
          }}
        />
      )}
    </div>
  );
}

function Review({ token, table, lines, cur, total, setNote, onClose, onPlaced, payRule, offers, initialCode }) {
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
  const toPay = Math.max(0, total - (promo?.amount || 0));
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
        </div>
        {promo && <div className="co-line-top small muted"><span>Items</span><span>{money(total, cur)}</span></div>}
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
function OrderPay({ token, order, cur, upiOn, onChange }) {
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
  const link = order.upi && upiLinkFor(order.upi, p.amount ?? order.total, `Order #${order.orderNo} · ${order.tableName}`);
  if (p.state === "paid")
    return (
      <div className="co-pay paid">
        ✅ Paid {amount}{p.method === "counter" ? " at the counter" : ""}{order.bill ? ` · Bill ${order.bill.billNo}` : ""}
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
        {p.rule === "choose" && upiOn && <button className="link-btn" onClick={() => setOpen(true)}>Pay now instead</button>}
        {open && <UpiPanel link={link} upiId={order.upi?.id} amount={amount} utr={utr} setUtr={setUtr} busy={busy} error={error} onPaid={() => send("upi")} />}
      </div>
    );
  }
  // choose (not decided) or due (pay first)
  return (
    <div className="co-pay stack">
      {p.notReceived && <div className="error small">The staff couldn't find your payment. Please pay again or pay at the counter.</div>}
      {p.state === "due" && <b className="small">💳 Please pay {amount} to send this order to the kitchen.</b>}
      {p.state === "due" && p.method === "counter" && <div className="small">💵 Pay {amount} at the counter. Your order is cooked once the staff confirm it.</div>}
      {upiOn && link && !open && <button className="btn btn-primary" disabled={busy} onClick={() => setOpen(true)}>📱 Pay {amount} now (UPI)</button>}
      {open && <UpiPanel link={link} upiId={order.upi?.id} amount={amount} utr={utr} setUtr={setUtr} busy={busy} error={error} onPaid={() => send("upi")} />}
      <div className="btn-row">
        {p.state === "due" && p.method !== "counter" && <button className="btn btn-sm" disabled={busy} onClick={() => send("counter")}>💵 Pay at the counter</button>}
        {p.state === "choose" && <button className="btn btn-sm" disabled={busy} onClick={() => send("end")}>Pay at the end</button>}
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
function BillBox({ token, mine, cur, onAsk, onChange }) {
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

function BillAsk({ token, mine, onClose, onDone }) {
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

function BillCard({ token, order, cur, onChange }) {
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
