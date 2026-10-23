import { useEffect, useMemo, useState } from "react";
import { get, post, put, api } from "../../lib/api.js";
import { Modal, useToast } from "../../components/ui.jsx";
import { money } from "../../lib/format.js";
import { useApp } from "../../lib/store.jsx";
import { unitChoices, fmtQty } from "./common.jsx";
import { convert } from "../../../shared/kitchenUnits.js";

export default function Recipes() {
  const toast = useToast();
  const { shop, user } = useApp();
  const cur = shop.currency || "₹";
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => get("/kitchen/recipes").then(setData, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const items = useMemo(
    () =>
      (data?.items || []).filter(
        (i) => (!q || i.name.toLowerCase().includes(q.toLowerCase())) && (filter === "all" || (filter === "missing" ? !i.hasRecipe : i.hasRecipe))
      ),
    [data, q, filter]
  );
  const missingWithStd = (data?.items || []).filter((i) => !i.hasRecipe && i.standard);

  const useStandardAll = async () => {
    if (!confirm(`Add standard recipes for ${missingWithStd.length} dishes? Missing kitchen items are added too. You can edit every recipe.`)) return;
    setBusy(true);
    try {
      const r = await post("/kitchen/recipes/standard", { itemIds: missingWithStd.map((i) => i.itemId) });
      toast(`Added ${r.created} recipes${r.ingredientsAdded ? ` and ${r.ingredientsAdded} kitchen items` : ""}`);
      load();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const withRecipe = data.items.filter((i) => i.hasRecipe).length;

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 6 }}>
        <div className="small">
          <b>{withRecipe}</b> of {data.items.length} dishes have a recipe. Recipes use up kitchen stock as dishes are ordered and show cooks the exact steps.
        </div>
        {missingWithStd.length > 0 && (
          <button className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} disabled={busy} onClick={useStandardAll}>
            ✨ Use standard recipes for {missingWithStd.length} dishes
          </button>
        )}
      </div>
      <div className="admin-filters" style={{ marginBottom: 0 }}>
        <input className="input" type="search" placeholder="Search dish…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips">
        {[["all", "All"], ["missing", "No recipe"], ["done", "Has recipe"]].map(([k, l]) => (
          <button key={k} className={"chip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="recipe-list">
        {items.map((i) => (
          <button key={i.itemId} className="recipe-row" onClick={() => setOpen(i.itemId)}>
            <span className="recipe-name">
              <b>{i.name}</b>
              <span className="small muted">{i.category}</span>
            </span>
            {i.hasRecipe ? (
              <span className="small">
                {user.role !== "kitchen" && Object.entries(i.cost || {}).map(([v, c]) => (c > 0 ? `${v || "Plate"} ${money(c, cur)}` : null)).filter(Boolean).join(" · ")}
                <span className="tag good" style={{ marginLeft: 6 }}>✓ {i.steps} steps</span>
              </span>
            ) : (
              <span className={"tag " + (i.standard ? "accent" : "")}>{i.standard ? "standard ready" : "no recipe"}</span>
            )}
          </button>
        ))}
      </div>
      {open && <RecipeEditor itemId={open} onClose={() => setOpen(null)} onSaved={() => (setOpen(null), load())} />}
    </div>
  );
}

export function RecipeEditor({ itemId, onClose, onSaved }) {
  const toast = useToast();
  const { shop, user } = useApp();
  const cur = shop.currency || "₹";
  const [data, setData] = useState(null);
  const [ings, setIngs] = useState([]);
  const [variants, setVariants] = useState({});
  const [steps, setSteps] = useState([]);
  const [notes, setNotes] = useState("");
  const [tab, setTab] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([get(`/kitchen/recipes/${itemId}`), get("/kitchen/ingredients")]).then(([r, i]) => {
      setData(r);
      setIngs(i.ingredients);
      const labels = r.item.variants.map((v) => v.label || "");
      const base = r.recipe?.variants || {};
      setVariants(Object.fromEntries(labels.map((l) => [l, (base[l] || []).map((p) => ({ ...p }))])));
      setSteps((r.recipe?.steps || []).map((s) => ({ ...s })));
      setNotes(r.recipe?.notes || "");
      setTab(labels[labels.length - 1]);
    }, (e) => setError(e.message));
  }, [itemId]);

  const ingById = useMemo(() => new Map(ings.map((i) => [i.id, i])), [ings]);
  const cost = (parts) =>
    parts.reduce((s, p) => {
      const ing = ingById.get(p.ingredientId);
      if (!ing?.costPerUnit) return s;
      return s + (convert(Number(p.qty) || 0, p.unit, ing.unit) ?? 0) * ing.costPerUnit;
    }, 0);

  const useStandard = () => {
    const std = data.standard;
    if (!std) return;
    if (std.missing.length) toast(`Add these kitchen items first (Stock › Starter list): ${std.missing.join(", ")}. The rest is filled in.`);
    setVariants((v) => Object.fromEntries(Object.keys(v).map((l) => [l, (std.variants[l] || std.variants[""] || []).filter((p) => p.ingredientId).map(({ ingredientId, qty, unit }) => ({ ingredientId, qty, unit }))])));
    setSteps(std.steps.map((s) => ({ ...s })));
  };
  const setPart = (i, patch) => setVariants((v) => ({ ...v, [tab]: v[tab].map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const clean = Object.fromEntries(Object.entries(variants).map(([l, parts]) => [l, parts.filter((p) => p.ingredientId && Number(p.qty) > 0).map((p) => ({ ...p, qty: Number(p.qty) }))]));
      await put(`/kitchen/recipes/${itemId}`, { variants: clean, steps: steps.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), minutes: s.minutes ? Number(s.minutes) : null })), notes });
      toast("Recipe saved");
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Delete this recipe?")) return;
    await api(`/kitchen/recipes/${itemId}`, { method: "DELETE" });
    onSaved();
  };

  if (!data) return <Modal title="Recipe" onClose={onClose}>{error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>}</Modal>;
  const parts = variants[tab] || [];
  const plateCost = cost(parts);
  const price = data.item.price[tab] ?? Object.values(data.item.price)[0];

  return (
    <Modal title={`Recipe · ${data.item.name}`} onClose={onClose} wide>
      <div className="stack">
        {data.standard && (
          <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={useStandard}>✨ Fill with standard recipe</button>
        )}
        {Object.keys(variants).length > 1 && (
          <div className="chips">{Object.keys(variants).map((l) => <button key={l} className={"chip" + (tab === l ? " on" : "")} onClick={() => setTab(l)}>{l}</button>)}</div>
        )}
        <div className="small"><b>Ingredients for one {tab ? `${tab.toLowerCase()} ` : ""}plate</b></div>
        {parts.map((p, i) => {
          const ing = ingById.get(p.ingredientId);
          return (
            <div key={i} className="recipe-part">
              <select className="input" value={p.ingredientId || ""} onChange={(e) => { const n = ingById.get(e.target.value); setPart(i, { ingredientId: e.target.value, unit: n ? ({ kg: "g", L: "ml" }[n.unit] || n.unit) : p.unit }); }}>
                <option value="">Choose item…</option>
                {ings.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <input className="input" type="number" step="any" min="0" inputMode="decimal" value={p.qty} onChange={(e) => setPart(i, { qty: e.target.value })} aria-label="Quantity" />
              <select className="input" value={p.unit} onChange={(e) => setPart(i, { unit: e.target.value })} aria-label="Unit">
                {(ing ? unitChoices(ing.unit) : [p.unit]).map((u) => <option key={u}>{u}</option>)}
              </select>
              <button className="btn btn-sm btn-ghost" onClick={() => setVariants((v) => ({ ...v, [tab]: v[tab].filter((_, j) => j !== i) }))} aria-label="Remove">✕</button>
            </div>
          );
        })}
        <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setVariants((v) => ({ ...v, [tab]: [...(v[tab] || []), { ingredientId: "", qty: "", unit: "g" }] }))}>+ Ingredient</button>
        {user.role !== "kitchen" && plateCost > 0 && (
          <div className="pricing-preview small">
            Cost to make: <b>{money(plateCost, cur)}</b> · Sells for {money(price, cur)} · Margin <b>{Math.round((1 - plateCost / price) * 100)}%</b>
          </div>
        )}

        <div className="small" style={{ marginTop: 6 }}><b>Cooking steps</b> (same for every size)</div>
        {steps.map((s, i) => (
          <div key={i} className="recipe-step">
            <span className="step-no">{i + 1}</span>
            <textarea className="input" rows={2} maxLength={300} value={s.text} onChange={(e) => setSteps((st) => st.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            <input className="input step-min" type="number" min="0" placeholder="min" value={s.minutes ?? ""} onChange={(e) => setSteps((st) => st.map((x, j) => (j === i ? { ...x, minutes: e.target.value } : x)))} aria-label="Minutes" />
            <button className="btn btn-sm btn-ghost" onClick={() => setSteps((st) => st.filter((_, j) => j !== i))} aria-label="Remove step">✕</button>
          </div>
        ))}
        <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setSteps((st) => [...st, { text: "", minutes: null }])}>+ Step</button>
        <textarea className="input" rows={2} maxLength={500} placeholder="Notes (e.g. serve with onion and lemon)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {data.recipe?.updatedBy && <div className="hint">Last changed by {data.recipe.updatedBy}</div>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {data.recipe && <button className="btn btn-danger" onClick={remove}>Delete</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save recipe"}</button>
        </div>
      </div>
    </Modal>
  );
}

