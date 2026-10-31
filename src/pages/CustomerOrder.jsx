import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { get } from "../lib/api.js";
import { money } from "../lib/format.js";
import { lineKey, loadMine, saveMine, deviceKey, couponNudge, needsChoice } from "./customer/common.js";
import { BillAsk } from "./customer/parts.jsx";
import { Cart } from "./customer/Cart.jsx";
import { Customize, RepeatSheet } from "./customer/Customize.jsx";
import { MenuTab } from "./customer/MenuTab.jsx";
import { StatusTab } from "./customer/StatusTab.jsx";
import { HelpTab } from "./customer/HelpTab.jsx";
import { DiceGame } from "./customer/DiceGame.jsx";
import { InstaPopup, instaDue } from "./customer/InstaPopup.jsx";
import { DEFAULT_HELP } from "../../shared/tableHelp.js";
import { freeDeliveryGap } from "../../shared/tableGroups.js";
import { addonsTotal, checkAddons } from "../../shared/addons.js";

// Games load only when opened (the menu page stays light); the app caches them for offline.
const Games = lazy(() => import("./customer/games/Games.jsx"));

// What a status change says, on the toast and on the games' status bar.
const MOVED = {
  new: { icon: "📨", text: "waiting for the staff to confirm", tone: "" },
  accepted: { icon: "👨‍🍳", text: "accepted: the kitchen has it", tone: "cook" },
  preparing: { icon: "🍳", text: "is being cooked", tone: "cook" },
  ready: { icon: "🛎️", text: "Your food is ready!", tone: "ready" },
  served: { icon: "😋", text: "served. Enjoy your meal!", tone: "ready" },
  rejected: { icon: "⚠️", text: "wasn't accepted. Please ask the staff.", tone: "off" },
  unpaid: { icon: "⚠️", text: "was closed as not paid.", tone: "off" },
};

