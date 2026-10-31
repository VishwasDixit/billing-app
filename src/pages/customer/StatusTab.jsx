// My orders tab: each order's progress, paying for it, the table's bill, and "add more while it cooks".
import { useMemo, useState } from "react";
import { post } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { STEPS, stepIndex, customerReason } from "./common.js";
import { OrderPay, BillBox, Instructions } from "./parts.jsx";
import { addonText } from "../../../shared/addons.js";
import { PopularCard } from "./MenuTab.jsx";
import { CookingScene } from "./CookingScene.jsx";

export function StatusTab({ token, data, mine, cur, returning, canOrder, refreshMine, onAskBill, quickAdd, less, qtyOf, onMenu, onGames, onInsta, helpOn = true }) {
  const [showPast, setShowPast] = useState(false);
  const list = [...mine].reverse().filter((o) => o.status !== "billed");
  const closed = (o) => o.status === "rejected" || o.status === "unpaid";
  const live = list.filter((o) => !closed(o));
  // A turned-down order stays in view for a while so it's noticed; older ones fold away.
  const recent = (o) => Date.now() - new Date(o.createdAt || 0) < 30 * 60e3;
  const justClosed = list.filter((o) => closed(o) && recent(o));
  const past = list.filter((o) => closed(o) && !recent(o));
  const cooking = mine.some((o) => ["new", "accepted", "preparing", "ready", "served"].includes(o.status));
  const waiting = live.some((o) => ["new", "accepted", "preparing"].includes(o.status));
  const byId = useMemo(() => new Map((data.menu || []).map((m) => [m.id, m])), [data.menu]);
  const more = (data.popular || []).map((id) => byId.get(id)).filter(Boolean).slice(0, 8);

  if (!mine.length)
    return (
      <div className="co-empty-state">
        <div className="co-empty-art">🧾</div>
        <b>No orders yet</b>
        <span className="small muted">Pick something tasty from the menu and it shows up here, with live updates from the kitchen.</span>
        <button className="btn btn-primary" onClick={onMenu}>See the menu</button>
      </div>
    );

  return (
    <div className="co-status">
      {returning && <div className="co-pay wait">⏳ Checking your payment with Cashfree…</div>}
      <BillBox
        token={token}
        mine={mine}
        cur={cur}
        onAsk={async (method) => {
          if (method !== "paid") return onAskBill();
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

      {waiting && onGames && (
        <button className="gm-open-btn" onClick={onGames}>
          <span className="gm-open-icons" aria-hidden="true">🛵🎲🐍</span>
          <span>
            <b>Play while you wait</b>
            <small>Tiffin Dash, Ludo, Snake, Ping Pong or chess. We'll tell you when your food moves along.</small>
          </span>
          <span className="gm-open-go">Play →</span>
        </button>
      )}
      {mine.length > 0 && onInsta && (
        <button className="ig-open-btn" onClick={onInsta}>
          <span aria-hidden="true">📸</span>
          <span>
            <b>1 meal free for an Instagram story</b>
            <small>Post your order, tag &amp; follow @{data.insta.handle}</small>
          </span>
          <span className="gm-open-go">How →</span>
        </button>
      )}

      {live.map((o) => {
        const at = stepIndex(o.status);
        const items = (o.items || []).filter((i) => !i.charge);
        const charges = (o.items || []).filter((i) => i.charge);
        return (
          <div key={o.id} className="card co-order">
            <div className="co-order-head">
              <div>
                <b>Order #{o.orderNo}</b>
                <span className="small muted">{[timeOf(o.createdAt), o.tableName].filter(Boolean).join(" · ")}</span>
              </div>
              <span className={`co-pill ${PILL[o.status] || "new"}`}>{STEPS[at][1]}</span>
            </div>
            <CookingScene status={o.status} seed={Number(String(o.orderNo).replace(/\D/g, "")) + Math.floor(Date.now() / 15000)} />
            <div className="co-now">
              <div>
                <b>{STEPS[at][1]}</b>
                <div className="small muted">{STEPS[at][2]}</div>
              </div>
            </div>
            {o.status === "new" && (o.phoneCheck === "new" || o.phoneCheck === "known") && (
              <div className="co-verify small">📱 First order from this number on this phone: the staff will confirm it at your table. After that, you can order more any time.</div>
            )}
            <ol className="co-track" aria-label="Order progress">
              {STEPS.map(([k, label], i) => (
                <li key={k} className={i < at ? "done" : i === at ? "now" : ""}><i />{label}</li>
              ))}
            </ol>
            <ul className="co-order-items">
              {items.map((i, n) => (
                <li key={n} className="co-item-row">
                  <span className="co-item-qty">{i.qty}×</span>
                  <span className="co-item-name">
                    {i.name}{i.variant ? ` (${i.variant})` : ""}
                    {i.addons?.length > 0 && <small>+ {addonText(i.addons)}</small>}
                  </span>
                  <span>{money(i.qty * i.rate, cur)}</span>
                </li>
              ))}
              {charges.map((i, n) => (
                <li key={`c${n}`} className="co-item-row muted">
                  <span className="co-item-qty" />
                  <span className="co-item-name">{i.name}</span>
                  <span>{money(i.qty * i.rate, cur)}</span>
                </li>
              ))}
            </ul>
            <div className="co-order-foot">
              {o.promo && <span className="co-save small">🏷 {o.promo.code} · you saved {money(o.promo.amount, cur)}</span>}
              {o.loyalty && <span className="co-save small">🎁 Free {o.loyalty.free} · your streak reward</span>}
              {!o.loyalty && o.streak?.count > 0 && <span className="co-save small">🔥 {o.streak.count}-day streak · {o.streak.need - o.streak.count} more day{o.streak.need - o.streak.count === 1 ? "" : "s"} for a free dish</span>}
              <span className="co-order-total"><span>Total</span><b>{money(o.total, cur)}</b></span>
            </div>
            <Instructions token={token} order={o} delivery={!!data.delivery || charges.length > 0} onSaved={refreshMine} />
            <OrderPay token={token} order={o} cur={cur} upiOn={data.upi} onlineOn={data.online} onChange={refreshMine} />
          </div>
        );
      })}

      {justClosed.map((o) => (
        <div key={o.id} className="card co-order muted">
          <div className="co-order-head">
            <div>
              <b>Order #{o.orderNo}</b>
              <span className="small muted">{timeOf(o.createdAt)}</span>
            </div>
            <ClosedPill o={o} />
          </div>
          <div>
            <b>{o.status === "unpaid" ? "This order was closed as not paid" : "This order wasn't accepted"}</b>
            {customerReason(o.reason) && <div className="small">{customerReason(o.reason)}</div>}
            <div className="small muted">Please ask the staff if you have any questions.</div>
          </div>
          <div className="small muted">{itemsShort(o)} · {money(o.total, cur)}</div>
        </div>
      ))}

      {live.length === 0 && (
        <div className="card co-noactive">
          <b>No active orders</b>
          <span className="small muted">Hungry? Pick something from the menu.</span>
          {canOrder && <button className="btn btn-primary" onClick={onMenu}>Order from the menu</button>}
        </div>
      )}

      {mine.some((o) => o.status === "new") && (
        <p className="small muted" style={{ textAlign: "center" }}>If no one confirms your order in a few minutes, {helpOn ? "tap 💬 Help to call the staff" : "please ask the staff"}.</p>
      )}

      {canOrder && cooking && more.length > 0 && (
        <section className="co-more">
          <h3>Add more while it cooks 🍳</h3>
          <div className="co-pop-row">
            {more.map((m) => (
              <PopularCard key={m.id} m={m} cur={cur} qty={qtyOf(m.id)} canOrder quickAdd={quickAdd} less={less} />
            ))}
          </div>
        </section>
      )}
      {canOrder && live.length > 0 && <button className="btn btn-primary btn-lg" onClick={onMenu}>+ Order more from the menu</button>}

      {past.length > 0 && (
        <section className="co-past">
          <button className="co-past-toggle" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
            <span>Cancelled orders ({past.length})</span>
            <span aria-hidden="true">{showPast ? "▾" : "›"}</span>
          </button>
          {showPast &&
            past.map((o) => (
              <div key={o.id} className="co-past-row">
                <div>
                  <b>#{o.orderNo}</b> <span className="small">{itemsShort(o)}</span>
                  {customerReason(o.reason) && <div className="small muted">{customerReason(o.reason)}</div>}
                </div>
                <div className="co-past-right">
                  <span className="small">{money(o.total, cur)}</span>
                  <ClosedPill o={o} />
                </div>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

const PILL = { new: "new", accepted: "cook", preparing: "cook", ready: "ready", served: "served" };
const ClosedPill = ({ o }) => <span className="co-pill off">{o.status === "unpaid" ? "Not paid" : "Cancelled"}</span>;
const timeOf = (d) => (d ? new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "");
// "1× Chai, 2× Samosa"
const itemsShort = (o) =>
  (o.items || [])
    .filter((i) => !i.charge)
    .map((i) => `${i.qty}× ${i.name}`)
    .join(", ");