// Read-only recipe for the cook: quantities for this order, and the steps.
export function RecipeView({ itemId, variant, qty = 1, onClose }) {
  const [data, setData] = useState(null);
  const [ings, setIngs] = useState(new Map());
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([get(`/kitchen/recipes/${itemId}`), get("/kitchen/ingredients")]).then(
      ([r, i]) => (setData(r), setIngs(new Map(i.ingredients.map((x) => [x.id, x])))),
      (e) => setError(e.message)
    );
  }, [itemId]);
  const parts = data?.recipe ? data.recipe.variants[variant || ""] || Object.values(data.recipe.variants)[0] || [] : [];
  return (
    <Modal title={data ? `${data.item.name}${variant ? ` (${variant})` : ""} × ${qty}` : "Recipe"} onClose={onClose} actions={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      {error && <div className="error">{error}</div>}
      {data && !data.recipe && <div className="empty">No recipe yet. Add one in Kitchen › Recipes.</div>}
      {data?.recipe && (
        <div className="stack">
          <ul className="recipe-qty">
            {parts.map((p, i) => (
              <li key={i}><b>{fmtQty(p.qty * qty, p.unit)}</b> {ings.get(p.ingredientId)?.name || "?"}</li>
            ))}
          </ul>
          <ol className="recipe-steps">
            {data.recipe.steps.map((s, i) => <li key={i}>{s.text}{s.minutes ? <span className="muted"> · {s.minutes} min</span> : null}</li>)}
          </ol>
          {data.recipe.notes && <p className="small muted" style={{ margin: 0 }}>{data.recipe.notes}</p>}
        </div>
      )}
    </Modal>
  );
}