// The page a customer sees after scanning a table's QR code: menu, cart, their orders and help.
// Three tabs at the bottom (Menu · My orders · Help), the cart bar just above them.
export default function CustomerOrder() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const tableId = params.get("t") || "";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState(() => new Map());
  const [custom, setCustom] = useState(null); // { m, line? }: the customise sheet (line = editing it)
  const [repeat, setRepeat] = useState(null); // { m, line }: "repeat last?"
  const [review, setReview] = useState(false);
  const [mine, setMine] = useState(() => loadMine(token));
  const [tab, setTab] = useState(() =>
    !params.get("code") && loadMine(token).some((o) => !["rejected", "billed"].includes(o.status) || (o.bill && o.bill.paymentMode === "upi" && !o.bill.paymentConfirmed)) ? "orders" : "menu"
  );
  const [billAsk, setBillAsk] = useState(false);
  const [dicing, setDicing] = useState(false); // the dice game sheet
  const [playing, setPlaying] = useState(false); // the games while waiting
  const [insta, setInsta] = useState(false); // "post a story, get a meal free" (after ordering)
  const [toast, setToast] = useState(null); // { orderNo, status }: an order just moved on
  // A code sent on WhatsApp comes in the link (?code=…) and is put in the cart's coupon box.
  const [offerCode, setOfferCode] = useState(() => (params.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20));
  const [tableQ, setTableQ] = useState("");
  const [bump, setBump] = useState(0); // the cart bar bounces when something is added
  const device = useMemo(() => deviceKey(), []);
  const [help, setHelp] = useState([]); // this phone's requests to the staff
  const [priceNote, setPriceNote] = useState(""); // "Prices were updated by the restaurant"
  const top = useRef(null);

  const refreshMine = async () => {
    const next = await Promise.all(mine.map((o) => get(`/public/shop/${token}/orders/${o.id}?k=${o.key}`).then((s) => ({ ...o, ...s, checkedAt: Date.now() }), () => o)));
    setMine(next);
    saveMine(token, next);
  };
  const loadHelp = () => get(`/public/shop/${token}/help?d=${device}`).then((r) => setHelp(r.requests), () => {});

  // The menu for this table: far tables (a table group) have their own prices and a delivery charge.
  const menuUrl = `/public/shop/${token}${tableId ? `?t=${encodeURIComponent(tableId)}` : ""}`;
  useEffect(() => {
    loadHelp();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    get(menuUrl).then(setData, (e) => setError(e.message));
  }, [menuUrl]);
  // The menu changed (the shop edited it, or the table changed): what's in the cart takes the new
  // prices, and dishes or add-ons no longer offered drop out.
  const seenVersion = useRef(null);
  useEffect(() => {
    if (!data?.menu) return;
    const shopChanged = seenVersion.current !== null && seenVersion.current !== data.menuVersion;
    seenVersion.current = data.menuVersion;
    const byId = new Map(data.menu.map((m) => [m.id, m]));
    const gone = [];
    let repriced = false;
    const next = new Map();
    for (const [k, l] of cart) {
      const m = byId.get(l.itemId);
      const v = m?.variants.find((x) => (x.label || "") === l.variant);
      const { addons, error } = checkAddons(m?.addons, l.addonIds || []);
      if (!v || error) {
        gone.push(l.name);
        continue;
      }
      const rate = v.price + addonsTotal(addons);
      if (rate !== l.rate) repriced = true;
      next.set(k, { ...l, rate, addons });
    }
    if (gone.length || repriced) setCart(next);
    if (shopChanged && (gone.length || repriced)) {
      setPriceNote(gone.length ? `${[...new Set(gone)].join(", ")} ${gone.length > 1 ? "are" : "is"} no longer available and left your cart.` : "Prices were updated by the restaurant.");
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!priceNote) return;
    const t = setTimeout(() => setPriceNote(""), 12000);
    return () => clearTimeout(t);
  }, [priceNote]);

  // Back from Cashfree's payment page (?paid=<order>): ask the server how it went. The webhook
  // may be a moment behind, so check a few times.
  const [returning, setReturning] = useState(() => params.get("paid") || "");
  useEffect(() => {
    if (!returning) return;
    const o = loadMine(token).find((x) => x.id === returning);
    const next = new URLSearchParams(params);
    next.delete("paid");
    setParams(next, { replace: true });
    if (!o) return setReturning("");
    setTab("orders");
    let alive = true;
    (async () => {
      for (let i = 0; i < 6 && alive; i++) {
        try {
          const r = await get(`/public/shop/${token}/orders/${o.id}/pay-online?k=${o.key}`);
          if (r.pay.state !== "choose" && r.pay.state !== "due" && r.pay.state !== "end") break;
          if (r.pay.failed) break;
        } catch {
          /* try again */
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (alive) {
        await refreshMine();
        setReturning("");
      }
    })();
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live menu: every 15 s, and as soon as the phone comes back to this page, ask whether the shop
  // changed the menu (a tiny request) and fetch it again only then. Opening hours go by the clock,
  // so the whole menu is also fetched every 5 minutes (every minute while closed).
  const dataRef = useRef(null);
  dataRef.current = data;
  useEffect(() => {
    let fetchedAt = Date.now();
    let busy = false;
    const reload = () =>
      get(menuUrl).then(
        (d) => {
          fetchedAt = Date.now();
          setData(d);
        },
        () => {}
      );
    const check = async () => {
      const now = dataRef.current;
      if (document.hidden || !now || busy) return;
      busy = true;
      try {
        if (Date.now() - fetchedAt > (now.ordering?.closedForHours ? 60e3 : 5 * 60e3)) await reload();
        else if ((await get(`/public/shop/${token}/menu-version`)).v !== now.menuVersion) await reload();
      } catch {
        /* offline: try next time */
      } finally {
        busy = false;
      }
    };
    const onShow = () => !document.hidden && check();
    const t = setInterval(check, 15000);
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [menuUrl, token]);

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

  // An order moved on (accepted, cooking, ready…): a toast, even over the games, and a buzz.
  const seenStatus = useRef(null);
  useEffect(() => {
    const prev = seenStatus.current;
    seenStatus.current = new Map(mine.map((o) => [o.id, o.status]));
    if (!prev) return;
    const moved = mine.filter((o) => prev.has(o.id) && prev.get(o.id) !== o.status && MOVED[o.status] && o.status !== "new");
    if (!moved.length) return;
    const o = moved.at(-1);
    setToast({ orderNo: o.orderNo, status: o.status, at: Date.now() });
    try {
      navigator.vibrate?.(o.status === "ready" ? [120, 80, 120] : 60);
    } catch {
      /* not supported */
    }
  }, [mine]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.status === "ready" ? 12000 : 7000);
    return () => clearTimeout(t);
  }, [toast]);
  // The order the games' bar follows: the newest one still on its way.
  const following = [...mine].reverse().find((o) => ["new", "accepted", "preparing", "ready"].includes(o.status)) || [...mine].reverse().find((o) => o.status === "served");
  const followStatus = following && { orderNo: following.orderNo, ...MOVED[following.status] };

  // Waiting for the staff's answer: check every 10 s on the Help tab, else every 20 s.
  // (any request not marked done in the last 2 hours: staff may write again)
  const waitingHelp = help.some((r) => r.status !== "done" && Date.now() - new Date(r.createdAt) < 2 * 3600e3);
  useEffect(() => {
    if (!waitingHelp && tab !== "help") return;
    const t = setInterval(loadHelp, tab === "help" ? 10000 : 20000);
    return () => clearInterval(t);
  }, [waitingHelp, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // A dot on Help when the staff replied since the customer last looked.
  const [helpSeen, setHelpSeen] = useState(() => Number(localStorage.getItem("coHelpSeen") || 0));
  const newReply = help.some((r) => r.repliedAt && new Date(r.repliedAt).getTime() > helpSeen);
  useEffect(() => {
    if (tab !== "help" || !newReply) return;
    const now = Date.now();
    setHelpSeen(now);
    try {
      localStorage.setItem("coHelpSeen", String(now));
    } catch {
      /* private mode */
    }
  }, [tab, newReply]);

  // The tab (and a saved link) shows the shop's name, not the app's.
  const shopName = data?.shop.name;
  useEffect(() => {
    if (shopName) document.title = shopName;
  }, [shopName]);

  // A link with no table (sent on WhatsApp): open at the table this phone last ordered from.
  useEffect(() => {
    if (tableId || !data?.tables.length) return;
    const last = [...mine].reverse().map((o) => data.tables.find((t) => t.id === o.tableId) || data.tables.find((t) => t.name === o.tableName)).find(Boolean);
    if (!last) return;
    const next = new URLSearchParams(params);
    next.set("t", last.id);
    setParams(next, { replace: true });
  }, [data, tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = data?.tables.find((t) => t.id === tableId);
  // Offers for this table only (some codes are for some tables).
  const offers = (data?.offers || []).filter((o) => !o.tables?.length || o.tables.includes(tableId));
  const cur = data?.shop.currency || "₹";
  const lines = [...cart.values()];
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const canOrder = !!table && !!data?.ordering.open;
  // The shop decides if there's a Help tab (a library may not want one) and what it offers.
  const helpCfg = data?.help || DEFAULT_HELP;
  const helpOn = helpCfg.enabled && (helpCfg.asks.length > 0 || helpCfg.questions);
  useEffect(() => {
    if (data && !helpOn && tab === "help") setTab("menu");
  }, [data, helpOn, tab]);
  const nudge = couponNudge(offers, total);
  const deliveryGap = freeDeliveryGap({ delivery: data?.delivery }, total);
  const openOrders = mine.filter((o) => ["new", "accepted", "preparing", "ready", "served"].includes(o.status)).length;

  // A dish in a size with some add-ons (option ids); the line's rate includes the add-ons.
  const addLine = (m, v, addonIds = [], qty = 1, replaceKey = null) => {
    setBump((n) => n + 1);
    setCart((prev) => {
      const next = new Map(prev);
      if (replaceKey) next.delete(replaceKey);
      const k = lineKey(m.id, v.label || "", addonIds);
      const addons = (m.addons || []).flatMap((g) => g.options.filter((o) => addonIds.includes(o.id))).map(({ name, price }) => ({ name, price }));
      const had = next.get(k)?.qty || 0;
      next.set(k, { key: k, itemId: m.id, name: m.name, variant: v.label || "", rate: v.price + addonsTotal(addons), qty: Math.min(had + qty, 99), addonIds, addons });
      return next;
    });
  };
  const changeQty = (k, d) => {
    if (d > 0) setBump((n) => n + 1);
    setCart((prev) => {
      const l = prev.get(k);
      if (!l) return prev;
      const next = new Map(prev);
      const qty = l.qty + d;
      if (qty <= 0) next.delete(k);
      else next.set(k, { ...l, qty: Math.min(qty, 99) });
      return next;
    });
  };
  // One tap: plain dishes go straight in; customisable ones open the sheet (or "repeat last?").
  const quickAdd = (m) => {
    if (!needsChoice(m)) return addLine(m, m.variants[0]);
    const last = lines.filter((l) => l.itemId === m.id).at(-1);
    return last ? setRepeat({ m, line: last }) : setCustom({ m });
  };
  // − on the menu: one line takes one off; several (different add-ons) open the cart to choose.
  const less = (m) => {
    const of = lines.filter((l) => l.itemId === m.id);
    if (of.length === 1) changeQty(of[0].key, -1);
    else if (of.length > 1) setReview(true);
  };
  const qtyOf = (id) => lines.filter((l) => l.itemId === id).reduce((s, l) => s + l.qty, 0);
  // Everything taken out of the cart: back to the menu.
  useEffect(() => {
    if (review && !count) setReview(false);
  }, [review, count]);
  const editLine = (l) => {
    const m = data.menu.find((x) => x.id === l.itemId);
    if (m) setCustom({ m, line: l });
  };
  const go = (t) => {
    setTab(t);
    top.current?.scrollIntoView({ block: "start" });
  };

  if (error) return <div className="co-page"><div className="co-empty">😕 {error}</div></div>;
  if (!data) return <div className="co-page"><div className="co-loading"><span className="co-spinner" />Loading the menu…</div></div>;

  const hoursLine = !data.ordering.open ? (data.ordering.closedForHours ? "Closed now" : "Ordering paused") : data.hours ? `Open · ${data.hours}` : "Open now";

  return (
    <div className="co-page co-app" ref={top}>
      <header className="co-top">
        {data.shop.logo ? <img className="co-top-logo" src={data.shop.logo} alt="" /> : <span className="co-top-logo co-logo">🍽️</span>}
        <div className="co-top-text">
          <b>{data.shop.name}</b>
          <div className="co-top-sub">
            {table ? <span className="co-table-pill">🪑 {table.name}</span> : <span className="co-table-pill none">Choose your table</span>}
            <span className={"co-open " + (data.ordering.open ? "on" : "off")}>{hoursLine}</span>
          </div>
        </div>
        {helpOn && <button className="co-help-btn" onClick={() => go("help")} aria-label="Help">💬{newReply && <i className="co-dot" />}</button>}
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

      <main className="co-main">
        {tab === "menu" && (
          <MenuTab data={data} cur={cur} offers={offers} offerCode={offerCode} setOfferCode={setOfferCode} q={q} setQ={setQ} canOrder={canOrder} quickAdd={quickAdd} less={less} qtyOf={qtyOf} token={token} onDice={() => setDicing(true)} />
        )}
        {tab === "orders" && (
          <StatusTab
            token={token}
            data={data}
            mine={mine}
            cur={cur}
            returning={returning}
            canOrder={canOrder}
            refreshMine={refreshMine}
            onAskBill={() => setBillAsk(true)}
            quickAdd={quickAdd}
            less={less}
            qtyOf={qtyOf}
            onMenu={() => go("menu")}
            onGames={() => setPlaying(true)}
            onInsta={data?.insta ? () => setInsta(true) : null}
            helpOn={helpOn}
          />
        )}
        {tab === "help" && helpOn && (
          <HelpTab
            token={token}
            data={data}
            table={table}
            offers={offers}
            cur={cur}
            device={device}
            requests={help}
            onSent={loadHelp}
            onOrders={() => go("orders")}
            onMenu={() => go("menu")}
            helpCfg={helpCfg}
          />
        )}
      </main>

      {priceNote && count === 0 && tab !== "help" && (
        <div className="co-cart-wrap">
          <div className="co-nudge co-price-note">🔄 {priceNote}</div>
        </div>
      )}
      {count > 0 && tab !== "help" && (
        <div className="co-cart-wrap">
          {priceNote && <div className="co-nudge co-price-note">🔄 {priceNote}</div>}
          {data.delivery?.freeFrom > 0 && (
            <div className={"co-nudge" + (deliveryGap ? "" : " done")}>
              {deliveryGap ? (
                <>
                  <span>🛵 Add <b>{money(Math.ceil(deliveryGap), cur)}</b> more for <b>free delivery</b></span>
                  <i className="co-nudge-bar"><i style={{ width: `${Math.round(Math.min(1, total / data.delivery.freeFrom) * 100)}%` }} /></i>
                </>
              ) : (
                <span>🛵 Free delivery unlocked 🎉</span>
              )}
            </div>
          )}
          {nudge && (
            <div className={"co-nudge" + (nudge.unlocked ? " done" : "")}>
              {nudge.unlocked ? (
                <button className="link-btn" onClick={() => (setOfferCode(nudge.offer.code), setReview(true))}>🎉 {nudge.offer.code} unlocked: tap to apply</button>
              ) : (
                <>
                  <span>Add <b>{money(Math.ceil(nudge.short), cur)}</b> more to use <b>{nudge.offer.code}</b>{nudge.offer.description ? ` · ${nudge.offer.description}` : ""}</span>
                  <i className="co-nudge-bar"><i style={{ width: `${Math.round(nudge.progress * 100)}%` }} /></i>
                </>
              )}
            </div>
          )}
          <button key={bump} className="co-cartbar bump" onClick={() => setReview(true)}>
            <span className="co-cart-count">{count}</span>
            <span>{count === 1 ? "item" : "items"} · <b>{money(total, cur)}</b></span>
            <b className="co-cart-go">View cart →</b>
          </button>
        </div>
      )}

      <nav className="co-tabs">
        <button className={tab === "menu" ? "on" : ""} onClick={() => go("menu")}><span>🍽️</span>Menu</button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => go("orders")}>
          <span>🧾{openOrders > 0 && <i className="co-badge">{openOrders}</i>}</span>My orders
        </button>
        {helpOn && (
          <button className={tab === "help" ? "on" : ""} onClick={() => go("help")}>
            <span>💬{newReply && <i className="co-dot" />}</span>Help
          </button>
        )}
      </nav>

      {custom && (
        <Customize
          key={custom.line?.key || custom.m.id}
          m={custom.m}
          cur={cur}
          editing={!!custom.line}
          initial={custom.line && { variant: custom.line.variant, addonIds: custom.line.addonIds, qty: custom.line.qty }}
          onClose={() => setCustom(null)}
          onAdd={({ v, addonIds, qty }) => {
            addLine(custom.m, v, addonIds, qty, custom.line?.key);
            setCustom(null);
          }}
        />
      )}
      {repeat && (
        <RepeatSheet
          line={repeat.line}
          cur={cur}
          onClose={() => setRepeat(null)}
          onChoose={() => (setCustom({ m: repeat.m }), setRepeat(null))}
          onRepeat={() => (changeQty(repeat.line.key, 1), setRepeat(null))}
        />
      )}

      {playing && (
        <Suspense fallback={<div className="gm-page"><div className="gm-loading"><span className="co-spinner" />Loading games…</div></div>}>
          <Games status={followStatus} onClose={() => (setPlaying(false), setTab("orders"))} />
        </Suspense>
      )}
      {toast && (
        <button
          key={toast.at}
          className={`co-toast ${MOVED[toast.status].tone}`}
          role="status"
          onClick={() => {
            setToast(null);
            if (playing) history.back();
            go("orders");
          }}
        >
          <span className="co-toast-icon" aria-hidden="true">{MOVED[toast.status].icon}</span>
          <span>
            {toast.status === "ready" ? <><b>Your food is ready!</b> Order #{toast.orderNo}</> : <><b>Order #{toast.orderNo}</b> {MOVED[toast.status].text}</>}
          </span>
          <span className="co-toast-x">Tap to see</span>
        </button>
      )}

      {insta && data?.insta && !playing && <InstaPopup token={token} insta={data.insta} cur={cur} onClose={() => setInsta(false)} />}
      {dicing && data?.dice && (
        <DiceGame
          token={token}
          rule={data.dice}
          cur={cur}
          onClose={() => setDicing(false)}
          onWin={(code) => setOfferCode(code)}
        />
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

      {review && table && count > 0 && (
        <Cart
          token={token}
          data={data}
          table={table}
          lines={lines}
          cur={cur}
          total={total}
          changeQty={changeQty}
          onEdit={editLine}
          onClose={() => setReview(false)}
          offers={offers}
          initialCode={offerCode}
          cardProps={{ quickAdd, less }}
          priceNote={priceNote}
          onPlaced={(o) => {
            const next = [...mine, o];
            setMine(next);
            saveMine(token, next);
            setCart(new Map());
            setOfferCode("");
            setReview(false);
            go("orders");
            if (data?.insta && instaDue(token)) setTimeout(() => setInsta(true), 900);
          }}
        />
      )}
    </div>
  );
}
