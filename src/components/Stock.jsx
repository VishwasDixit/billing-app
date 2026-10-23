import { useState } from "react";
import { useApp } from "../lib/store.jsx";
import { Modal, useToast } from "./ui.jsx";
import { ItemPicture } from "./ItemPicture.jsx";

export const isSoldOut = (m) => !!m.soldOut;
export const stockLabel = (m) => (m.soldOut ? "Sold out" : typeof m.stock === "number" ? `${m.stock} left` : "Available");

// One-tap Available / Sold out switch, with the quantity left when it's counted.
export function StockPill({ item, size = "sm" }) {
  const { setItemStock } = useApp();
  const toast = useToast();
  const toggle = (e) => {
    e.stopPropagation();
    setItemStock(item.id, { soldOut: !item.soldOut })
      .then(() => toast(item.soldOut ? `${item.name} is available again` : `${item.name} marked sold out. Customers won't see it.`))
      .catch((err) => toast(err.message));
  };
  return (
    <button
      type="button"
      className={`stock-pill ${size} ${item.soldOut ? "out" : typeof item.stock === "number" && item.stock <= 5 ? "low" : "ok"}`}
      onClick={toggle}
      title={item.soldOut ? "Tap to make available" : "Tap to mark sold out"}
    >
      {item.soldOut ? "Sold out" : typeof item.stock === "number" ? `${item.stock} left` : "Available"}
    </button>
  );
}

// Quick stock list for busy service: switch dishes on/off and set how many are left.
export function StockPanel({ onClose }) {
  const { menu, setItemStock } = useApp();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [onlyOut, setOnlyOut] = useState(false);
  const items = menu
    .filter((m) => m.active !== false)
    .filter((m) => (!q || m.name.toLowerCase().includes(q.toLowerCase())) && (!onlyOut || m.soldOut || typeof m.stock === "number"));
  const save = (m, patch) => setItemStock(m.id, patch).catch((err) => toast(err.message));
  const num = (v) => (v === "" ? null : Math.max(0, Math.floor(Number(v) || 0)));
  const outCount = menu.filter((m) => m.active !== false && m.soldOut).length;

  return (
    <Modal title={`Stock${outCount ? ` · ${outCount} sold out` : ""}`} onClose={onClose} wide>
      <div className="stack">
        <div className="admin-filters" style={{ marginBottom: 0 }}>
          <input className="input" type="search" placeholder="Search dish…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check small">
          <input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} /> Show only sold out / counted dishes
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Sold-out dishes disappear from the customer QR menu. “Left” counts down with each order and turns Sold out at 0; “Daily” refills it every morning.
        </p>
        <div className="stock-list">
          {items.map((m) => (
            <div key={m.id} className={"stock-row" + (m.soldOut ? " out" : "")}>
              <ItemPicture item={m} size={34} />
              <span className="stock-name">{m.name}</span>
              <input
                className="input stock-num"
                type="number"
                min="0"
                inputMode="numeric"
                placeholder="Left"
                aria-label={`${m.name} left`}
                defaultValue={m.stock ?? ""}
                key={`s${m.id}${m.stock}`}
                onBlur={(e) => num(e.target.value) !== (m.stock ?? null) && save(m, { stock: num(e.target.value) })}
              />
              <input
                className="input stock-num"
                type="number"
                min="1"
                inputMode="numeric"
                placeholder="Daily"
                aria-label={`${m.name} daily amount`}
                defaultValue={m.dailyStock ?? ""}
                key={`d${m.id}${m.dailyStock}`}
                onBlur={(e) => {
                  const v = num(e.target.value);
                  if (v !== (m.dailyStock ?? null)) save(m, { dailyStock: v || null, ...(v && m.stock == null && { stock: v }) });
                }}
              />
              <StockPill item={m} />
            </div>
          ))}
          {items.length === 0 && <div className="empty">No dishes match.</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
