import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Field, Modal, useAction, useToast } from "../components/ui.jsx";
import { defaultImageFor, isDefaultImage } from "../../shared/menuImages.js";
import { menuPhoto, sizeOf, fmtBytes } from "../lib/image.js";
import { ItemPicture } from "../components/ItemPicture.jsx";
import { PhotoSearch } from "../components/PhotoSearch.jsx";
import { StockPill, StockPanel } from "../components/Stock.jsx";
import { post, put } from "../lib/api.js";

const PRESETS = {
  single: [{ label: "", price: 0 }],
  halffull: [{ label: "Half", price: 0 }, { label: "Full", price: 0 }],
  plainbutter: [{ label: "Plain", price: 0 }, { label: "Butter", price: 0 }],
};

export default function Menu() {
  const { menu, shop, resetMenu, addDefaultPictures } = useApp();
  const [autoPick, setAutoPick] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);
  const plainItems = menu.filter((m) => !m.image || isDefaultImage(m.image));
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
  const missingPictures = menu.filter((m) => !m.image).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Menu</h1>
        <div className="btn-row">
          <input className="input" style={{ width: 180 }} type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => setStockOpen(true)}>🥟 Stock</button>
          <button className="btn btn-primary" onClick={() => setEditing({ name: "", category: "", note: "", variants: PRESETS.single, active: true })}>
            + Add item
          </button>
        </div>
      </div>

      {plainItems.length > 0 && (
        <div className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>{plainItems.length} item{plainItems.length > 1 ? "s use" : " uses"} a drawn picture. Want real food photos?</span>
          <button className="btn" onClick={() => setAutoPick(true)}>✨ Auto-pick photos</button>
        </div>
      )}
      {autoPick && <AutoPick items={plainItems} onClose={() => setAutoPick(false)} />}
      {stockOpen && <StockPanel onClose={() => setStockOpen(false)} />}

      {missingPictures > 0 && (
        <div className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>{missingPictures} item{missingPictures > 1 ? "s have" : " has"} no picture yet.</span>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => run(async () => toast(`Added pictures to ${await addDefaultPictures()} items`))}
          >
            Add default pictures
          </button>
        </div>
      )}

      <div className="cards">
        {groups.map(([cat, items]) => (
          <div className="card" key={cat} style={{ padding: 0 }}>
            <h2 style={{ padding: "14px 16px 0" }}>{cat} <span className="muted small">({items.length})</span></h2>
            <table className="table">
              <tbody>
                {items.map((m) => (
                  <tr key={m.id} className="click" onClick={() => setEditing(m)}>
                    <td style={{ width: 52 }}>
                      <ItemPicture item={m} size={40} />
                    </td>
                    <td>
                      {m.name} {m.active === false && <span className="tag">hidden</span>}
                      {m.note && <div className="muted small">{m.note}</div>}
                    </td>
                    <td className="num">
                      {m.variants.map((v) => (v.label ? `${v.label} ${money(v.price, cur)}` : money(v.price, cur))).join(" · ")}
                      <div style={{ marginTop: 4 }}>
                        <StockPill item={m} />
                      </div>
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
  const { saveMenuItem, deleteMenuItem, setMenuPhoto, removeMenuPhoto, setItemStock } = useApp();
  const [stock, setStock] = useState({ soldOut: !!item.soldOut, stock: item.stock ?? "", dailyStock: item.dailyStock ?? "" });
  const toast = useToast();
  const [f, setF] = useState({ ...item, variants: item.variants.map((v) => ({ ...v })) });
  // null = keep, data URL = new photo, "default" = back to the drawn picture, { link } = library photo
  const [photo, setPhoto] = useState(null);
  const [searching, setSearching] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const { busy, error, setError, run } = useAction();

  const hasPhoto = !!item.image && !isDefaultImage(item.image);
  // A library photo is { link }. (Not `photo?.link`: an uploaded photo is a data-URL string, and every
  // string has a built-in .link() method, which made uploads look like library photos.)
  const lib = photo && typeof photo === "object" ? photo.link : null;
  const preview = lib
    ? lib.url
    : photo && photo !== "default"
      ? photo
      : photo === "default" || !hasPhoto
        ? defaultImageFor(f.name, f.category)
        : item.image;
  const credit = lib ? { author: lib.author } : !photo && hasPhoto ? item.imageCredit : null;

  const onPhoto = async (file) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const data = await menuPhoto(file);
      setPhoto(data);
      toast(`Photo optimized: ${fmtBytes(file.size)} → ${fmtBytes(sizeOf(data))}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setPhotoBusy(false);
    }
  };

  const setVariant = (i, k, v) => setF({ ...f, variants: f.variants.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const variants = f.variants.map((v) => ({ label: f.variants.length > 1 ? v.label.trim() : "", price: Number(v.price) || 0 }));
      if (variants.length > 1 && variants.some((v) => !v.label)) throw new Error("Give each price a name, e.g. Half / Full.");
      const link = lib ? { image: lib.url, imageCredit: { author: lib.author, url: lib.pexelsUrl } } : {};
      const saved = await saveMenuItem({ id: f.id, name: f.name, category: f.category, note: f.note || "", variants, active: f.active !== false, ...link });
      try {
        if (lib) {
          /* saved with the item */
        } else if (photo === "default" && hasPhoto) await removeMenuPhoto(saved.id);
        else if (photo && photo !== "default") await setMenuPhoto(saved.id, photo);
        // A renamed item without its own photo follows its new name's picture.
        else if (!hasPhoto && saved.image !== defaultImageFor(f.name, f.category)) await removeMenuPhoto(saved.id);
      } catch (err) {
        setF({ ...f, id: saved.id });
        throw new Error(`Item saved, but the photo couldn't be uploaded: ${err.message}`);
      }
      // Stock: only send what changed.
      const n = (v) => (v === "" || v == null ? null : Math.max(0, Math.floor(Number(v))));
      const patch = {};
      if (stock.soldOut !== !!item.soldOut) patch.soldOut = stock.soldOut;
      if (n(stock.stock) !== (item.stock ?? null)) patch.stock = n(stock.stock);
      if (n(stock.dailyStock) !== (item.dailyStock ?? null)) patch.dailyStock = n(stock.dailyStock) || null;
      if (Object.keys(patch).length) await setItemStock(saved.id, patch);
      toast(f.id ? "Item updated" : "Item added");
      onClose();
    });
  };

  return (
    <Modal title={f.id ? "Edit item" : "Add item"} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="photo-pick">
          <img src={preview} alt="" className="photo-preview" />
          <div className="stack" style={{ gap: 6 }}>
            <label className="btn btn-sm">
              📷 Take photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onPhoto(e.target.files[0]), (e.target.value = ""))} />
            </label>
            <label className="btn btn-sm">
              🖼️ Choose photo
              <input type="file" accept="image/*" hidden onChange={(e) => (onPhoto(e.target.files[0]), (e.target.value = ""))} />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setSearching(true)}>
              🔍 Find photo
            </button>
            {(photo ? photo !== "default" : hasPhoto) && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhoto(hasPhoto ? "default" : null)}>
                Use default picture
              </button>
            )}
            {photoBusy && <span className="hint">Preparing photo…</span>}
            {credit?.author && <span className="hint">Photo: {credit.author}</span>}
          </div>
        </div>
        {searching && (
          <PhotoSearch
            name={f.name}
            category={f.category}
            onClose={() => setSearching(false)}
            onPick={(p) => {
              setPhoto({ link: p });
              setSearching(false);
            }}
          />
        )}
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
        <fieldset className="pricing-box">
          <legend>Stock</legend>
          <label className="check">
            <input type="checkbox" checked={stock.soldOut} onChange={(e) => setStock({ ...stock, soldOut: e.target.checked })} />
            Sold out (customers won't see it)
          </label>
          <div className="grid2">
            <Field label="Left now" hint="Empty = don't count">
              <input type="number" min="0" inputMode="numeric" value={stock.stock} onChange={(e) => setStock({ ...stock, stock: e.target.value })} />
            </Field>
            <Field label="Every day start with" hint="Empty = no daily reset">
              <input type="number" min="1" inputMode="numeric" value={stock.dailyStock} onChange={(e) => setStock({ ...stock, dailyStock: e.target.value })} />
            </Field>
          </div>
        </fieldset>
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
          <button className="btn btn-primary" disabled={busy || photoBusy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

// Suggests a real photo for each item that still has a drawn picture; nothing is saved until "Apply".
function AutoPick({ items, onClose }) {
  const { loadMenu } = useApp();
  const toast = useToast();
  const [list, setList] = useState(null); // [{ itemId, name, photo, more, on }]
  const [skipped, setSkipped] = useState(0);
  const [source, setSource] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    run(async () => {
      const r = await post("/images/bulk-suggest", { itemIds: items.slice(0, 100).map((m) => m.id) });
      setList(r.suggestions.map((s) => ({ ...s, on: true })));
      setSkipped(r.skipped + Math.max(0, items.length - 100));
      setSource(r.source);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (list || []).filter((s) => s.on);
  const apply = () =>
    run(async () => {
      for (const s of chosen) await put(`/menu/${s.itemId}`, { image: s.photo.url, imageCredit: { author: s.photo.author, url: s.photo.pexelsUrl } });
      await loadMenu();
      toast(`Added photos to ${chosen.length} item${chosen.length === 1 ? "" : "s"}`);
      onClose();
    });
  const update = (i, patch) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Modal title="Auto-pick photos" onClose={onClose} wide>
      {!list && !error && <div className="empty">Finding photos for {Math.min(items.length, 100)} items…</div>}
      {error && <div className="error">{error}</div>}
      {list && (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>Untick any that don't match, or tap another photo. Only links are saved, so this uses no storage.</p>
          <div className="autopick-list">
            {list.map((s, i) => (
              <div key={s.itemId} className={"autopick-row" + (s.on ? "" : " off")}>
                <label className="check">
                  <input type="checkbox" checked={s.on} onChange={(e) => update(i, { on: e.target.checked })} />
                  <b>{s.name}</b>
                </label>
                <div className="autopick-photos">
                  {[s.photo, ...s.more.filter((m) => m.id !== s.photo.id)].slice(0, 4).map((p) => (
                    <button key={p.id} type="button" className={"photo-cell sm" + (p.id === s.photo.id ? " on" : "")} onClick={() => update(i, { photo: p, on: true })}>
                      <img src={p.thumb} alt={p.alt} loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {list.length === 0 && <div className="empty">No photos found for these items.</div>}
          </div>
          {skipped > 0 && <p className="hint">{skipped} more item{skipped === 1 ? "" : "s"} can be done later (the photo library limits searches per hour).</p>}
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !chosen.length} onClick={apply}>
              {busy ? "Saving…" : `Use ${chosen.length} photo${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
          <p className="hint" style={{ textAlign: "right", margin: "6px 0 0" }}>
            {source === "pexels" ? (
              <a href="https://www.pexels.com" target="_blank" rel="noopener noreferrer">Photos provided by Pexels</a>
            ) : (
              <a href="https://commons.wikimedia.org" target="_blank" rel="noopener noreferrer">Photos from Wikimedia Commons (free licences)</a>
            )}
          </p>
        </>
      )}
    </Modal>
  );
}
