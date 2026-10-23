import { useEffect, useMemo, useState } from "react";
import { post, put, api } from "../../lib/api.js";
import { Field, Modal, Seg, useToast } from "../../components/ui.jsx";
import { loadIngredients, addMove, pendingMoves, flushMoves } from "../../lib/kitchen.js";
import { screenshotPhoto } from "../../lib/image.js";
import { useApp } from "../../lib/store.jsx";
import { fmtQty, unitChoices, useStaffCheck, DaysLeft } from "./common.jsx";
import { UNIT_NAMES } from "../../../shared/kitchenUnits.js";
import { fmtDate } from "../../lib/format.js";

const REASONS = [["spilled", "Spilled"], ["burnt", "Burnt"], ["spoiled", "Spoiled"], ["dropped", "Dropped"], ["other", "Other"]];

export default function Stock() {
  const toast = useToast();
  const { user } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [entry, setEntry] = useState(null); // { ing, type }
  const [editing, setEditing] = useState(null);
  const [starter, setStarter] = useState(false);
  const [pending, setPending] = useState(0);

  const load = async () => {
    try {
      setData(await loadIngredients());
      setPending((await pendingMoves()).length);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => {
    load();
    flushMoves().then(() => load()).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = data?.ingredients || [];
  const cats = useMemo(() => ["All", ...new Set(list.map((i) => i.category || "Other"))], [list]);
  const shown = list.filter((i) => (cat === "All" || i.category === cat) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  const groups = shown.reduce((m, i) => (m[i.category] = [...(m[i.category] || []), i], m), {});

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="stack">
      {data.offline && <div className="banner warn" style={{ borderRadius: 8 }}>Offline · showing saved stock. Entries are kept on this phone and sent when back online.</div>}
      {pending > 0 && (
        <div className="banner warn" style={{ borderRadius: 8 }}>
          {pending} entr{pending === 1 ? "y" : "ies"} waiting to upload ·{" "}
          <button className="link-btn" onClick={() => flushMoves().then(load)}>Send now</button>
        </div>
      )}
      <div className="admin-filters" style={{ marginBottom: 0 }}>
        <input className="input" type="search" placeholder="Search item…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setEditing({})}>+ Item</button>
        <button className="btn" onClick={() => setStarter(true)}>📋 Starter list</button>
      </div>
      <div className="chips">{cats.map((c) => <button key={c} className={"chip" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>{c}</button>)}</div>

      {list.length === 0 && (
        <div className="card stack">
          <b>Add your kitchen items</b>
          <p className="small muted" style={{ margin: 0 }}>Start with the ready list of common dhaba items (oil, onion, paneer, dal, masalas…), then enter what you have now with “Count”.</p>
          <button className="btn btn-primary" onClick={() => setStarter(true)}>📋 Choose from starter list</button>
        </div>
      )}

      {Object.entries(groups).map(([c, items]) => (
        <section key={c} className="card" style={{ padding: 0 }}>
          <h2 style={{ padding: "12px 14px 4px", fontSize: 16 }}>{c}</h2>
          {items.map((i) => (
            <div key={i.id} className="ing-row">
              <button className="ing-main" onClick={() => setEditing(i)}>
                <b>{i.name}</b>
                <span className="small">
                  {i.tracked ? fmtQty(i.stock, i.unit) : "—"} <DaysLeft ing={i} />
                  {i.expiringQty > 0 && <span className="tag bad" style={{ marginLeft: 4 }}>{fmtQty(i.expiringQty, i.unit)} expiring</span>}
                </span>
                {i.nextExpiry && <span className="small muted">Next expiry {fmtDate(i.nextExpiry)}</span>}
              </button>
              <div className="ing-actions">
                <button className="btn btn-sm" onClick={() => setEntry({ ing: i, type: "purchase" })} title="Received">+ In</button>
                <button className="btn btn-sm" onClick={() => setEntry({ ing: i, type: "waste" })} title="Spilled / wasted">− Waste</button>
                <button className="btn btn-sm" onClick={() => setEntry({ ing: i, type: "count" })} title="Count what is there">Count</button>
              </div>
            </div>
          ))}
        </section>
      ))}

      {entry && (
        <EntryModal
          {...entry}
          onClose={() => setEntry(null)}
          onSaved={(r) => {
            setEntry(null);
            toast(r?.offline ? "Saved on this phone. Will upload when online." : "Saved");
            load();
          }}
        />
      )}
      {editing && <ItemModal ing={editing} categories={data.categories} isOwner={user.role !== "kitchen"} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
      {starter && <StarterModal starter={data.starter} have={new Set(list.map((i) => i.name.toLowerCase()))} onClose={() => setStarter(false)} onSaved={(n) => (setStarter(false), toast(`Added ${n} items`), load())} />}
    </div>
  );
}

export function EntryModal({ ing, type, batchId, onClose, onSaved }) {
  const check = useStaffCheck();
  const [qty, setQty] = useState(type === "count" ? String(ing.tracked ? Math.round(ing.stock * 1000) / 1000 : "") : "");
  const [unit, setUnit] = useState(ing.unit);
  const [cost, setCost] = useState("");
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("spilled");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = { purchase: `Received ${ing.name}`, waste: `Spilled / wasted ${ing.name}`, count: `Count ${ing.name}`, expired: `Expired ${ing.name}` }[type];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await check();
      const r = await addMove({
        ingredientId: ing.id,
        type,
        qty: Number(qty) || 0,
        unit,
        ...(type === "purchase" && cost && { cost: Number(cost) }),
        ...(type === "purchase" && expiry && { expiry: new Date(expiry + "T23:59:00").toISOString() }),
        ...(type === "waste" && { reason }),
        ...(batchId && { batchId }),
        ...(note && { note }),
        ...(photo && { photo }),
      });
      if (r.errors?.length) throw new Error(r.errors[0]);
      onSaved(r);
    } catch (err) {
      if (!err.cancelled) setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {type !== "expired" && (
          <Field label={type === "count" ? "How much is there now?" : "Quantity"} hint={type === "count" ? `The app thinks there is ${fmtQty(ing.stock, ing.unit)}.` : undefined}>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" type="number" step="any" min="0" inputMode="decimal" required autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
              {unitChoices(ing.unit).length > 1 && <Seg value={unit} onChange={setUnit} options={unitChoices(ing.unit).map((u) => [u, u])} />}
              {unitChoices(ing.unit).length === 1 && <span className="muted" style={{ alignSelf: "center" }}>{ing.unit}</span>}
            </div>
          </Field>
        )}
        {type === "purchase" && (
          <div className="grid2">
            <Field label="Total price (₹)" hint="Optional; keeps food cost right">
              <input type="number" min="0" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            </Field>
            <Field label="Expiry date" hint={ing.shelfLifeDays ? `Empty = ${ing.shelfLifeDays} days from today` : "Optional"}>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
          </div>
        )}
        {type === "waste" && (
          <>
            <div className="chips">{REASONS.map(([k, l]) => <button type="button" key={k} className={"chip" + (reason === k ? " on" : "")} onClick={() => setReason(k)}>{l}</button>)}</div>
            <div className="btn-row">
              <label className="btn btn-sm">
                📷 {photo ? "Change photo" : "Add photo"}
                <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) setPhoto(await screenshotPhoto(f).catch(() => "")); }} />
              </label>
              {photo && <img src={photo} alt="" className="help-thumb" />}
            </div>
          </>
        )}
        <Field label="Note (optional)"><input maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({ ing, categories, isOwner, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !ing.id;
  const [f, setF] = useState({
    name: ing.name || "",
    category: ing.category || "Vegetables",
    unit: ing.unit || "kg",
    minStock: ing.minStock ?? "",
    costPerUnit: ing.costPerUnit ?? "",
    shelfLifeDays: ing.shelfLifeDays ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { name: f.name, category: f.category, unit: f.unit, minStock: num(f.minStock), costPerUnit: num(f.costPerUnit), shelfLifeDays: num(f.shelfLifeDays) };
      if (isNew) await post("/kitchen/ingredients", body);
      else await put(`/kitchen/ingredients/${ing.id}`, body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${ing.name} from kitchen stock?`)) return;
    try {
      await api(`/kitchen/ingredients/${ing.id}`, { method: "DELETE" });
      toast(`${ing.name} removed`);
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title={isNew ? "New kitchen item" : ing.name} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name"><input required maxLength={50} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Kaju" /></Field>
        <div className="grid2">
          <Field label="Category">
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{categories.map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <Field label="Kept in">
            <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNIT_NAMES.map((u) => <option key={u}>{u}</option>)}</select>
          </Field>
        </div>
        <div className="grid3 price-inputs">
          <Field label={`Alert below (${f.unit})`}><input type="number" step="any" min="0" value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} /></Field>
          <Field label={`₹ per ${f.unit}`}><input type="number" step="any" min="0" value={f.costPerUnit} onChange={(e) => setF({ ...f, costPerUnit: e.target.value })} /></Field>
          <Field label="Lasts (days)"><input type="number" min="1" value={f.shelfLifeDays} onChange={(e) => setF({ ...f, shelfLifeDays: e.target.value })} /></Field>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          {!isNew && isOwner && <button type="button" className="btn btn-danger" onClick={remove}>Remove</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function StarterModal({ starter, have, onClose, onSaved }) {
  const avail = starter.filter((s) => !have.has(s.name.toLowerCase()));
  const [picked, setPicked] = useState(() => new Set(avail.map((s) => s.name)));
  const [busy, setBusy] = useState(false);
  const groups = avail.reduce((m, s) => (m[s.category] = [...(m[s.category] || []), s], m), {});
  const toggle = (n) => setPicked((p) => (p.has(n) ? (p.delete(n), new Set(p)) : new Set(p.add(n))));
  return (
    <Modal title="Starter list" onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Common dhaba items with usual prices and shelf life. Untick what you don't use; you can change anything later.</p>
        {avail.length === 0 && <div className="empty">You already have every starter item.</div>}
        <div className="starter-list">
          {Object.entries(groups).map(([c, items]) => (
            <div key={c}>
              <b className="small">{c}</b>
              {items.map((s) => (
                <label key={s.name} className="check small">
                  <input type="checkbox" checked={picked.has(s.name)} onChange={() => toggle(s.name)} /> {s.name} <span className="muted">({s.unit})</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !picked.size}
            onClick={async () => {
              setBusy(true);
              const r = await post("/kitchen/ingredients/starter", { names: [...picked] });
              onSaved(r.added);
            }}
          >
            Add {picked.size} items
          </button>
        </div>
      </div>
    </Modal>
  );
}
