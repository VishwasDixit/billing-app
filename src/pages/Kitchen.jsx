import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useOrders, allOrders, setOrderStatus, beep } from "../lib/orders.js";
import { useToast } from "../components/ui.jsx";
import { useOrderPolling, useKotPrinter, ago } from "./Orders.jsx";
import { RecipeView } from "./kitchen/Recipes.jsx";
import { useApp } from "../lib/store.jsx";

// Kitchen display: accepted orders move To cook → Cooking → Ready. Big text for a tablet on the wall.
const COLUMNS = [
  ["accepted", "To cook", "preparing", "Start cooking"],
  ["preparing", "Cooking", "ready", "Food ready"],
  ["ready", "Ready", "served", "Served"],
];

export default function Kitchen() {
  const st = useOrders();
  const toast = useToast();
  const kot = useKotPrinter();
  const { user } = useApp();
  const [recipe, setRecipe] = useState(null);
  const [, tick] = useState(0);
  useOrderPolling(5000);
  // Re-render every 30 s so the "minutes ago" counters move.
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const orders = allOrders(st);
  // Beep when a new order reaches the kitchen.
  const seen = useRef(null);
  useEffect(() => {
    const ids = orders.filter((o) => o.status === "accepted").map((o) => o.clientId);
    if (seen.current && ids.some((id) => !seen.current.has(id))) beep();
    seen.current = new Set(ids);
  }, [orders]);

  const move = async (o, status) => {
    try {
      await setOrderStatus(o, status);
    } catch (err) {
      toast(err.message);
    }
  };

  return (
    <div className="kitchen">
      <div className="kitchen-head">
        <h1>🍳 Kitchen</h1>
        <div className="btn-row">
          {!st.online && <span className="tag warn">Offline · showing saved orders</span>}
          <button className="btn btn-sm" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Full screen</button>
          <Link className="btn btn-sm" to="/kitchen-manage">🥫 Stock</Link>
          <Link className="btn btn-sm" to="/orders">Tables</Link>
          {user.role !== "kitchen" && <Link className="btn btn-sm" to="/">✕ Close</Link>}
        </div>
      </div>
      <div className="kitchen-cols">
        {COLUMNS.map(([status, title, next, action]) => {
          const list = orders.filter((o) => o.status === status);
          return (
            <section key={status} className={"kitchen-col " + status}>
              <h2>{title} <span className="count">{list.length}</span></h2>
              {list.length === 0 && <div className="empty small">Nothing here</div>}
              {list.map((o) => {
                const late = (Date.now() - new Date(o.acceptedAt || o.createdAt)) / 60000 > 20 && status !== "ready";
                return (
                  <div key={o.clientId} className={"kot-card" + (late ? " late" : "")}>
                    <div className="kot-top">
                      <b className="kot-no">#{o.orderNo}</b>
                      <b className="kot-table">{o.pay?.state === "paid" && <span className="tag good kot-paid">PAID</span>} {o.tableName || o.table}</b>
                    </div>
                    <div className="small muted">{ago(o.acceptedAt || o.createdAt)}{o.source === "qr" ? " · QR" : ""}</div>
                    <ul className="kot-items">
                      {o.items.map((i, k) => (
                        <li key={k}>
                          <b>{i.qty}×</b> {i.name}{i.variant ? ` (${i.variant})` : ""}
                          {i.itemId && <button className="link-btn kot-recipe" onClick={() => setRecipe(i)} aria-label={`Recipe for ${i.name}`}>📖</button>}
                          {i.note && <div className="kot-note">↳ {i.note}</div>}
                        </li>
                      ))}
                    </ul>
                    {o.note && <div className="kot-note">📝 {o.note}</div>}
                    <div className="btn-row">
                      <button className="btn btn-primary" onClick={() => move(o, next)}>{action}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => kot(o, { force: true, reprint: true })} aria-label="Print KOT">🖨️</button>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      {recipe && <RecipeView itemId={recipe.itemId} variant={recipe.variant} qty={recipe.qty} onClose={() => setRecipe(null)} />}
    </div>
  );
}
