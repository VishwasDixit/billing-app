import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { get, post } from "../lib/api.js";
import { money } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { cleanCode, fillName, offerText, promoSummary } from "../../shared/promo.js";
import { loyaltyMessage } from "../../shared/loyalty.js";
import { NewCustomer } from "../components/CustomerPicker.jsx";
import { SendQueue } from "../components/SendQueue.jsx";
import { reminderText, remindedToday, timeAgo, waNumber } from "../lib/udhar.js";

export default function Customers() {
  const { customers, shop, loadCustomers, online, user } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const cur = shop.currency || "₹";
  const [tab, setTab] = useState("due");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [queue, setQueue] = useState(null); // { kind: "remind" | "offer", list, index, sent, text? }
  // Send offer: choosing customers, then the code and message.
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [offering, setOffering] = useState(false);
  const canOffer = (c) => !!waNumber(c.phone);
  // Loyalty streak: tell every customer about it, with their own progress.
  const loyaltyOn = !!shop.loyalty?.on && user?.role !== "manager";
  const [params, setParams] = useSearchParams();
  const [streakBusy, setStreakBusy] = useState(false);
  const startStreak = async () => {
    setStreakBusy(true);
    try {
      const r = await get("/loyalty/customers");
      if (!r.customers.length) return toast("No customers with a mobile number yet.");
      const link = shop.qrOrdering && shop.orderToken ? `${window.location.origin}/order/${shop.orderToken}` : "";
      setPicking(false);
      setQueue({ kind: "streak", list: r.customers, index: 0, sent: 0, textFor: (c) => fillName(loyaltyMessage(shop.name, { count: c.count, need: r.need, dish: r.dish, link, reward: c.reward }), c.name) });
    } catch (err) {
      toast(err.offline ? "Streak reminders need internet." : err.message);
    } finally {
      setStreakBusy(false);
    }
  };
  useEffect(() => {
    if (params.get("streak") && loyaltyOn) {
      setParams({}, { replace: true });
      startStreak();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadCustomers().catch(() => {});
  }, [loadCustomers]);

  const owing = customers.filter((c) => c.due > 0);
  const totalDue = owing.reduce((s, c) => s + c.due, 0);
  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (tab === "due" ? owing : customers)
        .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.phone || "").includes(term))
        .sort((a, z) => z.due - a.due || a.name.localeCompare(z.name)),
    [customers, tab, term] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const remindable = owing.filter((c) => waNumber(c.phone) && c.id).sort((a, z) => z.due - a.due);
  const notToday = remindable.filter((c) => !remindedToday(c.lastRemindedAt));
  const noPhone = owing.filter((c) => !waNumber(c.phone));

  const startQueue = (includeToday) => {
    const list = includeToday ? remindable : notToday;
    if (!list.length) return toast(remindable.length ? "Everyone with dues was already reminded today." : "No customers with dues have a phone number.");
    setQueue({ kind: "remind", list, index: 0, sent: 0 });
  };
  const toggle = (c) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(c.clientId)) n.delete(c.clientId);
      else n.add(c.clientId);
      return n;
    });
  const shownOk = shown.filter(canOffer);
  const allShownChosen = shownOk.length > 0 && shownOk.every((c) => chosen.has(c.clientId));
  const chosenList = customers.filter((c) => chosen.has(c.clientId) && canOffer(c));
  const stopPicking = () => (setPicking(false), setChosen(new Set()));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Udhar</h1>
        <div className="btn-row">
          {loyaltyOn && !picking && (
            <button className="btn" disabled={streakBusy} onClick={startStreak}>🔥 Streak reminders</button>
          )}
          {user?.role !== "manager" && !picking && (
            <button className="btn" onClick={() => (setPicking(true), setTab("all"), setQueue(null))}>🏷 Send offer</button>
          )}
          <button className="btn btn-wa" disabled={!remindable.length} onClick={() => startQueue(false)}>
            📲 Remind all ({notToday.length})
          </button>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add customer</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Total udhar due</div><div className={"value" + (totalDue > 0 ? " due-text" : "")}>{money(totalDue, cur)}</div></div>
        <div className="stat"><div className="label">Customers owing</div><div className="value">{owing.length}</div></div>
        <div className="stat"><div className="label">All customers</div><div className="value">{customers.length}</div></div>
      </div>

      {queue && (
        <SendQueue
          queue={queue}
          title={queue.kind === "offer" ? "Offer" : queue.kind === "streak" ? "Streak message" : "Reminder"}
          amount={(c) => (queue.kind === "remind" ? money(c.due, cur) : queue.kind === "streak" ? (c.reward ? "🎁 Reward waiting" : c.count ? `🔥 ${c.count}-day streak` : "") : "")}
          textFor={(c) => (queue.kind === "offer" ? fillName(queue.text, c.name) : queue.kind === "streak" ? queue.textFor(c) : reminderText(c, shop))}
          onOpen={(c) => queue.kind === "remind" && post(`/customers/${c.id}/reminded`).catch(() => {})}
          onChange={setQueue}
          onDone={(sent) => {
            setQueue(null);
            toast(queue.kind === "remind" ? `Reminders sent: ${sent}` : `Sent to ${sent} customer${sent === 1 ? "" : "s"}`);
            if (queue.kind === "remind") loadCustomers().catch(() => {});
          }}
        />
      )}

      <div className="range-bar" style={{ marginBottom: 12 }}>
        <Seg value={tab} onChange={setTab} options={[["due", `Due (${owing.length})`], ["all", `All (${customers.length})`]]} />
        <input className="input" style={{ maxWidth: 260 }} type="search" placeholder="Search name or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
        {remindable.length > notToday.length && (
          <button className="btn btn-sm btn-ghost" onClick={() => startQueue(true)}>Remind again (incl. today)</button>
        )}
      </div>

      {picking && (
        <div className="offer-pick">
          <span>Choose who gets the offer. Customers without a mobile number can't be chosen.</span>
          <button className="btn btn-sm" disabled={!shownOk.length} onClick={() => setChosen((s) => {
            const n = new Set(s);
            for (const c of shownOk) allShownChosen ? n.delete(c.clientId) : n.add(c.clientId);
            return n;
          })}>{allShownChosen ? "Unselect shown" : `Select all shown (${shownOk.length})`}</button>
        </div>
      )}

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr>{picking && <th className="pick-col" aria-label="Chosen" />}<th>Customer</th><th>Last activity</th><th className="num">Due</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr
                key={c.clientId}
                className={"click" + (picking && !canOffer(c) ? " no-mobile" : "") + (picking && chosen.has(c.clientId) ? " picked" : "")}
                onClick={() => picking ? canOffer(c) && toggle(c) : (c.id ? nav(`/customers/${c.id}`) : toast(online ? "Still saving this customer, try again in a moment." : "This customer opens after the app is back online."))}
              >
                {picking && (
                  <td className="pick-col">
                    <input type="checkbox" checked={chosen.has(c.clientId)} disabled={!canOffer(c)} readOnly aria-label={`Choose ${c.name}`} />
                  </td>
                )}
                <td>
                  <b>{c.name}</b> {c.pending && <span className="tag warn">not synced</span>}
                  {c.payLaterBlocked && <span className="tag bad">Must pay first</span>}
                  {c.unpaidCount > 0 && !c.payLaterBlocked && <span className="tag warn">didn't pay ×{c.unpaidCount}</span>}
                  <div className="muted small">{c.phone || "No phone"}{c.lastRemindedAt ? ` · reminded ${timeAgo(c.lastRemindedAt)}` : ""}</div>
                </td>
                <td className="muted small">
                  {c.lastPaymentAt ? `Paid ${timeAgo(c.lastPaymentAt)}` : c.lastBillAt ? `Bill ${timeAgo(c.lastBillAt)}` : "—"}
                </td>
                <td className="num">
                  {c.due > 0 ? <span className="due-text">{money(c.due, cur)}</span> : c.due < 0 ? <span className="ok-text">Advance {money(-c.due, cur)}</span> : <span className="tag good">Settled ✅</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="empty">{tab === "due" ? "No pending udhar. 🎉" : "No customers yet. Choose “Udhar” as the payment on a bill, or add a customer."}</div>
        )}
      </div>

      {noPhone.length > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          {noPhone.length} customer{noPhone.length > 1 ? "s" : ""} with dues {noPhone.length > 1 ? "have" : "has"} no phone number ({noPhone.map((c) => c.name).join(", ")}). Add it to send reminders.
        </p>
      )}

      {picking && (
        <div className="offer-bar">
          <span>{chosenList.length} chosen</span>
          <button className="btn btn-ghost" onClick={stopPicking}>Cancel</button>
          <button className="btn btn-primary" disabled={!chosenList.length} onClick={() => setOffering(true)}>Next →</button>
        </div>
      )}

      {offering && (
        <OfferModal
          people={chosenList}
          shop={shop}
          cur={cur}
          onClose={() => setOffering(false)}
          onReady={(text) => {
            setOffering(false);
            setQueue({ kind: "offer", list: chosenList, index: 0, sent: 0, text });
            stopPicking();
          }}
        />
      )}

      {adding && (
        <NewCustomer
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            toast(`${c.name} added`);
            if (c.id) nav(`/customers/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

// No look-alike letters (O/0, I/1), so customers type it right.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => "VIP" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
const inDays = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

// The code for the chosen customers (a new one, or more people for an existing one) and the
// message they get. Only they can use it: their mobiles are saved with the code.
function OfferModal({ people, shop, cur, onClose, onReady }) {
  const [mode, setMode] = useState("new");
  const [p, setP] = useState(() => ({ code: randomCode(), type: "percent", value: 10, maxDiscount: 100, minOrder: 0, validTo: inDays(7), onePerPhone: true }));
  const [codes, setCodes] = useState(null);
  const [pickId, setPickId] = useState("");
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const num = (v) => Math.max(0, Number(v) || 0);
  const today = inDays(0);

  useEffect(() => {
    get("/promos").then((r) => setCodes(r.promos.filter((x) => x.active && (!x.validTo || x.validTo >= today))), () => setCodes([]));
  }, [today]);
  const picked = codes?.find((x) => x.id === pickId) || null;
  const promo = mode === "new" ? { ...p, code: cleanCode(p.code), value: num(p.value), maxDiscount: p.type === "percent" ? num(p.maxDiscount) : 0, minOrder: num(p.minOrder) } : picked;
  const link = promo && shop.qrOrdering && shop.orderToken ? `${window.location.origin}/order/${shop.orderToken}?code=${promo.code}` : "";
  const auto = promo?.code ? offerText(promo, shop.name, { link, cur }) : "";
  // The message follows the form until the owner edits it.
  useEffect(() => {
    if (!edited) setText(auto);
  }, [auto, edited]);

  const phones = people.map((c) => c.phone);
  const send = (e) => {
    e.preventDefault();
    run(async () => {
      if (mode === "new") {
        await post("/promos", { ...promo, description: "", validFrom: "", active: true, where: "both", showOnMenu: false, phones });
      } else {
        if (!picked) throw new Error("Choose a code.");
        await post(`/promos/${picked.id}/invite`, { phones });
      }
      onReady(text);
    });
  };

  return (
    <Modal title={`Offer for ${people.length} customer${people.length === 1 ? "" : "s"}`} onClose={onClose} wide>
      <form className="stack" onSubmit={send}>
        <p className="small muted" style={{ margin: 0 }}>{people.slice(0, 6).map((c) => c.name).join(", ")}{people.length > 6 ? ` and ${people.length - 6} more` : ""}</p>
        <Seg value={mode} onChange={setMode} options={[["new", "New code"], ["existing", "Existing code"]]} />
        {mode === "new" ? (
          <>
            <div className="grid2">
              <Field label="Code" hint="Only these customers can use it">
                <input required maxLength={20} pattern="[A-Za-z0-9]{3,20}" value={p.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} style={{ textTransform: "uppercase", fontWeight: 700 }} />
              </Field>
              <Field label="Valid until" hint="Last day it works">
                <input type="date" min={today} value={p.validTo} onChange={(e) => set("validTo", e.target.value)} />
              </Field>
            </div>
            <div className="field">
              Discount
              <Seg value={p.type} onChange={(v) => set("type", v)} options={[["percent", "% off"], ["flat", `${cur} off`]]} />
            </div>
            <div className="grid2">
              <Field label={p.type === "percent" ? "Percent off" : `Amount off (${cur})`}>
                <input type="number" required min="0.01" max={p.type === "percent" ? 100 : undefined} step="0.01" inputMode="decimal" value={p.value} onChange={(e) => set("value", e.target.value)} />
              </Field>
              {p.type === "percent" && (
                <Field label={`Up to (${cur})`} hint="0 = no cap">
                  <input type="number" min="0" step="1" inputMode="numeric" value={p.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} />
                </Field>
              )}
              <Field label={`Minimum order (${cur})`} hint="0 = any order">
                <input type="number" min="0" step="1" inputMode="numeric" value={p.minOrder} onChange={(e) => set("minOrder", e.target.value)} />
              </Field>
            </div>
            <label className="check"><input type="checkbox" checked={p.onePerPhone} onChange={(e) => set("onePerPhone", e.target.checked)} /> Once per customer</label>
          </>
        ) : codes === null ? (
          <p className="muted small">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="muted small">No active codes yet. Make a new one.</p>
        ) : (
          <Field label="Code">
            <select value={pickId} onChange={(e) => setPickId(e.target.value)} required>
              <option value="">Choose a code…</option>
              {codes.map((x) => (
                <option key={x.id} value={x.id}>{x.code} · {promoSummary(x, cur)}</option>
              ))}
            </select>
          </Field>
        )}
        {mode === "existing" && picked && !picked.phones?.length && <p className="hint" style={{ margin: 0, color: "var(--warn)" }}>⚠️ {picked.code} works for anyone who has it, not only these customers.</p>}
        {promo?.code && (
          <Field label="Message" hint={"{name} becomes each customer's name."}>
            <textarea rows={5} value={text} onChange={(e) => (setText(e.target.value), setEdited(true))} />
          </Field>
        )}
        {edited && <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setEdited(false)}>Reset message</button>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-wa" disabled={busy || !promo?.code || !text.trim()}>{busy ? "Saving…" : mode === "new" ? "Create & start sending" : "Start sending"}</button>
        </div>
      </form>
    </Modal>
  );
}
