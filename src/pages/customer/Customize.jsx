// The customise sheet (like Swiggy/Zomato): size, then each add-on group, a quantity and
// "Add item · ₹230". Also used to edit a line from the cart, and on the staff take-order screen.
import { useState } from "react";
import { money } from "../../lib/format.js";
import { defaultImageFor } from "../../../shared/menuImages.js";
import { addonRule, checkAddons, addonsTotal } from "../../../shared/addons.js";

// initial: { variant, addonIds, qty } when editing a cart line.
export function Customize({ m, cur, initial, onAdd, onClose, editing = false }) {
  const groups = m.addons || [];
  const [variant, setVariant] = useState(() => initial?.variant ?? m.variants[0].label ?? "");
  const [picked, setPicked] = useState(() => new Set(initial?.addonIds || []));
  const [qty, setQty] = useState(initial?.qty || 1);
  const [tried, setTried] = useState(false);
  const v = m.variants.find((x) => (x.label || "") === variant) || m.variants[0];
  const ids = groups.flatMap((g) => g.options.filter((o) => picked.has(o.id)).map((o) => o.id));
  const { error } = checkAddons(groups, ids);
  // The price follows every tick, even before a required group is picked.
  const each = v.price + addonsTotal(groups.flatMap((g) => g.options.filter((o) => picked.has(o.id))));

  const toggle = (g, o) => {
    if (o.off) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(o.id)) next.delete(o.id);
      else {
        // Pick-one groups swap; others stop at their most.
        const max = Math.min(g.max || 1, g.options.length);
        const inGroup = g.options.filter((x) => next.has(x.id));
        if (max === 1) inGroup.forEach((x) => next.delete(x.id));
        else if (inGroup.length >= max) return prev;
        next.add(o.id);
      }
      return next;
    });
  };
  const add = () => {
    setTried(true);
    if (!error) onAdd({ v, addonIds: ids, qty });
  };

  return (
    <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="co-sheet co-custom" role="dialog" aria-label={`Customise ${m.name}`}>
        <div className="co-custom-head">
          <img src={m.image || defaultImageFor(m.name, m.category)} alt="" onError={(e) => (e.currentTarget.src = defaultImageFor(m.name, m.category))} />
          <div>
            <b>{m.name}</b>
            {m.note && <span className="small muted">{m.note}</span>}
          </div>
          <button className="co-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="co-custom-body">
          {m.variants.length > 1 && (
            <fieldset className="co-group">
              <legend><b>Size</b><span className="co-req">Required</span></legend>
              {m.variants.map((x) => (
                <label key={x.label} className="co-opt">
                  <input type="radio" name="size" checked={(x.label || "") === (v.label || "")} onChange={() => setVariant(x.label || "")} />
                  <span>{x.label}</span>
                  <span>{money(x.price, cur)}</span>
                </label>
              ))}
            </fieldset>
          )}
          {groups.map((g) => {
            const one = Math.min(g.max || 1, g.options.length) === 1;
            const short = tried && error && g.min > g.options.filter((o) => picked.has(o.id)).length;
            return (
              <fieldset key={g.id} className={"co-group" + (short ? " short" : "")}>
                <legend>
                  <b>{g.name}</b>
                  <span className={g.min ? "co-req" : "co-opt-tag"}>{g.min ? "Required" : "Optional"}</span>
                  <span className="small muted">{addonRule(g)}</span>
                </legend>
                {g.options.map((o) => (
                  <label key={o.id} className={"co-opt" + (o.off ? " off" : "")}>
                    <input type={one ? "radio" : "checkbox"} name={g.id} checked={picked.has(o.id)} disabled={o.off} onChange={() => toggle(g, o)} onClick={() => one && picked.has(o.id) && !g.min && toggle(g, o)} />
                    <span>{o.name}{o.off && <small> · not available today</small>}</span>
                    <span>{o.price ? `+ ${money(o.price, cur)}` : "Free"}</span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
        {tried && error && <div className="error small">{error}</div>}
        <div className="co-custom-bar">
          <div className="co-stepper">
            <button onClick={() => setQty((n) => Math.max(1, n - 1))} aria-label="One less">−</button>
            <span>{qty}</span>
            <button onClick={() => setQty((n) => Math.min(99, n + 1))} aria-label="One more">+</button>
          </div>
          <button className="btn btn-primary co-custom-add" onClick={add}>
            {editing ? "Update item" : "Add item"} · {money(each * qty, cur)}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tapping + on a dish already customised: repeat the last one, or choose again.
export function RepeatSheet({ line, cur, onRepeat, onChoose, onClose }) {
  return (
    <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="co-sheet">
        <b>Repeat last used customisation?</b>
        <div className="co-repeat">
          <span>{line.name}</span>
          <span className="small muted">{[line.variant, ...(line.addons || []).map((a) => a.name)].filter(Boolean).join(", ") || "No extras"} · {money(line.rate, cur)}</span>
        </div>
        <div className="co-repeat-btns">
          <button className="btn" onClick={onChoose}>I'll choose</button>
          <button className="btn btn-primary" onClick={onRepeat}>Repeat</button>
        </div>
      </div>
    </div>
  );
}
