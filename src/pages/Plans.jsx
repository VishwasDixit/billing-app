import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useApp, accessState } from "../lib/store.jsx";
import { get, post } from "../lib/api.js";
import { fmtDate, fmtDateTime } from "../lib/format.js";
import { Field, Modal, useAction, useToast } from "../components/ui.jsx";

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the payment page. Check the internet connection."));
    document.body.appendChild(s);
  });
}

export default function Plans() {
  const { shop, refresh, retryBlocked } = useApp();
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [history, setHistory] = useState([]);
  const [upiPlan, setUpiPlan] = useState(null);
  const { busy, error, run } = useAction();
  const access = accessState(shop);

  const load = () =>
    run(async () => {
      const [c, h] = await Promise.all([get("/pay/config"), get("/pay/history")]);
      setCfg(c);
      setHistory(h.payments);
    });
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const afterPaid = async () => {
    await refresh();
    await retryBlocked();
    load();
  };

  const payOnline = (plan) =>
    run(async () => {
      await loadRazorpay();
      const order = await post("/pay/razorpay/order", { plan: plan.id });
      await new Promise((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: "Billing app",
          description: `${plan.name} plan for ${order.shopName}`,
          prefill: order.prefill,
          notes: { plan: plan.id },
          theme: { color: "#0f766e" },
          handler: async (resp) => {
            try {
              await post("/pay/razorpay/verify", resp);
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: { ondismiss: () => reject(new Error("Payment cancelled.")) },
        });
        rzp.on("payment.failed", (r) => reject(new Error(r.error?.description || "Payment failed.")));
        rzp.open();
      });
      toast("Payment received. Thank you!");
      await afterPaid();
    });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Plans</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        {access.state === "admin" && <b>Admin account: no plan needed.</b>}
        {access.state === "trial" && <><b>Free trial</b> · ends {fmtDate(access.endsAt)} ({access.daysLeft} day{access.daysLeft === 1 ? "" : "s"} left)</>}
        {access.state === "paid" && <><b>{access.plan === "yearly" ? "Yearly" : "Monthly"} plan active</b> · valid till {fmtDate(access.endsAt)}</>}
        {access.state === "expired" && <><b className="error">Plan ended</b> on {fmtDate(access.endsAt)}. Choose a plan to continue billing. Your data is safe.</>}
        <p className="muted small" style={{ marginBottom: 0 }}>Paying early adds the new days on top of the days you have left.</p>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="plans">
        {(cfg?.plans || []).map((p) => (
          <div key={p.id} className={"card plan" + (p.id === "yearly" ? " best" : "")}>
            <h2 style={{ marginBottom: 0 }}>{p.name}</h2>
            <div className="price">₹{p.amount}</div>
            <div className="muted small">
              {p.days} days{p.id === "yearly" && ` · save ₹${49 * 12 - p.amount} vs monthly`}
            </div>
            <div className="stack" style={{ marginTop: 14 }}>
              {cfg.razorpayKeyId && (
                <button className="btn btn-primary" disabled={busy} onClick={() => payOnline(p)}>
                  Pay ₹{p.amount} online
                </button>
              )}
              {cfg.upi && (
                <button className={"btn" + (cfg.razorpayKeyId ? "" : " btn-primary")} onClick={() => setUpiPlan(p)}>
                  Pay by UPI QR
                </button>
              )}
              {!cfg.razorpayKeyId && !cfg.upi && <span className="muted small">Payments aren't set up yet. Contact the app owner.</span>}
            </div>
          </div>
        ))}
      </div>

      {history.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Payment history</h2>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {history.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDateTime(p.createdAt)}</td>
                    <td>{p.plan === "yearly" ? "Yearly" : "Monthly"} · ₹{p.amount}</td>
                    <td>{p.method === "upi" ? `UPI ${p.utr}` : "Online"}</td>
                    <td>
                      <span className={"tag " + (p.status === "approved" ? "good" : p.status === "pending" ? "warn" : "bad")}>
                        {p.status === "pending" ? "waiting for approval" : p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {upiPlan && cfg?.upi && <UpiModal plan={upiPlan} upi={cfg.upi} shopName={shop.name} onClose={() => setUpiPlan(null)} onSubmitted={load} />}
    </div>
  );
}

function UpiModal({ plan, upi, shopName, onClose, onSubmitted }) {
  const toast = useToast();
  const [qr, setQr] = useState("");
  const [utr, setUtr] = useState("");
  const { busy, error, run } = useAction();
  const link = `upi://pay?pa=${encodeURIComponent(upi.id)}&pn=${encodeURIComponent(upi.name)}&am=${plan.amount}&cu=INR&tn=${encodeURIComponent(`${plan.name} plan ${shopName}`.slice(0, 50))}`;

  useEffect(() => {
    QRCode.toDataURL(link, { width: 400, margin: 1 }).then(setQr);
  }, [link]);

  return (
    <Modal title={`Pay ₹${plan.amount} by UPI`} onClose={onClose}>
      <div className="stack">
        {qr && <img className="qr" src={qr} alt={`UPI QR code for ₹${plan.amount}`} />}
        <p className="small" style={{ textAlign: "center", margin: 0 }}>
          Scan with any UPI app, or pay to <b>{upi.id}</b>
        </p>
        <a className="btn" href={link}>Open UPI app on this phone</a>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await post("/pay/upi", { plan: plan.id, utr });
              toast("Submitted. Your plan starts as soon as the payment is confirmed.");
              onSubmitted();
              onClose();
            });
          }}
        >
          <Field label="After paying, enter the UPI reference / UTR number" hint="Find it in your payment app under the transaction details (usually 12 digits).">
            <input required value={utr} onChange={(e) => setUtr(e.target.value.replace(/\s/g, ""))} placeholder="e.g. 412345678901" />
          </Field>
          {error && <div className="error">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>I have paid – submit</button>
        </form>
      </div>
    </Modal>
  );
}
