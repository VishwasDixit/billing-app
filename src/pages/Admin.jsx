import { useEffect, useMemo, useState } from "react";
import { get, post, put } from "../lib/api.js";
import { fmtDate, fmtDateTime, money } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { downloadExcel, downloadPdf } from "../lib/adminExport.js";

const STATUS = [
  ["all", "All"],
  ["trial", "On trial"],
  ["paid", "Paying"],
  ["expired", "Expired"],
  ["ending", "Ending in 3 days"],
  ["blocked", "Blocked"],
  ["custom", "Special price"],
];

const SORTS = [
  ["new", "Newest first"],
  ["sales", "Most sales"],
  ["active", "Recently active"],
  ["ending", "Access ending soon"],
];

const digits = (s) => String(s || "").replace(/\D/g, "");

function matchesStatus(s, status) {
  switch (status) {
    case "all": return true;
    case "blocked": return !!s.blocked;
    case "custom": return s.prices.custom;
    case "ending": return !s.blocked && ["trial", "paid"].includes(s.status.state) && s.status.daysLeft <= 3;
    default: return !s.blocked && s.status.state === status;
  }
}

// Matches shop name, owner name, email, or phone (ignoring spaces, dashes and +91).
function matchesSearch(s, q) {
  if (!q) return true;
  const text = q.toLowerCase().trim();
  const hay = [s.name, s.owner?.name, s.owner?.email].join(" ").toLowerCase();
  if (hay.includes(text)) return true;
  const d = digits(text);
  return d.length >= 3 && digits(s.owner?.phone).includes(d);
}

const SORTERS = {
  new: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  sales: (a, b) => b.sales - a.sales,
  active: (a, b) => new Date(b.lastBillAt || 0) - new Date(a.lastBillAt || 0),
  ending: (a, b) => new Date(a.status.endsAt) - new Date(b.status.endsAt),
};

export function StatusTag({ shop }) {
  if (shop.blocked) return <span className="tag bad">blocked</span>;
  const st = shop.status.state;
  return <span className={"tag " + (st === "paid" ? "good" : st === "trial" || st === "admin" ? "accent" : "bad")}>{st}</span>;
}

const waLink = (phone) => {
  const d = digits(phone);
  return d ? `https://wa.me/${d.length === 10 ? "91" + d : d}` : null;
};

