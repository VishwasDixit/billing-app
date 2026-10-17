import { useMemo, useState } from "react";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Field, Modal, useAction, useToast } from "../components/ui.jsx";

const PRESETS = {
  single: [{ label: "", price: 0 }],
  halffull: [{ label: "Half", price: 0 }, { label: "Full", price: 0 }],
  plainbutter: [{ label: "Plain", price: 0 }, { label: "Butter", price: 0 }],
};

export default function Menu() {
  const { menu, shop, resetMenu } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState("");
  const { busy, run } = useAction();

  const groups = useMemo(() => {
    const g = new Map();
    for (const m of menu.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()))) {
      const c = m.category || "Other";
      if (!g.has(c)) g.set(c, []);
      g.get(c).push(m);
    }
    return [...g.entries()];
  }, [menu, q]);
  const categories = [...new Set(menu.map((m) => m.category).filter(Boolean))];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Menu</h1>
        <div className="btn-row">
          <input className="input" style={{ width: 180 }} type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" onClick={() => setEditing({ name: "", category: "", note: "", variants: PRESETS.single, active: true })}>
            + Add item
          </button>
        </div>
      </div>

      <div className="cards">
        {groups.map(([cat, items]) => (
          <div className="card" key={cat} style={{ padding: 0 }}>
            <h2 style={{ padding: "14px 16px 0" }}>{cat} <span className="muted small">({items.length})</span></h2>
            <table className="table">
              <tbody>
                {items.map((m) => (
                  <tr key={m.id} className="click" onClick={() => setEditing(m)}>
                    <td>
                      {m.name} {m.active === false && <span className="tag">hidden</span>}
                      {m.note && <div className="muted small">{m.note}</div>}
                    </td>
                    <td className="num">
                      {m.variants.map((v) => (v.label ? `${v.label} ${money(v.price, cur)}` : money(v.price, cur))).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {groups.length === 0 && <div className="empty">No menu items yet.</div>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Start over</h2>
        <p className="muted small">Replace your whole menu with the default dhaba menu (12 categories). Past bills are not affected.</p>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={() => confirm("Replace your entire menu with the default menu?") && run(async () => (await resetMenu(), toast("Default menu restored")))}
        >
          Reset to default menu
        </button>
      </div>

      {editing && <ItemEditor item={editing} categories={categories} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ItemEditor({ item, categories, onClose }) {
  const { saveMenuItem, deleteMenuItem } = useApp();
  const toast = useToast();
  const [f, setF] = useState({ ...item, variants: item.variants.map((v) => ({ ...v })) });
  const { busy, error, run } = useAction();

  const setVariant = (i, k, v) => setF({ ...f, variants: f.variants.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const variants = f.variants.map((v) => ({ label: f.variants.length > 1 ? v.label.trim() : "", price: Number(v.price) || 0 }));
      if (variants.length > 1 && variants.some((v) => !v.label)) throw new Error("Give each price a name, e.g. Half / Full.");
      await saveMenuItem({ id: f.id, name: f.name, category: f.category, note: f.note || "", variants, active: f.active !== false });
      toast(f.id ? "Item updated" : "Item added");
      onClose();
    });
  };

  return (
    <Modal title={f.id ? "Edit item" : "Add item"} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name">
          <input required maxLength={60} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Category">
          <input list="cat-list" maxLength={30} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="e.g. Snacks" />
          <datalist id="cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <div className="field">
          Prices
          <div className="btn-row" style={{ marginBottom: 4 }}>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, variants: PRESETS.single.map((v, i) => ({ ...v, price: f.variants[i]?.price ?? 0 })) })}>One price</button>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, variants: PRESETS.halffull.map((v, i) => ({ ...v, price: f.variants[i]?.price ?? 0 })) })}>Half / Full</button>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, variants: PRESETS.plainbutter.map((v, i) => ({ ...v, price: f.variants[i]?.price ?? 0 })) })}>Plain / Butter</button>
          </div>
          {f.variants.map((v, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              {f.variants.length > 1 && (
                <input className="input" style={{ flex: 1 }} maxLength={20} placeholder="Name (e.g. Half)" value={v.label} onChange={(e) => setVariant(i, "label", e.target.value)} />
              )}
              <input className="input" style={{ flex: 1 }} type="number" min="0" step="0.01" inputMode="decimal" required placeholder="Price" value={v.price} onChange={(e) => setVariant(i, "price", e.target.value)} />
              {f.variants.length > 2 && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ ...f, variants: f.variants.filter((_, j) => j !== i) })} aria-label="Remove price">✕</button>
              )}
            </div>
          ))}
          {f.variants.length > 1 && f.variants.length < 6 && (
            <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setF({ ...f, variants: [...f.variants, { label: "", price: 0 }] })}>
              + Add another price
            </button>
          )}
        </div>
        <Field label="Note (optional)" hint="Shown when picking the item, e.g. what a thali includes.">
          <input maxLength={160} value={f.note || ""} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} />
          Show on billing screen
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {f.id && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => confirm(`Delete “${f.name}”?`) && run(async () => (await deleteMenuItem(f.id), toast("Item deleted"), onClose()))}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
