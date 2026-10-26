// Menu tab: offers, ⭐ bestsellers, search, and the menu in sections with sticky category tabs
// that follow the scroll.
import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "../../lib/format.js";
import { defaultImageFor } from "../../../shared/menuImages.js";
import { promoSummary } from "../../../shared/promo.js";

const imgOf = (m) => m.image || defaultImageFor(m.name, m.category);
const fallback = (m) => (e) => (e.currentTarget.src = defaultImageFor(m.name, m.category));
const priceText = (m, cur) => m.variants.map((v) => `${v.label ? v.label + " " : ""}${money(v.price, cur)}`).join(" · ");

export function AddButton({ m, qty, canOrder, add, quickAdd, small }) {
  if (!canOrder) return null;
  if (m.variants.length > 1)
    return (
      <button className={"co-add" + (qty ? " has" : "") + (small ? " sm" : "")} onClick={() => quickAdd(m)}>
        {qty ? `${qty} added` : "Add +"}
      </button>
    );
  return qty ? (
    <div className={"co-stepper" + (small ? " sm" : "")}>
      <button onClick={() => add(m, m.variants[0], -1)} aria-label={`One less ${m.name}`}>−</button>
      <span>{qty}</span>
      <button onClick={() => add(m, m.variants[0], 1)} aria-label={`One more ${m.name}`}>+</button>
    </div>
  ) : (
    <button className={"co-add" + (small ? " sm" : "")} onClick={() => add(m, m.variants[0], 1)}>Add +</button>
  );
}

export function PopularCard({ m, cur, ...addProps }) {
  return (
    <div className="co-pop">
      <img src={imgOf(m)} alt="" loading="lazy" onError={fallback(m)} />
      <b>{m.name}</b>
      <span className="co-pop-price">{money(m.variants[0].price, cur)}{m.variants.length > 1 ? "+" : ""}</span>
      <AddButton m={m} small {...addProps} />
    </div>
  );
}

export function MenuTab({ data, cur, offers, offerCode, setOfferCode, q, setQ, canOrder, add, quickAdd, qtyOf }) {
  const menu = data.menu || [];
  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const popular = (data.popular || []).map((id) => byId.get(id)).filter(Boolean);
  const best = new Set(popular.slice(0, 5).map((m) => m.id));
  const categories = useMemo(() => [...new Set(menu.map((m) => m.category))], [menu]);
  const searching = q.trim().length > 0;
  const found = searching ? menu.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()) || (m.category || "").toLowerCase().includes(q.trim().toLowerCase())) : [];
  const [active, setActive] = useState(categories[0]);
  const sections = useRef(new Map());
  const tabsRef = useRef(null);
  const addProps = { canOrder, add, quickAdd };

  // The category tab follows the section being read.
  useEffect(() => {
    if (searching || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.dataset.cat);
      },
      { rootMargin: "-120px 0px -60% 0px" }
    );
    sections.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [searching, categories]);
  useEffect(() => {
    tabsRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [active]);
  const jump = (c) => {
    setActive(c);
    const el = sections.current.get(c);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 118, behavior: "smooth" });
  };

  const card = (m) => {
    const qty = qtyOf(m.id);
    return (
      <div key={m.id} className={"co-dish" + (qty ? " in-cart" : "")}>
        <img src={imgOf(m)} alt="" loading="lazy" onError={fallback(m)} />
        <div className="co-dish-text">
          <b>{m.name}</b>
          {best.has(m.id) && <span className="co-best">⭐ Bestseller</span>}
          {m.note && <span className="co-dish-note">{m.note}</span>}
          <span className="co-dish-price">{priceText(m, cur)}</span>
          {m.left != null && <span className="co-left">Only {m.left} left</span>}
        </div>
        <div className="co-dish-add">
          <AddButton m={m} qty={qty} {...addProps} />
        </div>
      </div>
    );
  };

  return (
    <div className="co-menu-tab">
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

      <div className="co-search">
        <span aria-hidden="true">🔍</span>
        <input type="search" placeholder="Search dishes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dishes" />
        {q && <button onClick={() => setQ("")} aria-label="Clear search">✕</button>}
      </div>

      {searching ? (
        <section className="co-section">
          <h3>{found.length ? `${found.length} dish${found.length === 1 ? "" : "es"} found` : "No dishes match"}</h3>
          {found.map(card)}
        </section>
      ) : (
        <>
          {popular.length > 0 && (
            <section className="co-popular">
              <h3>⭐ Bestsellers</h3>
              <div className="co-pop-row">
                {popular.map((m) => (
                  <PopularCard key={m.id} m={m} cur={cur} qty={qtyOf(m.id)} {...addProps} />
                ))}
              </div>
            </section>
          )}
          <div className="co-cats" ref={tabsRef}>
            {categories.map((c) => (
              <button key={c} className={c === active ? "on" : ""} onClick={() => jump(c)}>{c}</button>
            ))}
          </div>
          {categories.map((c) => (
            <section key={c} className="co-section" data-cat={c} ref={(el) => sections.current.set(c, el)}>
              <h3>{c}</h3>
              {menu.filter((m) => m.category === c).map(card)}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