export default function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState("shops");
  const [shops, setShops] = useState([]);
  const [payments, setPayments] = useState([]);
  const [storage, setStorage] = useState(null);
  const [manageId, setManageId] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("new");
  const [payStatus, setPayStatus] = useState("pending");
  const [payQ, setPayQ] = useState("");
  const { busy, error, run } = useAction();

  const load = () =>
    run(async () => {
      const [s, p] = await Promise.all([get("/admin/shops"), get("/admin/payments")]);
      setShops(s.shops);
      setPayments(p.payments);
      get("/admin/storage").then(setStorage).catch(() => {});
    });
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = payments.filter((p) => p.status === "pending");
  const act = (id, action) =>
    run(async () => {
      if (action === "reject" && !confirm("Reject this payment?")) return;
      await post(`/admin/payments/${id}/${action}`, {});
      toast(action === "approve" ? "Approved: plan extended" : "Rejected");
      load();
    });

  const counts = useMemo(() => Object.fromEntries(STATUS.map(([k]) => [k, shops.filter((s) => matchesStatus(s, k)).length])), [shops]);
  const visible = useMemo(
    () => shops.filter((s) => matchesStatus(s, status) && matchesSearch(s, q)).sort(SORTERS[sort]),
    [shops, status, q, sort]
  );
  const visiblePayments = payments.filter((p) => {
    if (payStatus !== "all" && p.status !== payStatus) return false;
    const t = payQ.toLowerCase().trim();
    return !t || p.shopName.toLowerCase().includes(t) || String(p.utr || "").toLowerCase().includes(t);
  });
  const manage = shops.find((s) => s.id === manageId);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Admin</h1>
        <Seg
          value={tab}
          onChange={setTab}
          options={[["shops", `Shops (${shops.length})`], ["payments", `Payments${pending.length ? ` (${pending.length} new)` : ""}`], ["reminders", "Reminders"]]}
        />
      </div>

      <div className="stats admin-stats">
        {[["all", "Shops"], ["trial", "On trial"], ["paid", "Paying"], ["expired", "Expired"], ["blocked", "Blocked"]].map(([k, label]) => (
          <button
            key={k}
            className={"stat stat-btn" + (tab === "shops" && status === k ? " on" : "")}
            onClick={() => (setTab("shops"), setStatus(k))}
          >
            <div className="label">{label}</div>
            <div className="value">{counts[k] ?? 0}</div>
          </button>
        ))}
      </div>
      {storage && <StorageMeter s={storage} />}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {tab === "shops" && (
        <>
          <div className="admin-filters">
            <input
              className="input"
              type="search"
              placeholder="Search shop name, owner, email or phone"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="chips" style={{ marginBottom: 12 }}>
            {STATUS.map(([k, l]) => (
              <button key={k} className={"chip" + (status === k ? " on" : "")} onClick={() => setStatus(k)}>
                {l} · {counts[k]}
              </button>
            ))}
          </div>
          <div className="export-row">
            <span className="small muted">Download {visible.length === shops.length ? "all" : "these"} {visible.length} shop{visible.length === 1 ? "" : "s"}:</span>
            <button className="btn btn-sm" disabled={busy || !visible.length} onClick={() => run(() => downloadExcel(visible))}>📊 Excel</button>
            <button
              className="btn btn-sm"
              disabled={busy || !visible.length}
              onClick={() => run(() => downloadPdf(visible, { title: `Shopkeepers${status !== "all" ? ` · ${STATUS.find(([k]) => k === status)[1]}` : ""}${q ? ` · "${q}"` : ""}` }))}
            >
              📄 PDF
            </button>
          </div>

          <div className="shop-list">
            {visible.map((s) => (
              <div key={s.id} className={"card shop-row" + (s.blocked ? " is-blocked" : "")}>
                <button className="shop-main" onClick={() => setManageId(s.id)}>
                  <div className="shop-title">
                    <b>{s.name}</b> <StatusTag shop={s} />
                    {s.prices.custom && <span className="tag warn">₹{s.prices.monthly}/m · ₹{s.prices.yearly}/y</span>}
                  </div>
                  <div className="small">{s.owner?.name} · {s.owner?.email}</div>
                  <div className="small muted">
                    {s.owner?.phone} · {s.blocked ? `blocked ${fmtDate(s.blocked.at)}` : `till ${fmtDate(s.status.endsAt)} (${s.status.daysLeft}d)`} · {s.bills} bills · {money(s.sales)}
                    {s.lastBillAt && ` · last bill ${fmtDateTime(s.lastBillAt)}`}
                  </div>
                </button>
                <div className="shop-actions">
                  {s.owner?.phone && <a className="btn btn-sm" href={`tel:${digits(s.owner.phone)}`} title="Call">📞</a>}
                  {waLink(s.owner?.phone) && <a className="btn btn-sm" href={waLink(s.owner.phone)} target="_blank" rel="noopener noreferrer" title="WhatsApp">💬</a>}
                  <button className="btn btn-sm btn-primary" onClick={() => setManageId(s.id)}>Manage</button>
                </div>
              </div>
            ))}
            {visible.length === 0 && <div className="empty">{shops.length ? "No shops match these filters." : busy ? "Loading…" : "No shops yet."}</div>}
          </div>
        </>
      )}

      {tab === "payments" && (
        <>
          <div className="admin-filters">
            <input className="input" type="search" placeholder="Search shop or payment reference" value={payQ} onChange={(e) => setPayQ(e.target.value)} />
          </div>
          <div className="chips" style={{ marginBottom: 12 }}>
            {["pending", "approved", "rejected", "all"].map((k) => (
              <button key={k} className={"chip" + (payStatus === k ? " on" : "")} onClick={() => setPayStatus(k)}>
                {k[0].toUpperCase() + k.slice(1)} · {k === "all" ? payments.length : payments.filter((p) => p.status === k).length}
              </button>
            ))}
          </div>
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table className="table">
              <thead><tr><th>When</th><th>Shop</th><th>Plan</th><th>Method</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {visiblePayments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDateTime(p.createdAt)}</td>
                    <td><button className="link-btn" onClick={() => (setTab("shops"), setManageId(p.shopId))}>{p.shopName}</button></td>
                    <td>{p.plan} · ₹{p.amount}</td>
                    <td>{p.method === "upi" ? <>UPI <code>{p.utr}</code></> : p.method === "link" ? <>Razorpay link <code>{p.utr}</code></> : "Razorpay online"}</td>
                    <td>
                      <span className={"tag " + (p.status === "approved" ? "good" : p.status === "pending" ? "warn" : "bad")}>{p.approvedBy === "razorpay-auto" ? "auto-approved" : p.status}</span>
                      {p.autoCheck && <div className="hint">{p.autoCheck}</div>}
                    </td>
                    <td className="num">
                      {p.status === "pending" && (
                        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act(p.id, "reject")}>Reject</button>
                          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(p.id, "approve")}>Approve</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visiblePayments.length === 0 && <div className="empty">{payments.length ? "No payments match." : "No payments yet."}</div>}
            {pending.some((p) => p.method === "link") && (
              <div style={{ padding: "12px 12px 0" }}>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await post("/admin/payments/recheck", {});
                      toast(r.approved ? `Razorpay confirmed ${r.approved} payment(s): plans extended` : "Razorpay hasn't confirmed any pending payment yet");
                      load();
                    })
                  }
                >
                  Check pending payments with Razorpay
                </button>
              </div>
            )}
            {pending.length > 0 && <p className="hint" style={{ padding: "0 12px 12px" }}>Check each reference before approving: UPI UTRs in your bank / UPI app, pay_ IDs in Razorpay Dashboard → Payments.</p>}
          </div>
        </>
      )}

      {tab === "reminders" && <Reminders onOpenShop={(id) => (setTab("shops"), setManageId(id))} />}

      {manage && <ManageShop shop={manage} onClose={() => setManageId(null)} onDone={load} />}
    </div>
  );
}

