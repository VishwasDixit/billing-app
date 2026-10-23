import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { money } from "../lib/format.js";
import { defaultImageFor } from "../../shared/menuImages.js";

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
  const [view, setView] = useState(() => (loadMine(token).some((o) => !["served", "rejected", "billed"].includes(o.status)) ? "status" : "menu"));

  useEffect(() => {
    get(`/public/shop/${token}`).then(setData, (e) => setError(e.message));
  }, [token]);

  // Keep my recent orders' status fresh.
  useEffect(() => {
    if (!mine.length) return;
    const tick = async () => {
      const next = await Promise.all(
        mine.map((o) =>
          ["served", "rejected", "billed"].includes(o.status) && o.checkedAt && Date.now() - o.checkedAt > 60000
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

      {!data.ordering.open && <div className="co-note">{data.ordering.reason} You can still see the menu.</div>}

      {!table && data.ordering.open && (
        <div className="co-tables">
          <p>Which table are you at?</p>
          <div className="co-table-grid">
            {data.tables.map((t) => (
              <button key={t.id} className="btn" onClick={() => setParams({ t: t.id })}>{t.name}</button>
            ))}
          </div>
        </div>
      )}

      {view === "status" ? (
        <div className="co-status">
          {[...mine].reverse().map((o) => (
            <div key={o.id} className="card co-order">
              <div className="co-order-head">
                <b>Order #{o.orderNo}</b>
                <span className="small muted">{o.tableName} · {money(o.total, cur)}</span>
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
            </div>
          ))}
          <p className="small muted" style={{ textAlign: "center" }}>Pay at the counter when you're done. If no one confirms in a few minutes, please call the staff.</p>
          {table && data.ordering.open && <button className="btn btn-primary btn-lg" onClick={() => setView("menu")}>+ Order more</button>}
        </div>
      ) : (
        <>
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

      {review && (
        <Review
          token={token}
          table={table}
          lines={lines}
          cur={cur}
          total={total}
          setNote={(k, note) => setCart((prev) => new Map(prev).set(k, { ...prev.get(k), note }))}
          onClose={() => setReview(false)}
          onPlaced={(o) => {
            const next = [...mine, o];
            setMine(next);
            saveMine(token, next);
            setCart(new Map());
            setReview(false);
            setView("status");
          }}
        />
      )}
    </div>
  );
}

function Review({ token, table, lines, cur, total, setNote, onClose, onPlaced }) {
  const [note, setOrderNote] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const place = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await post(`/public/shop/${token}/orders`, {
        table: table.id,
        items: lines.map((l) => ({ itemId: l.itemId, variant: l.variant, qty: l.qty, note: l.note })),
        note,
        name,
      });
      onPlaced({ id: r.orderId, key: r.key, orderNo: r.orderNo, total: r.total, status: r.status, tableName: table.name, items: lines, createdAt: new Date().toISOString() });
    } catch (err) {
      setError(err.offline ? "No internet on this phone. Please try again, or order with the staff." : err.message);
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
        <input className="input" placeholder="Your name (optional)" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="co-line-top"><b>Total</b><b>{money(total, cur)}</b></div>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary btn-lg" disabled={busy} onClick={place}>{busy ? "Sending…" : "Place order"}</button>
        <p className="small muted" style={{ margin: 0, textAlign: "center" }}>You pay at the counter after your meal.</p>
      </div>
    </div>
  );
}
