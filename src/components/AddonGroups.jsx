// Menu › Add-ons: shared groups like "Sauces" or "Extra cheese", each used on some dishes or whole
// categories. Customers pick them in the dish's customise sheet; staff do the same when taking orders.
import { useState } from "react";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Field, Modal, useAction, useToast } from "./ui.jsx";
import { addonRule, MAX_ADDON_GROUPS, MAX_ADDON_OPTIONS } from "../../shared/addons.js";

const newId = () => Math.random().toString(36).slice(2, 10);

// Who uses a group, in words: "Burgers, Sandwich · Garlic Bread".
export function usedOnText(g, menu) {
  const dishes = (g.items || []).map((id) => menu.find((m) => m.id === id)?.name).filter(Boolean);
  const parts = [(g.categories || []).join(", "), dishes.join(", ")].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Not on any dish yet";
}

export function AddonGroupsPanel({ onClose }) {
  const { shop, menu, saveShop } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const groups = shop.addonGroups || [];
  const [edit, setEdit] = useState(null);
  const { busy, error, run } = useAction();
  const save = (next, msg) =>
    run(async () => {
      await saveShop({ addonGroups: next });
      toast(msg);
    });

  return (
    <Modal title="Add-ons" onClose={onClose} wide actions={<button className="btn" onClick={onClose}>Done</button>}>
      <p className="small muted" style={{ margin: 0 }}>
        Extras customers can pick on a dish, like <b>Extra cheese</b> or <b>Sauces</b>. Make a group once and use it on many dishes or a whole category.
      </p>
      {error && <div className="error">{error}</div>}
      {groups.length === 0 ? (
        <p className="muted small">No add-ons yet. Example: <b>Sauces</b> (pick up to 2): Mayo {cur}10, Peri peri {cur}15, on Burgers and Sandwiches.</p>
      ) : (
        <div className="promo-list">
          {groups.map((g) => (
            <div key={g.id} className="promo-row">
              <div className="promo-main">
                <b>{g.name} <span className="small muted">· {addonRule(g)}</span></b>
                <span className="small">{g.options.map((o) => `${o.name}${o.price ? ` ${money(o.price, cur)}` : ""}${o.off ? " (out today)" : ""}`).join(" · ")}</span>
                <span className="small muted">On: {usedOnText(g, menu)}</span>
              </div>
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => setEdit(g)}>Edit</button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => confirm(`Delete “${g.name}”? Dishes stop offering it.`) && save(groups.filter((x) => x.id !== g.id), `${g.name} deleted`)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {groups.length < MAX_ADDON_GROUPS && (
        <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={() => setEdit({ id: newId(), name: "", min: 0, max: 1, options: [{ id: newId(), name: "", price: "" }], items: [], categories: [] })}>
          + New add-on group
        </button>
      )}
      {edit && (
        <AddonGroupModal
          group={edit}
          onClose={() => setEdit(null)}
          onSave={async (g) => {
            const exists = groups.some((x) => x.id === g.id);
            await saveShop({ addonGroups: exists ? groups.map((x) => (x.id === g.id ? g : x)) : [...groups, g] });
            toast(`${g.name} saved`);
            setEdit(null);
          }}
        />
      )}
    </Modal>
  );
}

function AddonGroupModal({ group, onClose, onSave }) {
  const { shop, menu } = useApp();
  const cur = shop.currency || "₹";
  const [f, setF] = useState(() => ({ ...group, options: group.options.map((o) => ({ ...o })) }));
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const categories = [...new Set(menu.map((m) => m.category).filter(Boolean))];
  const setOpt = (i, k, v) => setF({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, [k]: v } : o)) });
  const toggle = (key, v) => setF({ ...f, [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] });
  // How many the customer picks: optional one, optional up to N, exactly one (required).
  const mode = f.min >= 1 && f.max === 1 ? "one" : f.max === 1 ? "optional" : "many";
  const setMode = (m) => setF({ ...f, min: m === "one" ? 1 : 0, max: m === "many" ? Math.max(2, f.max) : 1 });
  const found = q.trim() ? menu.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const options = f.options.filter((o) => o.name.trim()).map((o) => ({ id: o.id, name: o.name.trim(), price: Number(o.price) || 0, off: !!o.off }));
      if (!f.name.trim()) throw new Error("Give the group a name, e.g. Sauces.");
      if (!options.length) throw new Error("Add at least one choice, e.g. Mayo.");
      const ids = new Set(menu.map((m) => m.id));
      await onSave({ ...f, name: f.name.trim(), options, max: Math.min(f.max, options.length), items: f.items.filter((id) => ids.has(id)) });
    });
  };

  return (
    <Modal title={group.name ? `Edit ${group.name}` : "New add-on group"} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Group name">
          <input className="input" maxLength={40} placeholder="e.g. Sauces, Extra cheese, Choose bread" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Customer picks">
          <div className="chips">
            <button type="button" className={"chip" + (mode === "optional" ? " on" : "")} onClick={() => setMode("optional")}>One, if they want</button>
            <button type="button" className={"chip" + (mode === "many" ? " on" : "")} onClick={() => setMode("many")}>Several, if they want</button>
            <button type="button" className={"chip" + (mode === "one" ? " on" : "")} onClick={() => setMode("one")}>Exactly one (must pick)</button>
          </div>
        </Field>
        {mode === "many" && (
          <Field label="Most they can pick">
            <input className="input" type="number" min="2" max={MAX_ADDON_OPTIONS} value={f.max} onChange={(e) => setF({ ...f, max: Math.max(2, Math.min(MAX_ADDON_OPTIONS, Number(e.target.value) || 2)) })} style={{ width: 90 }} />
          </Field>
        )}
        <div className="field">
          Choices
          {f.options.map((o, i) => (
            <div key={o.id} className="addon-opt">
              <input className="input" maxLength={30} placeholder="Name (e.g. Mayo)" value={o.name} onChange={(e) => setOpt(i, "name", e.target.value)} />
              <input className="input" type="number" min="0" step="1" inputMode="decimal" placeholder={`${cur} 0`} value={o.price} onChange={(e) => setOpt(i, "price", e.target.value)} aria-label="Price" />
              <label className="small addon-off" title="Out of stock today">
                <input type="checkbox" checked={!!o.off} onChange={(e) => setOpt(i, "off", e.target.checked)} /> Out
              </label>
              {f.options.length > 1 && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ ...f, options: f.options.filter((_, j) => j !== i) })} aria-label="Remove choice">✕</button>
              )}
            </div>
          ))}
          {f.options.length < MAX_ADDON_OPTIONS && (
            <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setF({ ...f, options: [...f.options, { id: newId(), name: "", price: "" }] })}>+ Add a choice</button>
          )}
          <span className="hint">Price 0 = free (e.g. a choice of bread). “Out” hides nothing but stops customers picking it today.</span>
        </div>
        <div className="field">
          Use on whole categories
          <div className="chips">
            {categories.map((c) => (
              <button type="button" key={c} className={"chip" + (f.categories.includes(c) ? " on" : "")} onClick={() => toggle("categories", c)}>{c}</button>
            ))}
          </div>
        </div>
        <div className="field">
          And on these dishes
          <input className="input" type="search" placeholder="Search a dish to add…" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.length > 0 && (
            <div className="chips">
              {found.map((m) => (
                <button type="button" key={m.id} className={"chip" + (f.items.includes(m.id) ? " on" : "")} onClick={() => toggle("items", m.id)}>
                  {f.items.includes(m.id) ? "✓ " : "+ "}{m.name}
                </button>
              ))}
            </div>
          )}
          {f.items.length > 0 && (
            <div className="chips">
              {f.items.map((id) => {
                const m = menu.find((x) => x.id === id);
                return m ? <button type="button" key={id} className="chip on" onClick={() => toggle("items", id)}>{m.name} ✕</button> : null;
              })}
            </div>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}
