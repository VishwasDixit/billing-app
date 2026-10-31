// The cart page (like Swiggy/Zomato): dishes with steppers, "complete your meal", coupons,
// bill details, your details, and a sticky Place-order bar. No notes here: customers add cooking
// and delivery instructions once the shop accepts the order (My orders).
import { useEffect, useRef, useState } from "react";
import { post } from "../../lib/api.js";
import { money } from "../../lib/format.js";
import { couponNudge, deviceKey } from "./common.js";
import { PopularCard } from "./MenuTab.jsx";
import { computeTotals } from "../../../shared/totals.js";
import { deliveryLine, freeDeliveryGap } from "../../../shared/tableGroups.js";
import { addonText } from "../../../shared/addons.js";
import { defaultImageFor } from "../../../shared/menuImages.js";
import { Celebrate } from "../../components/Celebrate.jsx";
import { streakText } from "../../../shared/loyalty.js";

export function Cart({ token, data, table, lines, cur, total, changeQty, onEdit, onClose, onPlaced, offers, initialCode, cardProps, priceNote }) {
  const delivery = data.delivery || null;
  const byId = new Map((data.menu || []).map((m) => [m.id, m]));
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
  const [editContact, setEditContact] = useState(!(saved.name && saved.phone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Promo code: checked by the server with its own prices (and this mobile, for once-per-mobile codes).
  const [code, setCode] = useState(initialCode || "");
  const [promo, setPromo] = useState(null); // { code, amount }
  const [promoErr, setPromoErr] = useState("");
  const [checking, setChecking] = useState(false);
  const [party, setParty] = useState(null); // { amount, note }: the "you saved" burst
  // Loyalty streak for this mobile: progress, or a free dish the restaurant adds to this order.
  const [loyal, setLoyal] = useState(null);
  const cheered = useRef(false);
  useEffect(() => {
    if (!contactOk) return setLoyal(null);
    let alive = true;
    post(`/public/shop/${token}/loyalty`, { phone: mobile }).then(
      (r) => {
        if (!alive || !r.on || !r.dish) return setLoyal(null);
        setLoyal(r);
        if (r.reward && !cheered.current) {
          cheered.current = true;
          setParty({ title: "Streak reward! 🔥", note: `Your free ${r.dish.name} is added to this order` });
        }
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [mobile, contactOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = lines.map((l) => ({ itemId: l.itemId, variant: l.variant, qty: l.qty, addons: l.addonIds || [] }));
  // quiet: the cart changed and the code is checked again (no celebration).
  const applyCode = async (c = code, quiet = false) => {
    c = c.trim().toUpperCase();
    if (!c) return;
    setChecking(true);
    setPromoErr("");
    try {
      const r = await post(`/public/shop/${token}/promo`, { code: c, items, phone: mobile, table: table.id });
      setPromo({ code: r.code, amount: r.amount });
      setCode(r.code);
      if (!quiet && r.amount > 0) setParty({ amount: money(r.amount, cur), note: `Code ${r.code} applied` });
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
  // The cart changed: a code's amount may change too, so check it again.
  const cartSig = items.map((i) => `${i.itemId}${i.variant}${i.qty}${i.addons.join()}`).join();
  useEffect(() => {
    if (promo) applyCode(promo.code, true);
  }, [cartSig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.body.classList.add("sheet-open");
    return () => document.body.classList.remove("sheet-open");
  }, []);

  // Bill details, worked out the same way as the server: delivery is a line, the code comes off
  // before GST.
  const charge = deliveryLine({ delivery }, total);
  const gap = freeDeliveryGap({ delivery }, total);
  const t = computeTotals([...lines, ...(charge ? [charge] : [])], { type: "flat", value: promo?.amount || 0 }, data.gst || 0);
  const nudge = !promo ? couponNudge(offers, total) : null;
  const inCart = new Set(lines.map((l) => l.itemId));
  const suggest = (data.popular || []).map((id) => byId.get(id)).filter((m) => m && !inCart.has(m.id)).slice(0, 8);

  const place = async () => {
    if (!contactOk) {
      setEditContact(true);
      return setError(name.trim().length < 2 ? "Please enter your name." : "Please enter a 10-digit mobile number.");
    }
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("coContact", JSON.stringify({ name: name.trim(), phone: mobile }));
    } catch {
      /* private mode */
    }
    try {
      const r = await post(`/public/shop/${token}/orders`, { table: table.id, items, name: name.trim(), phone: mobile, device: deviceKey(), ...(promo && { promo: promo.code }) });
      onPlaced({ id: r.orderId, key: r.key, orderNo: r.orderNo, total: r.total, status: r.status, phoneCheck: r.phoneCheck || "", pay: r.pay, promo: r.promo || null, loyalty: r.loyalty || null, streak: r.streak || null, tableId: table.id, tableName: table.name, items: lines, createdAt: new Date().toISOString() });
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
    <div className="co-cartpage" role="dialog" aria-label="Your cart">
      <header className="co-cp-head">
        <button className="co-back" onClick={onClose} aria-label="Back to the menu">←</button>
        <div>
          <b>{data.shop.name}</b>
          <span className="small muted">🪑 {table.name}{delivery ? " · 🛵 Delivery" : ""}</span>
        </div>
      </header>

      <div className="co-cp-body">
        {priceNote && <div className="co-nudge co-price-note">🔄 {priceNote}</div>}
        <section className="co-cp-card">
          {lines.map((l) => {
            const m = byId.get(l.itemId);
            return (
              <div key={l.key} className="co-cp-line">
                <img src={m?.image || defaultImageFor(l.name, m?.category)} alt="" onError={(e) => (e.currentTarget.src = defaultImageFor(l.name, m?.category))} />
                <div className="co-cp-line-text">
                  <b>{l.name}</b>
                  {(l.variant || l.addons?.length > 0) && <span className="small muted">{[l.variant, addonText(l.addons)].filter(Boolean).join(" · ")}</span>}
                  {m && (m.variants.length > 1 || m.addons?.length > 0) && <button className="link-btn small" onClick={() => onEdit(l)}>Edit ›</button>}
                </div>
                <div className="co-cp-line-right">
                  <div className="co-stepper sm">
                    <button onClick={() => changeQty(l.key, -1)} aria-label={`One less ${l.name}`}>−</button>
                    <span>{l.qty}</span>
                    <button onClick={() => changeQty(l.key, 1)} aria-label={`One more ${l.name}`}>+</button>
                  </div>
                  <span>{money(l.qty * l.rate, cur)}</span>
                </div>
              </div>
            );
          })}
          {loyal?.reward && (
            <div className="co-cp-line co-free-line">
              <span className="co-free-ico" aria-hidden="true">🎁</span>
              <div className="co-cp-line-text">
                <b>{loyal.dish.name}{loyal.dish.variant ? ` (${loyal.dish.variant})` : ""}</b>
                <span className="small muted">Your {loyal.need}-day streak reward</span>
              </div>
              <div className="co-cp-line-right"><b className="co-free">FREE</b></div>
            </div>
          )}
          <button className="co-cp-more" onClick={onClose}>+ Add more items</button>
        </section>

        {suggest.length > 0 && (
          <section className="co-cp-section">
            <h4>Complete your meal</h4>
            <div className="co-pop-row">
              {suggest.map((m) => (
                <PopularCard key={m.id} m={m} cur={cur} qty={0} canOrder {...cardProps} />
              ))}
            </div>
          </section>
        )}

        {loyal && !loyal.reward && (
          <div className="co-nudge co-streak">{loyal.visitedToday && loyal.count ? `🔥 ${loyal.count}-day streak · today counts! ${loyal.need - loyal.count} more day${loyal.need - loyal.count === 1 ? "" : "s"} for a free ${loyal.dish.name}` : streakText(loyal.count, loyal.need, loyal.dish)}</div>
        )}
        <section className="co-cp-card co-promo">
          <h4>🏷 Offers</h4>
          {promo ? (
            <div className="co-line-top">
              <span><b>{promo.code}</b> applied · you save {money(promo.amount, cur)}</span>
              <button className="link-btn" onClick={() => (setPromo(null), setCode(""))}>Remove</button>
            </div>
          ) : (
            <form className="co-promo-row" onSubmit={(e) => (e.preventDefault(), applyCode())}>
              <input className="input" placeholder="Enter a coupon code" autoCapitalize="characters" maxLength={20} value={code} onChange={(e) => (setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")), setPromoErr(""))} />
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
          {nudge &&
            (nudge.unlocked ? (
              <button className="co-nudge done link-btn" onClick={() => applyCode(nudge.offer.code)}>🎉 {nudge.offer.code} unlocked: tap to apply</button>
            ) : (
              <div className="co-nudge">
                <span>Add <b>{money(Math.ceil(nudge.short), cur)}</b> more to use <b>{nudge.offer.code}</b>{nudge.offer.description ? ` · ${nudge.offer.description}` : ""}</span>
                <i className="co-nudge-bar"><i style={{ width: `${Math.round(nudge.progress * 100)}%` }} /></i>
              </div>
            ))}
        </section>

        <section className="co-cp-card co-billdetails">
          <h4>Bill details</h4>
          <div className="co-line-top"><span>Item total</span><span>{money(total, cur)}</span></div>
          {delivery && (
            <div className="co-line-top">
              <span>🛵 Delivery fee</span>
              <span>{charge ? money(charge.rate, cur) : <><s className="muted">{money(delivery.charge, cur)}</s> <b className="co-free">FREE</b></>}</span>
            </div>
          )}
          {gap > 0 && (
            <div className="co-nudge">
              <span>🛵 Add <b>{money(Math.ceil(gap), cur)}</b> more for <b>free delivery</b> · <button className="link-btn" onClick={onClose}>Add more</button></span>
            </div>
          )}
          {promo && <div className="co-line-top co-save"><span>Coupon {promo.code}</span><span>−{money(t.discount.amount, cur)}</span></div>}
          {t.gst.amount > 0 && <div className="co-line-top"><span>GST ({t.gst.percent}%)</span><span>{money(t.gst.amount, cur)}</span></div>}
          <div className="co-line-top co-topay"><b>To pay</b><b>{money(t.total, cur)}</b></div>
        </section>

        <section className="co-cp-card">
          <h4>Your details</h4>
          {!editContact && contactOk ? (
            <div className="co-line-top">
              <span>👤 {name.trim()} · {mobile.replace(/(\d{5})(\d{5})/, "$1 $2")}</span>
              <button className="link-btn" onClick={() => setEditContact(true)}>Change</button>
            </div>
          ) : (
            <div className="co-contact">
              <input className="input" placeholder="Your name *" autoComplete="name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} required />
              <input className="input" placeholder="Mobile number *" type="tel" inputMode="tel" autoComplete="tel" maxLength={16} value={phone} onChange={(e) => setPhone(e.target.value)} required />
              <span className="small muted">So the restaurant can reach you about your order. A new number's first order is confirmed by the staff at your table.</span>
            </div>
          )}
        </section>

        <p className="co-cp-hint">📝 You can add cooking{delivery ? " and delivery" : ""} instructions once the restaurant accepts your order.</p>
        <p className="co-cp-hint">
          {data.payRule === "first" ? "💳 Please pay after placing the order. It's cooked once the payment is confirmed." : data.payRule === "choose" ? "💳 You can pay now by UPI, or at the end." : "💳 You pay after your meal."}
        </p>
      </div>

      {party && <Celebrate title={party.title} amount={party.amount} note={party.note} onDone={() => setParty(null)} />}

      <div className="co-cp-bar">
        {error && <div className="error small">{error}</div>}
        <div className="co-cp-bar-row">
          <div className="co-cp-total">
            <b>{money(t.total, cur)}</b>
            <small>TOTAL</small>
          </div>
          <button className="btn btn-primary btn-lg" disabled={busy} onClick={place}>{busy ? "Sending…" : "Place order →"}</button>
        </div>
      </div>
    </div>
  );
}
