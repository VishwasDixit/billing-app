import { useState } from "react";
import { useApp } from "../lib/store.jsx";
import { money } from "../lib/format.js";
import { Field, Modal, useAction } from "./ui.jsx";
import { LANGUAGE_OPTIONS, languageFor } from "../../shared/messages.js";

// Choose (or add) the customer an udhar bill belongs to.
export function CustomerPicker({ value, onChange, currency }) {
  const { customers } = useApp();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  if (value) {
    const c = customers.find((x) => x.clientId === value.clientId) || value;
    return (
      <div className="cust-chosen">
        <div>
          <b>{c.name}</b> {c.phone && <span className="muted small">· {c.phone}</span>}
          <div className={"small " + (c.due > 0 ? "due-text" : "muted")}>{c.due > 0 ? `Already due ${money(c.due, currency)}` : "No dues"}</div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }

  const term = q.trim().toLowerCase();
  const digits = term.replace(/\D/g, "");
  const matches = term
    ? customers.filter((c) => c.name.toLowerCase().includes(term) || (digits.length >= 3 && (c.phone || "").replace(/\D/g, "").includes(digits)))
    : customers.filter((c) => c.due > 0);

  return (
    <div className="cust-picker">
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          placeholder="Customer name or phone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus={window.matchMedia("(min-width: 861px)").matches}
          enterKeyHint="search"
        />
        <button type="button" className="btn" onClick={() => setAdding(true)}>+ New</button>
      </div>
      <div className="cust-list">
        {matches.slice(0, 6).map((c) => (
          <button type="button" key={c.clientId} className="cust-option" onClick={() => onChange(c)}>
            <span>
              {c.name} {c.phone && <span className="muted small">· {c.phone}</span>}
            </span>
            {c.due > 0 && <span className="due-text small">{money(c.due, currency)}</span>}
          </button>
        ))}
        {term && matches.length === 0 && (
          <button type="button" className="cust-option" onClick={() => setAdding(true)}>
            <span>+ Add “{q.trim()}” as a new customer</span>
          </button>
        )}
      </div>
      {adding && (
        <NewCustomer
          initialName={/\d{3,}/.test(q) ? "" : q.trim()}
          initialPhone={/^\d[\d\s+-]{5,}$/.test(q.trim()) ? q.trim() : ""}
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            onChange(c);
          }}
        />
      )}
    </div>
  );
}

export function NewCustomer({ initialName = "", initialPhone = "", onClose, onCreated }) {
  const { addCustomer, shop } = useApp();
  const [f, setF] = useState({ name: initialName, phone: initialPhone, address: "", note: "", language: "" });
  const shopLang = LANGUAGE_OPTIONS.find(([c]) => c === languageFor({}, shop))?.[1];
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal title="New udhar customer" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => onCreated(await addCustomer(f)));
        }}
      >
        <Field label="Name">
          <input required maxLength={60} autoFocus value={f.name} onChange={set("name")} />
        </Field>
        <Field label="Phone (for reminders)" hint="10-digit mobile number. Needed to send WhatsApp reminders.">
          <input type="tel" inputMode="tel" pattern="[0-9+\- ]{10,15}" maxLength={15} value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Address (optional)">
          <input maxLength={160} value={f.address} onChange={set("address")} />
        </Field>
        <Field label="Note (optional)" hint="e.g. works at the petrol pump, pays on the 1st">
          <input maxLength={160} value={f.note} onChange={set("note")} />
        </Field>
        <Field label="Reminder language">
          <select value={f.language} onChange={set("language")}>
            <option value="">Shop default ({shopLang})</option>
            {LANGUAGE_OPTIONS.filter(([c]) => c !== "custom").map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Add customer</button>
        </div>
      </form>
    </Modal>
  );
}