const mb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// How full the database is, so you know when to upgrade MongoDB Atlas.
function StorageMeter({ s }) {
  const level = s.percent >= 90 ? "bad" : s.percent >= 70 ? "warn" : "good";
  return (
    <div className="card storage-meter" style={{ marginBottom: 12 }}>
      <div className="storage-top">
        <b>Database storage</b>
        <span className="small">{mb(s.usedBytes)} of {mb(s.limitBytes)} · {s.percent}%</span>
      </div>
      <div className="meter"><div className={"meter-fill " + level} style={{ width: Math.min(100, Math.max(1, s.percent)) + "%" }} /></div>
      <div className="small muted">
        ~{mb(s.perShopBytes)} per shop · {s.bills.count.toLocaleString("en-IN")} bills ({s.bills.perBillBytes ? `~${s.bills.perBillBytes} bytes each` : "none yet"}) · photos {mb(s.photos.bytes)}
      </div>
      {level !== "good" && (
        <div className={level === "bad" ? "error" : "banner warn"} style={{ marginTop: 6, borderRadius: 8 }}>
          {level === "bad" ? "Almost full: new bills may stop saving. " : "Getting full. "}
          Upgrade the database in MongoDB Atlas (then set DB_LIMIT_MB in Vercel to the new size).
        </div>
      )}
    </div>
  );
}

