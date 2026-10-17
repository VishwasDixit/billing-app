import { useEffect, useMemo, useReducer, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp, accessState } from "../lib/store.jsx";
import { computeTotals } from "../../shared/totals.js";
import { money } from "../lib/format.js";
import { Modal, Seg, useToast } from "../components/ui.jsx";
import { printBill } from "../printer/index.js";
import { connect, connectedName, explainPrintError, onPrinterChange } from "../printer/transports.js";
import { shareBillPdf } from "../printer/pdf.js";

const lineKey = (itemId, variant) => `${itemId}|${variant}`;

export default function Billing() {
  const { shop, menu, recordBill } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const cur = shop.currency || "₹";

  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [cart, setCart] = useState(() => new Map()); // key -> line
  const [picker, setPicker] = useState(null); // item with variants
  const [discount, setDiscount] = useState(shop.defaultDiscount || { type: "percent", value: 0 });
  const [gstPercent, setGstPercent] = useState(shop.gstPercent || 0);
  const [paymentMode, setPaymentMode] = useState("cash");
  const [cartOpen, setCartOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [printError, setPrintError] = useState(null);

  // Shop defaults may change in Settings.
  useEffect(() => setDiscount(shop.defaultDiscount || { type: "percent", value: 0 }), [shop.defaultDiscount]);
  useEffect(() => setGstPercent(shop.gstPercent || 0), [shop.gstPercent]);

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

  const tap = (item) => (item.variants.length > 1 ? setPicker(item) : add(item, item.variants[0]));

  const setQty = (key, qty) =>
    setCart((prev) => {
      const next = new Map(prev);
      qty = Math.max(0, Math.floor(qty) || 0);
      if (qty === 0) next.delete(key);
      else next.set(key, { ...next.get(key), qty });
      return next;
    });

  const lines = [...cart.entries()];
  const t = computeTotals(lines.map(([, l]) => l), discount, gstPercent);
  const access = accessState(shop);

  // Saves the bill, then prints / shares it. The bill is kept even if printing fails.
  async function finish(kind) {
    if (!cart.size || busy) return;
    if (!access.active) {
      toast("Your plan has ended. Choose a plan to keep billing.");
      return nav("/plans");
    }
    setBusy(kind);
    setPrintError(null);
    try {
      const bill = await recordBill({ items: lines.map(([, l]) => l), discount, gstPercent, paymentMode });
      setCart(new Map());
      setDiscount(shop.defaultDiscount || { type: "percent", value: 0 });
      setGstPercent(shop.gstPercent || 0);
      setPaymentMode("cash");
      setCartOpen(false);
      if (kind === "print") {
        try {
          await printBill(shop, bill);
          toast(`Bill ${bill.billNo} saved and printed`);
        } catch (err) {
          const msg = explainPrintError(err);
          if (msg) setPrintError({ bill, msg });
          else toast(`Bill ${bill.billNo} saved (not printed)`);
        }
      } else if (kind === "pdf") {
        const r = await shareBillPdf(shop, bill);
        toast(`Bill ${bill.billNo} saved${r === "downloaded" ? " · PDF downloaded" : ""}`);
      } else {
        toast(`Bill ${bill.billNo} saved`);
      }
    } catch (err) {
      toast("Couldn't save the bill: " + err.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="billing">
      <section className="menu-panel">
        <div className="menu-tools">
          <input className="input" type="search" placeholder="Search menu…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Link className="btn" to="/menu">Edit menu</Link>
        </div>
        <div className="chips">
          {categories.map((c) => (
            <button key={c} className={"chip" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="menu-grid">
          {shown.length === 0 && <div className="empty" style={{ gridColumn: "1/-1" }}>{menu.length ? "No items match." : "Your menu is empty. Tap “Edit menu” to add items."}</div>}
          {shown.map((m, i) => {
            const qty = qtyOf(m.id);
            const showCat = cat === "All" && !q && (i === 0 || (shown[i - 1].category || "Other") !== (m.category || "Other"));
            const prices = m.variants.map((v) => v.price);
            return [
              showCat && <div key={"c" + m.id} className="cat-title">{m.category || "Other"}</div>,
              <button key={m.id} className="menu-item" onClick={() => tap(m)}>
                {qty > 0 && <span className="badge">{qty}</span>}
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
          <h2>Current bill</h2>
          <div className="btn-row">
            {cart.size > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => confirm("Clear all items?") && setCart(new Map())}>
                Clear
              </button>
            )}
            <button className="btn btn-ghost btn-sm cart-close" onClick={() => setCartOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="cart-list">
          {lines.length === 0 && <div className="empty">Tap menu items to add them.</div>}
          {lines.map(([key, l]) => (
            <div className="cart-line" key={key}>
              <div>
                <div className="ln-name">
                  {l.name}
                  {l.variant && <span className="tag" style={{ marginLeft: 6 }}>{l.variant}</span>}
                </div>
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
            <input type="number" min="0" step="0.01" inputMode="decimal" value={discount.value} onChange={(e) => setDiscount({ ...discount, value: Math.max(0, parseFloat(e.target.value) || 0) })} />
            <select value={discount.type} onChange={(e) => setDiscount({ ...discount, type: e.target.value })}>
              <option value="percent">%</option>
              <option value="flat">{cur}</option>
            </select>
          </div>
          <span className="muted">GST %</span>
          <div className="inline">
            <input type="number" min="0" step="0.01" inputMode="decimal" value={gstPercent} onChange={(e) => setGstPercent(Math.max(0, parseFloat(e.target.value) || 0))} />
          </div>
          <span className="muted">Payment</span>
          <div className="inline">
            <Seg value={paymentMode} onChange={setPaymentMode} options={[["cash", "Cash"], ["upi", "UPI"], ["card", "Card"]]} />
          </div>
        </div>

        <div className="totals">
          <div className="row"><span>Subtotal</span><span>{money(t.subtotal, cur)}</span></div>
          {t.discount.amount > 0 && <div className="row"><span>Discount{t.discount.type === "percent" ? ` (${t.discount.value}%)` : ""}</span><span>−{money(t.discount.amount, cur)}</span></div>}
          {t.gst.percent > 0 && <div className="row"><span>GST ({t.gst.percent}%)</span><span>{money(t.gst.amount, cur)}</span></div>}
          <div className="row grand"><span>Total</span><span>{money(t.total, cur)}</span></div>
        </div>

        <PrinterBar method={shop.printer?.method} />

        <div className="bill-actions">
          <button className="btn btn-primary btn-lg" disabled={!cart.size || !!busy} onClick={() => finish("print")}>
            {busy === "print" ? "Printing…" : "Print bill"}
          </button>
          <button className="btn btn-lg" disabled={!cart.size || !!busy} onClick={() => finish("pdf")} title="Save and share as PDF">
            PDF
          </button>
          <button className="btn btn-lg" disabled={!cart.size || !!busy} onClick={() => finish("save")} title="Save without printing">
            Save
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
            <Link key="s" className="btn" to="/settings">Printer settings</Link>,
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
