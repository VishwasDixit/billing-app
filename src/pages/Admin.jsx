import { useEffect, useState } from "react";
import { get, post } from "../lib/api.js";
import { fmtDate, fmtDateTime, money } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";

export default function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState("payments");
  const [shops, setShops] = useState([]);
  const [payments, setPayments] = useState([]);
  const [manage, setManage] = useState(null);
  const { busy, error, run } = useAction();

  const load = () =>
    run(async () => {
      const [s, p] = await Promise.all([get("/admin/shops"), get("/admin/payments")]);
      setShops(s.shops);
      setPayments(p.payments);
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

  const counts = {
    total: shops.length,
    trial: shops.filter((s) => s.status.state === "trial").length,
    paid: shops.filter((s) => s.status.state === "paid").length,
    expired: shops.filter((s) => s.status.state === "expired").length,
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Admin</h1>
        <Seg value={tab} onChange={setTab} options={[["payments", `Payments${pending.length ? ` (${pending.length})` : ""}`], ["shops", "Shops"]]} />
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Shops</div><div className="value">{counts.total}</div></div>
        <div className="stat"><div className="label">On trial</div><div className="value">{counts.trial}</div></div>
        <div className="stat"><div className="label">Paying</div><div className="value">{counts.paid}</div></div>
        <div className="stat"><div className="label">Expired</div><div className="value">{counts.expired}</div></div>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {tab === "payments" && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Shop</th><th>Plan</th><th>Method</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDateTime(p.createdAt)}</td>
                  <td>{p.shopName}</td>
                  <td>{p.plan} · ₹{p.amount}</td>
                  <td>{p.method === "upi" ? <>UPI <code>{p.utr}</code></> : "Razorpay"}</td>
                  <td><span className={"tag " + (p.status === "approved" ? "good" : p.status === "pending" ? "warn" : "bad")}>{p.status}</span></td>
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
          {payments.length === 0 && <div className="empty">No payments yet.</div>}
          {pending.length > 0 && <p className="hint" style={{ padding: "0 12px 12px" }}>Check each UTR in your bank / UPI app before approving.</p>}
        </div>
      )}

      {tab === "shops" && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Shop</th><th>Owner</th><th>Status</th><th className="num">Bills</th><th className="num">Sales</th><th>Last bill</th></tr></thead>
            <tbody>
              {shops.map((s) => (
                <tr key={s.id} className="click" onClick={() => setManage(s)}>
                  <td><b>{s.name}</b><div className="muted small">since {fmtDate(s.createdAt)}</div></td>
                  <td>{s.owner?.name}<div className="muted small">{s.owner?.email} · {s.owner?.phone}</div></td>
                  <td>
                    <span className={"tag " + (s.status.state === "paid" ? "good" : s.status.state === "trial" || s.status.state === "admin" ? "accent" : "bad")}>{s.status.state}</span>
                    <div className="muted small">till {fmtDate(s.status.endsAt)}</div>
                  </td>
                  <td className="num">{s.bills}</td>
                  <td className="num">{money(s.sales)}</td>
                  <td className="muted">{s.lastBillAt ? fmtDateTime(s.lastBillAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manage && <ManageShop shop={manage} onClose={() => setManage(null)} onDone={load} />}
    </div>
  );
}

function ManageShop({ shop, onClose, onDone }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  return (
    <Modal title={shop.name} onClose={onClose} actions={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <div className="small muted">Access till {fmtDate(shop.status.endsAt)} ({shop.status.state})</div>
        <div className="field">
          Give extra days (added on top of remaining time)
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" type="number" min="1" max="3650" value={days} onChange={(e) => setDays(parseInt(e.target.value, 10) || 1)} />
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await post(`/admin/shops/${shop.id}/extend`, { plan: days >= 365 ? "yearly" : "monthly", days });
                  toast(`Extended till ${fmtDate(r.currentPeriodEnd)}`);
                  onDone();
                  onClose();
                })
              }
            >
              Extend
            </button>
          </div>
        </div>
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
            <Field label={`Reset password for ${shop.owner.email}`}>
              <input type="text" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (6+ characters)" />
            </Field>
            <button className="btn" disabled={busy}>Reset password</button>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}
