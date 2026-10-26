// My orders tab: each order's progress, paying for it, the table's bill, and "add more while it cooks".
import { useMemo } from "react";
import { post } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { STEPS, stepIndex } from "./common.js";
import { OrderPay, BillBox } from "./parts.jsx";
import { PopularCard } from "./MenuTab.jsx";

export function StatusTab({ token, data, mine, cur, returning, canOrder, refreshMine, onAskBill, add, quickAdd, qtyOf, onMenu, helpOn = true }) {
  const list = [...mine].reverse().filter((o) => o.status !== "billed");
  const cooking = mine.some((o) => ["new", "accepted", "preparing", "ready", "served"].includes(o.status));
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

      {list.map((o) => {
        const at = stepIndex(o.status);
        return (
          <div key={o.id} className="card co-order">
            <div className="co-order-head">
              <b>Order #{o.orderNo}</b>
              <span className="small muted">{o.tableName} · {money(o.total, cur)}{o.promo ? ` · 🏷 ${o.promo.code} −${money(o.promo.amount, cur)}` : ""}</span>
            </div>
            {o.status === "rejected" ? (
              <div className="error">Sorry, this order couldn't be taken{o.reason ? `: ${o.reason}` : "."} Please ask the staff.</div>
            ) : o.status === "unpaid" ? (
              <div className="error">This order was closed as not paid. Please speak to the staff.</div>
            ) : (
              <>
                <div className="co-now">
                  <span className="co-now-icon" aria-hidden="true">{STEPS[at][3]}</span>
                  <div>
                    <b>{STEPS[at][1]}</b>
                    <div className="small muted">{STEPS[at][2]}</div>
                  </div>
                </div>
                <ol className="co-track" aria-label="Order progress">
                  {STEPS.map(([k, label], i) => (
                    <li key={k} className={i < at ? "done" : i === at ? "now" : ""}><i />{label}</li>
                  ))}
                </ol>
              </>
            )}
            <div className="small muted">{(o.items || []).map((i) => `${i.qty}× ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", ")}</div>
            <OrderPay token={token} order={o} cur={cur} upiOn={data.upi} onlineOn={data.online} onChange={refreshMine} />
          </div>
        );
      })}

      {mine.some((o) => o.status === "new") && (
        <p className="small muted" style={{ textAlign: "center" }}>If no one confirms your order in a few minutes, {helpOn ? "tap 💬 Help to call the staff" : "please ask the staff"}.</p>
      )}

      {canOrder && cooking && more.length > 0 && (
        <section className="co-more">
          <h3>Add more while it cooks 🍳</h3>
          <div className="co-pop-row">
            {more.map((m) => (
              <PopularCard key={m.id} m={m} cur={cur} qty={qtyOf(m.id)} canOrder add={add} quickAdd={quickAdd} />
            ))}
          </div>
        </section>
      )}
      {canOrder && <button className="btn btn-primary btn-lg" onClick={onMenu}>+ Order more from the menu</button>}
    </div>
  );
}