function Reminders({ onOpenShop }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const { busy, error, run } = useAction();
  const load = () => run(async () => setData(await get("/admin/reminders")));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (shopIds) =>
    run(async () => {
      const n = shopIds ? shopIds.length : data.due.filter((d) => d.canSend).length;
      if (!shopIds && !confirm(`Email a renewal reminder to ${n} shopkeeper${n === 1 ? "" : "s"} now?`)) return;
      const r = await post("/admin/reminders/send", shopIds ? { shopIds } : {});
      toast(`Sent ${r.sent} reminder${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`);
      setData(await get("/admin/reminders"));
    });

  if (!data) return <div className="empty">{error || "Loading…"}</div>;
  const ready = data.due.filter((d) => d.canSend);
  return (
    <div className="stack">
      <div className="card stack">
        <div>
          <h2 style={{ margin: 0 }}>Renewal reminder emails</h2>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            For shops whose access ends within {data.remindDays} days, and shops whose access has ended. Blocked shops are skipped.
          </p>
        </div>
        <div className={"banner " + (data.auto ? "info" : "warn")} style={{ margin: 0 }}>
          {data.auto
            ? "Automatic: every day around 10 AM, each shop gets one email when its plan is about to end and one when it ends."
            : "Automatic daily emails aren't switched on yet (CRON_SECRET is missing in Vercel)."}
        </div>
        {!data.emailReady && <div className="error">Email isn't working right now. Check the Gmail App password.</div>}
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy || !ready.length || !data.emailReady} onClick={() => send()}>
            ✉️ Email all {ready.length} now
          </button>
          <button className="btn" disabled={busy} onClick={load}>Refresh</button>
        </div>
        {data.due.length > ready.length && (
          <p className="hint" style={{ margin: 0 }}>Shops emailed in the last {data.cooldownHours} hours are skipped so nobody gets spammed.</p>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      <div className="shop-list">
        {data.due.map((d) => (
          <div key={d.shopId} className="card shop-row">
            <button className="shop-main" onClick={() => onOpenShop(d.shopId)}>
              <div className="shop-title">
                <b>{d.shop}</b>
                <span className={"tag " + (d.stage === "expired" ? "bad" : "warn")}>{d.stage === "expired" ? "expired" : `${d.daysLeft} day${d.daysLeft === 1 ? "" : "s"} left`}</span>
              </div>
              <div className="small">{d.owner} · {d.email}</div>
              <div className="small muted">
                {d.stage === "expired" ? "Ended" : "Ends"} {fmtDate(d.endsAt)}
                {d.lastSentAt ? ` · last reminder ${fmtDateTime(d.lastSentAt)}` : " · not reminded yet"}
              </div>
            </button>
            <div className="shop-actions">
              <button className="btn btn-sm" disabled={busy || !d.canSend || !data.emailReady} onClick={() => send([d.shopId])}>
                {d.canSend ? "Send" : "Sent"}
              </button>
            </div>
          </div>
        ))}
        {data.due.length === 0 && <div className="empty">No shop needs a reminder right now 🎉</div>}
      </div>

      {data.runs.length > 0 && (
        <div className="card">
          <h4 style={{ margin: "0 0 8px" }}>Recent sends</h4>
          {data.runs.map((r, i) => (
            <div key={i} className="small" style={{ padding: "4px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
              {fmtDateTime(r.at)} · {r.trigger === "auto" ? "automatic" : "by you"} · <b>{r.sent} sent</b>
              {r.failed > 0 && <span className="tag bad" style={{ marginLeft: 6 }} title={r.details?.failed?.map((f) => `${f.email}: ${f.error}`).join("\n")}>{r.failed} failed</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ManageShop({ shop, onClose, onDone }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [monthly, setMonthly] = useState(shop.prices.monthly);
  const [yearly, setYearly] = useState(shop.prices.yearly);
  const [reason, setReason] = useState(shop.blocked?.reason || "");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const isAdminShop = shop.status.state === "admin";

  const savePrices = (body) =>
    run(async () => {
      const r = await put(`/admin/shops/${shop.id}/prices`, body);
      setMonthly(r.monthly);
      setYearly(r.yearly);
      toast(`Prices for ${shop.name}: ₹${r.monthly}/month, ₹${r.yearly}/year`);
      onDone();
    });

  const setBlocked = (blocked) =>
    run(async () => {
      if (blocked && !confirm(`Block ${shop.name}? They will be logged out and can't use the app until you unblock them.`)) return;
      await post(`/admin/shops/${shop.id}/block`, { blocked, reason });
      toast(blocked ? `${shop.name} is blocked` : `${shop.name} is unblocked`);
      onDone();
    });

  return (
    <Modal title={shop.name} onClose={onClose} actions={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="stack manage">
        <div className="small">
          <StatusTag shop={shop} /> <span className="muted">since {fmtDate(shop.createdAt)} · {shop.bills} bills · {money(shop.sales)}</span>
        </div>

        {shop.owner && (
          <section>
            <h4>Owner</h4>
            <div className="small"><b>{shop.owner.name}</b> · {shop.owner.email} · {shop.owner.phone}</div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              {shop.owner.phone && <a className="btn btn-sm" href={`tel:${digits(shop.owner.phone)}`}>📞 Call</a>}
              {waLink(shop.owner.phone) && <a className="btn btn-sm" href={waLink(shop.owner.phone)} target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>}
              <a className="btn btn-sm" href={`mailto:${shop.owner.email}`}>✉️ Email</a>
            </div>
          </section>
        )}

        <section>
          <h4>Access</h4>
          <div className="small muted">{isAdminShop ? "Admin shop: always active" : `Access till ${fmtDate(shop.status.endsAt)} (${shop.status.state}, ${shop.status.daysLeft} days left)`}</div>
          {!isAdminShop && (
            <>
              <div className="chips" style={{ margin: "8px 0" }}>
                {[7, 30, 90, 365].map((d) => (
                  <button key={d} type="button" className={"chip" + (days === d ? " on" : "")} onClick={() => setDays(d)}>
                    {d === 365 ? "1 year" : `${d} days`}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input" type="number" min="1" max="3650" value={days} onChange={(e) => setDays(parseInt(e.target.value, 10) || 1)} aria-label="Days to add" />
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await post(`/admin/shops/${shop.id}/extend`, { plan: days >= 365 ? "yearly" : "monthly", days });
                      toast(`Extended till ${fmtDate(r.currentPeriodEnd)}`);
                      onDone();
                    })
                  }
                >
                  Add {days} days
                </button>
              </div>
            </>
          )}
        </section>

        {!isAdminShop && (
          <section>
            <h4>Subscription price for this shop</h4>
            <div className="grid2">
              <Field label="Monthly (₹)">
                <input type="number" min="1" inputMode="numeric" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
              </Field>
              <Field label="Yearly (₹)">
                <input type="number" min="1" inputMode="numeric" value={yearly} onChange={(e) => setYearly(e.target.value)} />
              </Field>
            </div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => savePrices({ monthly: Number(monthly), yearly: Number(yearly) })}>
                Save prices
              </button>
              {shop.prices.custom && (
                <button className="btn btn-sm" disabled={busy} onClick={() => savePrices({ monthly: null, yearly: null })}>Back to standard (₹49 / ₹400)</button>
              )}
            </div>
            <p className="hint" style={{ margin: "6px 0 0" }}>The shop sees these prices on its Plans page. Payments already made aren't changed.</p>
          </section>
        )}

        {!isAdminShop && (
          <section className={shop.blocked ? "danger-zone on" : "danger-zone"}>
            <h4>{shop.blocked ? `Blocked since ${fmtDate(shop.blocked.at)}` : "Block shop"}</h4>
            <Field label="Reason (shown to the shopkeeper)">
              <input maxLength={160} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Payment pending, misuse" disabled={!!shop.blocked} />
            </Field>
            {shop.blocked ? (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setBlocked(false)}>Unblock shop</button>
            ) : (
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setBlocked(true)}>Block shop</button>
            )}
          </section>
        )}

        {shop.owner && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await post(`/admin/users/${shop.owner.id}/password`, { password });
                toast("Password reset. Tell the shopkeeper their new password.");
                setPassword("");
              });
            }}
          >
            <h4>Reset password</h4>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" type="text" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (6+ characters)" />
              <button className="btn" disabled={busy}>Reset</button>
            </div>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}
