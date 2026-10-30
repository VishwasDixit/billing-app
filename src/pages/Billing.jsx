import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { markBilledLocally } from "../lib/orders.js";
import { useApp, accessState } from "../lib/store.jsx";
import { post, put } from "../lib/api.js";
import { isOwner } from "../lib/roles.js";
import { EDIT_REASONS, isOldBill } from "../../shared/billChanges.js";
import { computeTotals } from "../../shared/totals.js";
import { money, todayYmd } from "../lib/format.js";
import { Modal, Seg, useToast } from "../components/ui.jsx";
import { printBill } from "../printer/index.js";
import { connect, connectedName, explainPrintError, onPrinterChange } from "../printer/transports.js";
import { shareBillPdf } from "../printer/pdf.js";
import { ItemPicture } from "../components/ItemPicture.jsx";
import { useShowPictures } from "../lib/prefs.js";
import { CustomerPicker } from "../components/CustomerPicker.jsx";
import { addonText } from "../../shared/addons.js";

// Lines with add-ons (from QR or staff orders) stay apart from the plain dish.
const lineKey = (itemId, variant, addons) => (addons?.length ? `${itemId}|${variant}|${addonText(addons)}` : `${itemId}|${variant}`);

export default function Billing() {
  const { shop, menu, recordBill, customers, user } = useApp();
  const owner = isOwner(user);
  const toast = useToast();
  const nav = useNavigate();
  const cur = shop.currency || "₹";

  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [cart, setCart] = useState(() => new Map()); // key -> line
  const [picker, setPicker] = useState(null); // item with variants
  const [discount, setDiscount] = useState(shop.defaultDiscount || { type: "percent", value: 0 });
  // A promo code behind the discount: applied here ("billing") or from the table's QR orders ("orders").
  const [promo, setPromo] = useState(null); // { code, amount, source }
  const [promoCode, setPromoCode] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [gstPercent, setGstPercent] = useState(shop.gstPercent || 0);
  const [paymentMode, setPaymentMode] = useState("cash");
  const [customer, setCustomer] = useState(null); // udhar customer
  const [paidNow, setPaidNow] = useState(0);
  const [cartOpen, setCartOpen] = useState(false);
  // "" = today. A past date bills a missed day; it stays until changed back.
  const [billDate, setBillDate] = useState("");
  // Billing a table: its orders' items fill the cart, and the bill closes those orders.
  const location = useLocation();
  const [tableBill, setTableBill] = useState(null);
  // Changing a saved bill (from Bill history › Edit): same number and date, with a reason.
  const [editBill, setEditBill] = useState(null);
  const [editReason, setEditReason] = useState("");
  const [editPin, setEditPin] = useState("");
  // The bill being made survives a refresh or an app update (kept on this device only).
  const draftKey = `billDraft:${shop.id}`;
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || location.state?.tableBill || location.state?.editBill) return;
    restored.current = true;
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (!d?.cart?.length) return;
      setCart(new Map(d.cart));
      if (d.discount) setDiscount(d.discount);
      if (d.promo) setPromo(d.promo);
      if (d.gstPercent != null) setGstPercent(d.gstPercent);
      if (d.paymentMode) setPaymentMode(d.paymentMode);
      if (d.customer) setCustomer(d.customer);
      if (d.paidNow) setPaidNow(d.paidNow);
      if (d.billDate) setBillDate(d.billDate);
      if (d.tableBill) setTableBill(d.tableBill);
      if (d.editBill) setEditBill(d.editBill);
    } catch {
      /* no saved bill */
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restored.current) return;
    try {
      if (!cart.size) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify({ cart: [...cart.entries()], discount, promo, gstPercent, paymentMode, customer, paidNow, billDate, tableBill, editBill }));
    } catch {
      /* storage full or blocked */
    }
  }, [cart, discount, promo, gstPercent, paymentMode, customer, paidNow, billDate, tableBill, editBill, draftKey]);

  useEffect(() => {
    const b = location.state?.editBill;
    if (!b) return;
    restored.current = true;
    setEditBill({ id: b.id, billNo: b.billNo, createdAt: b.createdAt, total: b.total });
    setTableBill(null);
    setBillDate("");
    setCart(new Map(b.items.map((l) => [lineKey(l.itemId || l.name, l.variant || "", l.addons), { itemId: l.itemId, name: l.name, variant: l.variant || "", category: l.category || "", rate: l.rate, qty: l.qty, ...(l.charge && { charge: true }), ...(l.addons?.length && { addons: l.addons }) }])));
    setDiscount({ type: b.discount?.type || "percent", value: b.discount?.value || 0 });
    setPromo(null);
    setGstPercent(b.gst?.percent || 0);
    setPaymentMode(b.paymentMode || "cash");
    setCustomer(b.customer || null);
    setPaidNow(b.paidNow || 0);
    setEditReason("");
    setEditPin("");
    setCartOpen(true);
    nav(".", { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancelEdit = () => {
    setEditBill(null);
    setCart(new Map());
    setDiscount(shop.defaultDiscount || { type: "percent", value: 0 });
      setPromo(null);
    setGstPercent(shop.gstPercent || 0);
    setPaymentMode("cash");
    setCustomer(null);
    setPaidNow(0);
    nav("/bills");
  };

  useEffect(() => {
    const tb = location.state?.tableBill;
    if (!tb) return;
    restored.current = true;
    setTableBill(tb);
    setCart(new Map(tb.lines.map((l) => [lineKey(l.itemId, l.variant, l.addons), { ...l }])));
    if (tb.payMode) setPaymentMode(tb.payMode);
    if (tb.customer) setCustomer(tb.customer);
    // Codes the customers used on these QR orders (already counted with the orders).
    setPromo(tb.promo?.amount > 0 ? { code: tb.promo.code, amount: tb.promo.amount, source: "orders" } : null);
    setCartOpen(true);
    nav(".", { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stop the menu behind the full-screen bill sheet from scrolling on phones.
  useEffect(() => {
    document.body.classList.toggle("sheet-open", cartOpen);
    return () => document.body.classList.remove("sheet-open");
  }, [cartOpen]);
  const [busy, setBusy] = useState("");
  const [printError, setPrintError] = useState(null);
  const [showPictures] = useShowPictures();

  // Shop defaults may change in Settings.
  useEffect(() => void (!editBill && setDiscount(shop.defaultDiscount || { type: "percent", value: 0 })), [shop.defaultDiscount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void (!editBill && setGstPercent(shop.gstPercent || 0)), [shop.gstPercent]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = menu.filter((m) => m.active !== false);
  const categories = useMemo(() => ["All", ...new Set(active.map((m) => m.category || "Other"))], [active]);
  const shown = active.filter(
    (m) => (cat === "All" || (m.category || "Other") === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase()))
  );

  const qtyOf = (itemId) => [...cart.values()].filter((l) => l.itemId === itemId).reduce((s, l) => s + l.qty, 0);

  // Functional updates so quick repeated taps never lose an item.
  const add = (item, variant) =>
    setCart((prev) => {
      const key = lineKey(item.id, variant.label);
      const next = new Map(prev);
      const line = next.get(key);
      next.set(key, line ? { ...line, qty: line.qty + 1 } : { itemId: item.id, name: item.name, variant: variant.label, category: item.category, rate: variant.price, qty: 1 });
      return next;
    });

  const tap = (item) => {
    if (item.soldOut && !confirm(`${item.name} is marked sold out. Add it anyway?`)) return;
    return item.variants.length > 1 ? setPicker(item) : add(item, item.variants[0]);
  };

  const setQty = (key, qty) =>
    setCart((prev) => {
      const next = new Map(prev);
      qty = Math.max(0, Math.floor(qty) || 0);
      if (qty === 0) next.delete(key);
      else next.set(key, { ...next.get(key), qty });
      return next;
    });

  const lines = [...cart.entries()];
  // A promo code sets the discount while it's applied (the typed discount comes back when it's removed).
  const billDiscount = promo ? { type: "flat", value: promo.amount } : discount;
  const t = computeTotals(lines.map(([, l]) => l), billDiscount, gstPercent);
  const credit = paymentMode === "credit";
  const applyPromo = async (code = promoCode) => {
    code = code.trim().toUpperCase();
    if (!code || promoBusy) return;
    setPromoBusy(true);
    try {
      const r = await post("/promos/check", { code, subtotal: t.subtotal, table: tableBill?.table || "", phone: customer?.phone || "" });
      setPromo({ code: r.code, amount: r.amount, source: "billing" });
      setPromoCode("");
      toast(`${r.code} applied: −${money(r.amount, cur)}`);
    } catch (err) {
      toast(err.offline ? "Promo codes need internet. You can still type a discount." : err.message);
    } finally {
      setPromoBusy(false);
    }
  };
  const removePromo = () => setPromo(null);
  // Items changed: check the code again (minimum order, percent of the new total).
  useEffect(() => {
    if (!cart.size && promo) return removePromo();
    if (promo?.source !== "billing") return;
    const id = setTimeout(async () => {
      try {
        const r = await post("/promos/check", { code: promo.code, subtotal: t.subtotal, table: tableBill?.table || "", phone: customer?.phone || "" });
        if (r.amount !== promo.amount) setPromo({ ...promo, amount: r.amount });
      } catch (err) {
        if (err.offline) return;
        removePromo();
        toast(`${promo.code} removed: ${err.message}`);
      }
    }, 600);
    return () => clearTimeout(id);
  }, [t.subtotal, cart.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const paidNowClamped = Math.min(Math.max(Number(paidNow) || 0, 0), t.total);
  const udharThisBill = Math.round((t.total - paidNowClamped) * 100) / 100;
  const currentDue = customer ? customers.find((c) => c.clientId === customer.clientId)?.due || 0 : 0;
  const askCustomer = shop.askCustomer || "optional";
  const needCustomer = (credit || askCustomer === "required") && !customer;
  const access = accessState(shop);
  const today = todayYmd();
  const pastDate = billDate && billDate < today ? billDate : "";
  const pastLabel = pastDate
    ? new Date(pastDate + "T12:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) + (pastDate === todayYmd(-1) ? " (yesterday)" : "")
    : "";

  // Saves the bill, then prints / shares it. The bill is kept even if printing fails.
  async function finish(kind) {
    if (!cart.size || busy) return;
    if (needCustomer) return toast(credit ? "Choose the customer for this udhar bill." : "Add the customer's name and phone for this bill.");
    if (editBill) return saveEdit(kind);
    if (!access.active) {
      toast(owner ? "Your plan has ended. Choose a plan to keep billing." : "The shop's plan has ended. Ask the owner to renew it.");
      return owner ? nav("/plans") : undefined;
    }
    setBusy(kind);
    setPrintError(null);
    try {
      const bill = await recordBill({
        items: lines.map(([, l]) => l), discount: billDiscount, gstPercent, paymentMode, customer, paidNow: paidNowClamped, billDate: pastDate, table: tableBill?.tableName, orderIds: tableBill?.orderIds,
        promo: promo && t.discount.amount > 0 ? { code: promo.code, source: promo.source } : undefined,
      });
      if (tableBill) {
        await markBilledLocally(tableBill.orderIds);
        setTableBill(null);
      }
      setCart(new Map());
      setDiscount(shop.defaultDiscount || { type: "percent", value: 0 });
      setPromo(null);
      setGstPercent(shop.gstPercent || 0);
      setPaymentMode("cash");
      setCustomer(null);
      setPaidNow(0);
      setCartOpen(false);
      if (kind === "print") {
        try {
          await printBill(shop, bill);
          toast(`Bill ${bill.billNo} saved${pastDate ? ` for ${pastLabel}` : ""} and printed`);
        } catch (err) {
          const msg = explainPrintError(err);
          if (msg) setPrintError({ bill, msg });
          else toast(`Bill ${bill.billNo} saved (not printed)`);
        }
      } else if (kind === "pdf") {
        const r = await shareBillPdf(shop, bill);
        toast(`Bill ${bill.billNo} saved${r === "downloaded" ? " · PDF downloaded" : ""}`);
      } else {
        toast(`Bill ${bill.billNo} saved${pastDate ? ` for ${pastLabel}` : ""}`);
      }
    } catch (err) {
      toast("Couldn't save the bill: " + err.message);
    } finally {
      setBusy("");
    }
  }

  // Saves the changed bill (online only), then prints the REVISED copy if asked.
  async function saveEdit(kind) {
    if (!editReason) return toast("Choose why this bill is being changed.");
    setBusy(kind);
    try {
      const bill = await put(`/bills/${editBill.id}`, {
        items: lines.map(([, l]) => ({ itemId: l.itemId || "", name: l.name, variant: l.variant || "", category: l.category || "", qty: l.qty, rate: l.rate, ...(l.charge && { charge: true }), ...(l.addons?.length && { addons: l.addons }) })),
        discount: { type: discount.type, value: Number(discount.value) || 0 },
        gstPercent: Number(gstPercent) || 0,
        paymentMode,
        ...(customer && { customer: { clientId: customer.clientId, name: customer.name, phone: customer.phone || "" } }),
        ...(credit && { paidNow: paidNowClamped }),
        reason: editReason,
        ...(editPin && { pin: editPin }),
      });
      setEditBill(null);
      setCart(new Map());
      setDiscount(shop.defaultDiscount || { type: "percent", value: 0 });
      setPromo(null);
      setGstPercent(shop.gstPercent || 0);
      setPaymentMode("cash");
      setCustomer(null);
      setPaidNow(0);
      setCartOpen(false);
      if (kind === "print") {
        try {
          await printBill(shop, bill);
          toast(`Bill ${bill.billNo} updated and printed (REVISED)`);
        } catch (err) {
          const msg = explainPrintError(err);
          if (msg) setPrintError({ bill, msg });
          else toast(`Bill ${bill.billNo} updated (not printed)`);
        }
      } else if (kind === "pdf") {
        await shareBillPdf(shop, bill);
        toast(`Bill ${bill.billNo} updated`);
      } else toast(`Bill ${bill.billNo} updated`);
    } catch (err) {
      toast(err.offline ? "Editing a bill needs internet. Try again when online." : "Couldn't update the bill: " + err.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="billing">
      <section className="menu-panel">
        <div className="menu-tools">
          <input className="input" type="search" placeholder="Search menu…" value={q} onChange={(e) => setQ(e.target.value)} />
          {owner && <Link className="btn" to="/menu">Edit menu</Link>}
        </div>
        {pastDate && (
          <div className="past-date-bar">
            📅 Billing for <b>{pastLabel}</b>
            <button className="link-btn" onClick={() => setBillDate("")}>Back to today</button>
          </div>
        )}
        <div className="chips">
          {categories.map((c) => (
            <button key={c} className={"chip" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className={"menu-grid" + (showPictures ? " with-pics" : "")}>
          {shown.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>{menu.length ? "No items match." : "Your menu is empty. Tap “Edit menu” to add items."}</div>}
          {shown.map((m, i) => {
            const qty = qtyOf(m.id);
            const showCat = cat === "All" && !q && (i === 0 || (shown[i - 1].category || "Other") !== (m.category || "Other"));
            const prices = m.variants.map((v) => v.price);
            return [
              showCat && <div key={"c" + m.id} className="cat-title">{m.category || "Other"}</div>,
              <button key={m.id} className={"menu-item" + (m.soldOut ? " sold-out" : "")} onClick={() => tap(m)}>
                {qty > 0 && <span className="badge">{qty}</span>}
                {m.soldOut ? <span className="sold-tag">Sold out</span> : typeof m.stock === "number" && m.stock <= 5 && <span className="sold-tag low">{m.stock} left</span>}
                {showPictures && <ItemPicture item={m} className="tile-pic" />}
                <span className="name">{m.name}</span>
                <span className="price">
                  {m.variants.length > 1 ? prices.map((p) => money(p, cur)).join(" / ") : money(prices[0], cur)}
                </span>
              </button>,
            ];
          })}
        </div>
      </section>

      {cart.size > 0 && !cartOpen && (
        <button className="cart-toggle" onClick={() => setCartOpen(true)}>
          <span>View bill · {t.itemCount} item{t.itemCount > 1 ? "s" : ""}</span>
          <span>{money(t.total, cur)}</span>
        </button>
      )}

      <aside className={"cart-panel" + (cartOpen ? " open" : "")}>
        <div className="cart-head">
          <h2>{editBill ? `Edit bill ${editBill.billNo}` : "Current bill"}</h2>
          <div className="btn-row">
            {cart.size > 0 && (
              !editBill && <button className="btn btn-ghost btn-sm" onClick={() => confirm("Clear all items?") && (setCart(new Map()), setTableBill(null))}>
                Clear
              </button>
            )}
            <button className="btn btn-ghost btn-sm cart-close" onClick={() => setCartOpen(false)}>
              + Add items
            </button>
          </div>
        </div>
        {editBill && (
          <div className="edit-banner">
            <span>✏️ Changing bill {editBill.billNo} (was {money(editBill.total, cur)})</span>
            <button className="link-btn" onClick={cancelEdit}>Cancel edit</button>
          </div>
        )}
        {tableBill && (
          <div className="table-bill-bar">
            <span>🍽️ <b>{tableBill.tableName}</b> · orders {tableBill.orderNos.map((n) => `#${n}`).join(", ")}</span>
            <button className="link-btn" onClick={() => (setTableBill(null), setCart(new Map()))}>Cancel</button>
          </div>
        )}
        {tableBill?.prepaid > 0 && (
          <div className="table-bill-bar prepaid-bar">
            <span>💳 Paid with orders {tableBill.prepaidOrderNos.map((n) => `#${n}`).join(", ")}: <b>{money(tableBill.prepaid, cur)}</b></span>
            <span>{t.total - tableBill.prepaid > 0.009 ? <>Collect <b>{money(t.total - tableBill.prepaid, cur)}</b></> : <b>Nothing to collect ✓</b>}</span>
          </div>
        )}
        {!editBill && <div className={"bill-date" + (pastDate ? " past" : "")}>
          <label htmlFor="bill-date">📅 Bill date</label>
          <input
            id="bill-date"
            type="date"
            className="input"
            value={pastDate || today}
            max={today}
            min={todayYmd(-90)}
            onChange={(e) => setBillDate(e.target.value && e.target.value < today ? e.target.value : "")}
          />
          {pastDate ? (
            <button className="btn btn-sm btn-ghost" onClick={() => setBillDate("")}>Today</button>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setBillDate(todayYmd(-1))}>Yesterday</button>
          )}
        </div>}
        {pastDate && <div className="small past-note">This bill will be saved on {pastLabel} and count in that day's sales.</div>}
        <div className="cart-list">
          {lines.length === 0 && <div className="empty">Tap menu items to add them.</div>}
          {lines.map(([key, l]) => (
            <div className="cart-line" key={key}>
              <div>
                <div className="ln-name">
                  {l.name}
                  {l.variant && <span className="tag" style={{ marginLeft: 6 }}>{l.variant}</span>}
                </div>
                {l.addons?.length > 0 && <div className="small muted">+ {addonText(l.addons)}</div>}
                <div className="ln-rate">{money(l.rate, cur)}</div>
              </div>
              <div className="qty">
                <button onClick={() => setQty(key, l.qty - 1)} aria-label="Decrease">−</button>
                <input type="number" inputMode="numeric" min="0" value={l.qty} onChange={(e) => setQty(key, parseInt(e.target.value, 10))} />
                <button onClick={() => setQty(key, l.qty + 1)} aria-label="Increase">+</button>
              </div>
              <div className="ln-amt">{money(l.rate * l.qty, cur)}</div>
            </div>
          ))}
        </div>

        <div className="bill-opts">
          <span className="muted">Discount</span>
          <div className="inline">
            <input type="number" min="0" step="0.01" inputMode="decimal" disabled={!!promo} value={billDiscount.value} onChange={(e) => setDiscount({ ...discount, value: Math.max(0, parseFloat(e.target.value) || 0) })} />
            <select disabled={!!promo} value={billDiscount.type} onChange={(e) => setDiscount({ ...discount, type: e.target.value })}>
              <option value="percent">%</option>
              <option value="flat">{cur}</option>
            </select>
          </div>
          {!editBill && (
            <>
              <span className="muted">Promo</span>
              {promo ? (
                <div className="inline promo-on">
                  <span className="tag good">🏷 {promo.code} −{money(promo.amount, cur)}</span>
                  <button className="btn btn-sm btn-ghost" onClick={removePromo} aria-label="Remove promo code">✕</button>
                </div>
              ) : (
                <form className="inline" onSubmit={(e) => (e.preventDefault(), applyPromo())}>
                  <input placeholder="Code" maxLength={20} autoCapitalize="characters" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} style={{ textTransform: "uppercase" }} />
                  <button className="btn btn-sm" disabled={!promoCode || promoBusy || !cart.size}>{promoBusy ? "…" : "Apply"}</button>
                </form>
              )}
            </>
          )}
          <span className="muted">GST %</span>
          <div className="inline">
            <input type="number" min="0" step="0.01" inputMode="decimal" value={gstPercent} onChange={(e) => setGstPercent(Math.max(0, parseFloat(e.target.value) || 0))} />
          </div>
        </div>
        <div className="pay-row">
          <span className="muted">Payment</span>
          <Seg value={paymentMode} onChange={setPaymentMode} options={[["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["credit", "Udhar"]]} />
        </div>
        {!credit && askCustomer !== "off" && (
          <div className="cust-box">
            <span className="muted small">Customer{askCustomer === "required" ? " *" : " (optional)"}</span>
            <CustomerPicker value={customer} onChange={setCustomer} currency={cur} />
          </div>
        )}
        {credit && (
          <div className="udhar-box">
            <CustomerPicker value={customer} onChange={setCustomer} currency={cur} />
            <div className="bill-opts">
              <span className="muted">Paid now</span>
              <div className="inline">
                <input type="number" min="0" step="0.01" inputMode="decimal" value={paidNow} onChange={(e) => setPaidNow(Math.max(0, parseFloat(e.target.value) || 0))} />
              </div>
            </div>
            <div className="small">
              Udhar on this bill: <b className="due-text">{money(udharThisBill, cur)}</b>
              {customer && <> · Total due after: <b>{money(currentDue + udharThisBill, cur)}</b></>}
            </div>
          </div>
        )}

        <div className="totals">
          <div className="row"><span>Subtotal</span><span>{money(t.subtotal, cur)}</span></div>
          {t.discount.amount > 0 && <div className="row"><span>{promo ? `Promo ${promo.code}` : `Discount${t.discount.type === "percent" ? ` (${t.discount.value}%)` : ""}`}</span><span>−{money(t.discount.amount, cur)}</span></div>}
          {t.gst.percent > 0 && <div className="row"><span>GST ({t.gst.percent}%)</span><span>{money(t.gst.amount, cur)}</span></div>}
          <div className="row grand"><span>Total</span><span>{money(t.total, cur)}</span></div>
        </div>

        <PrinterBar method={shop.printer?.method} />

        {editBill && (
          <div className="edit-reason">
            <span className="small">Why are you changing it?</span>
            <div className="reason-grid">
              {Object.entries(EDIT_REASONS).map(([k, label]) => (
                <button key={k} type="button" className={"chip" + (editReason === k ? " on" : "")} onClick={() => setEditReason(k)}>{label}</button>
              ))}
            </div>
            {(shop.billPin || isOldBill(editBill)) && (
              <label className="field small">
                Owner PIN
                <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={editPin} onChange={(e) => setEditPin(e.target.value.replace(/\D/g, ""))} />
              </label>
            )}
          </div>
        )}
        <div className="bill-actions">
          <button className="btn btn-primary btn-lg" disabled={!cart.size || !!busy || needCustomer} onClick={() => finish("print")}>
            {busy === "print" ? "Printing…" : editBill ? "Update & print" : "Print bill"}
          </button>
          <button className="btn btn-lg" disabled={!cart.size || !!busy || needCustomer} onClick={() => finish("pdf")} title="Save and share as PDF">
            PDF
          </button>
          <button className="btn btn-lg" disabled={!cart.size || !!busy || needCustomer} onClick={() => finish("save")} title="Save without printing">
            {editBill ? "Update" : "Save"}
          </button>
        </div>
      </aside>

      {picker && (
        <Modal title={picker.name} onClose={() => setPicker(null)}>
          {picker.note && <p className="muted small" style={{ marginTop: -6 }}>{picker.note}</p>}
          <div className="variant-list">
            {picker.variants.map((v) => (
              <button
                key={v.label}
                onClick={() => {
                  add(picker, v);
                  setPicker(null);
                }}
              >
                <span>{v.label || "Regular"}</span>
                <b>{money(v.price, cur)}</b>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {printError && (
        <Modal
          title="Bill saved, but printing failed"
          onClose={() => setPrintError(null)}
          actions={[
            <Link key="s" className="btn" to="/settings/printer">Printer settings</Link>,
            <button
              key="r"
              className="btn btn-primary"
              onClick={async () => {
                const { bill } = printError;
                setPrintError(null);
                try {
                  await printBill(shop, bill);
                  toast(`Bill ${bill.billNo} printed`);
                } catch (err) {
                  const msg = explainPrintError(err);
                  if (msg) setPrintError({ bill, msg });
                }
              }}
            >
              Try again
            </button>,
          ]}
        >
          <p style={{ whiteSpace: "pre-wrap" }}>{printError.msg}</p>
          <p className="muted small">Bill {printError.bill.billNo} is saved. You can also reprint it later from Bills.</p>
        </Modal>
      )}
    </div>
  );
}

function PrinterBar({ method = "bluetooth" }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const toast = useToast();
  useEffect(() => onPrinterChange(rerender), []);
  if (method !== "bluetooth" && method !== "serial") return null;
  const name = connectedName(method);
  return (
    <div className="printer-bar">
      <span className={name ? "ok" : ""}>{name ? `Printer: ${name}` : "Printer: not connected"}</span>
      <button
        className="btn btn-sm"
        onClick={async () => {
          try {
            await connect(method);
          } catch (err) {
            const msg = explainPrintError(err);
            if (msg) toast(msg);
          }
        }}
      >
        {name ? "Change" : "Connect"}
      </button>
    </div>
  );
}
