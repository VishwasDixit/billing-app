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
  const [linkPlan, setLinkPlan] = useState(null);
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState(null); // { code, label, plans } once applied
  const [promoOpen, setPromoOpen] = useState(false);
  const [choose, setChoose] = useState(null); // plan picked, choosing how to pay
  const promoAction = useAction();
  const plans = promo?.plans || cfg?.plans || [];
  const applyPromo = (e) => {
    e.preventDefault();
    promoAction.run(async () => {
      const r = await post("/pay/promo", { code: promoInput });
      setPromo(r);
      toast(`${r.code} applied: ${r.label}`);
    });
  };
  const { busy, error, run } = useAction();
  const access = accessState(shop);

  const load = () =>
    run(async () => {
      const [c, h] = await Promise.all([get("/pay/config"), get("/pay/history")]);
      setCfg(c);
      setHistory(h.payments);
      // The server re-checks pending Razorpay payments; pick up any that just got approved.
      if (h.approved > 0) {
        toast("Payment confirmed by Razorpay. Your plan is active ✅");
        await refresh();
        await retryBlocked();
      }
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
      const order = await post("/pay/razorpay/order", { plan: plan.id, ...(plan.promo && { promo: plan.promo.code }) });
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

  const monthly = plans.find((x) => x.id === "monthly");
  const totalDays = access.state === "paid" ? plans.find((x) => x.id === access.plan)?.days || 30 : cfg?.trialDays || 3;
  const left = Math.min(100, Math.round((access.daysLeft / Math.max(1, totalDays)) * 100));
  const methods = cfg ? [cfg.razorpayKeyId && "online", cfg.upi && "upi", cfg.paymentLink && "link"].filter(Boolean) : [];

  return (
    <div className="page plans-page">
      <section className={"plan-hero " + access.state}>
        <div className="plan-hero-text">
          <div className="plan-hero-kicker">{access.state === "admin" ? "Admin account" : access.state === "paid" ? "Your plan" : access.state === "trial" ? "Free trial" : "Plan ended"}</div>
          <h1>
            {access.state === "admin" && "No plan needed"}
            {access.state === "trial" && `${access.daysLeft} day${access.daysLeft === 1 ? "" : "s"} left in your trial`}
            {access.state === "paid" && `${access.plan === "yearly" ? "Yearly" : "Monthly"} plan · ${access.daysLeft} days left`}
            {access.state === "expired" && "Renew to keep billing"}
          </h1>
          <p>
            {access.state === "expired"
              ? `Ended on ${fmtDate(access.endsAt)}. All your bills, menu and reports are safe.`
              : access.state === "admin"
                ? "Shops see this page to choose and pay for a plan."
                : `Valid till ${fmtDate(access.endsAt)}. Paying early adds the new days on top.`}
          </p>
          {access.state !== "admin" && access.state !== "expired" && (
            <div className="plan-meter" aria-label={`${access.daysLeft} days left`}><div style={{ width: Math.max(4, left) + "%" }} /></div>
          )}
        </div>
        <div className="plan-hero-icon" aria-hidden="true">{access.state === "paid" ? "✅" : access.state === "expired" ? "⏳" : "🎁"}</div>
      </section>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="plan-cards">
        {plans.map((p) => {
          const yearly = p.id === "yearly";
          const was = p.beforePromo || p.standardAmount;
          const perMonth = Math.round((p.amount / p.days) * 30);
          const vsMonthly = monthly && yearly ? Math.round((1 - p.amount / (monthly.amount * (p.days / monthly.days))) * 100) : 0;
          return (
            <div key={p.id} className={"plan-card" + (yearly ? " featured" : "")}>
              {yearly && (cfg?.yearlyBadge || vsMonthly > 0) && (
                <div className="plan-ribbon">{cfg?.yearlyBadge || "Best value"}{vsMonthly > 0 ? ` · Save ${vsMonthly}%` : ""}</div>
              )}
              <div className="plan-name">{p.name}</div>
              <div className="plan-price">
                {was > p.amount && <s>₹{was}</s>}
                <span className="amt">₹{p.amount}</span>
                <span className="per">/ {yearly ? "year" : "month"}</span>
              </div>
              <div className="plan-sub">
                {yearly ? `Just ₹${perMonth} a month · ${p.days} days` : `${p.days} days · renew any time`}
              </div>
              {p.promo ? (
                <div className="tag good">{p.promo.code}: you save ₹{p.promo.off}</div>
              ) : (
                p.standardAmount > p.amount && <div className="tag good">Special price for you</div>
              )}
              <ul className="plan-features">
                <li>Unlimited bills &amp; printing</li>
                <li>Udhar accounts &amp; WhatsApp reminders</li>
                <li>Sales dashboard &amp; Profit / Loss reports</li>
                <li>PDF &amp; Excel downloads</li>
                <li>Menu photos, GST &amp; payment QR on bills</li>
                <li>Works offline · help when you need it</li>
              </ul>
              {access.state !== "admin" && (
                <button className={"btn btn-lg " + (yearly ? "btn-primary" : "btn-outline")} disabled={busy || !methods.length} onClick={() => setChoose(p)}>
                  {access.state === "paid" ? "Extend" : "Choose"} {p.name.toLowerCase()} · ₹{p.amount}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {cfg && !methods.length && access.state !== "admin" && <p className="muted small">Payments aren't set up yet. Please contact us from the Help page.</p>}

      {cfg && access.state !== "admin" && (
        <div className="promo-line">
          {promo ? (
            <div className="promo-applied">
              <span>🎉 <b>{promo.code}</b> applied: {promo.label}</span>
              <button type="button" className="link-btn" onClick={() => (setPromo(null), setPromoInput(""))}>Remove</button>
            </div>
          ) : !promoOpen ? (
            <button type="button" className="link-btn" onClick={() => setPromoOpen(true)}>Have a promo code?</button>
          ) : (
            <form className="promo-row" onSubmit={applyPromo}>
              <input className="input" value={promoInput} onChange={(e) => setPromoInput(e.target.value.toUpperCase().replace(/\s/g, ""))} placeholder="Promo code" maxLength={20} autoCapitalize="characters" autoFocus aria-label="Promo code" />
              <button className="btn" disabled={promoAction.busy || promoInput.length < 3}>{promoAction.busy ? "Checking…" : "Apply"}</button>
            </form>
          )}
          {promoAction.error && <div className="error small">{promoAction.error}</div>}
        </div>
      )}

      <div className="trust-strip">
        <span>🔒 Secure payment by Razorpay</span>
        <span>🚫 No auto-renew, no hidden charges</span>
        <span>⚡ Starts instantly with online payment</span>
      </div>

      <details className="card plan-faq">
        <summary>Questions about plans</summary>
        <p className="small"><b>What happens when the trial ends?</b> Billing pauses until you choose a plan. Your menu, bills and udhar are kept safe.</p>
        <p className="small"><b>Can I switch from monthly to yearly?</b> Yes. Buy the yearly plan any time; its days are added on top of the days you have left.</p>
        <p className="small"><b>Is my data safe?</b> Your data is stored securely and only your shop can see it. You can download your reports any time.</p>
      </details>

      {history.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Payment history</h2>
          <div className="pay-history">
            {history.map((p) => (
              <div key={p.id} className="pay-row">
                <div>
                  <b>{p.plan === "yearly" ? "Yearly" : "Monthly"} · ₹{p.amount}</b>
                  {p.promoCode && <span className="tag good" style={{ marginLeft: 6 }}>{p.promoCode}</span>}
                  <div className="small muted">{fmtDateTime(p.createdAt)} · {p.method === "upi" ? `UPI ${p.utr}` : p.method === "link" ? `Razorpay ${p.utr}` : "Online"}</div>
                  {p.status === "pending" && p.autoCheck && <div className="hint">{p.autoCheck}</div>}
                </div>
                <span className={"tag " + (p.status === "approved" ? "good" : p.status === "pending" ? "warn" : "bad")}>
                  {p.status === "pending" ? "waiting" : p.status === "approved" ? "paid" : p.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {choose && (
        <Modal title={`${choose.name} plan · ₹${choose.amount}`} onClose={() => setChoose(null)}>
          <div className="pay-methods">
            {cfg.razorpayKeyId && (
              <button className="pay-method main" disabled={busy} onClick={() => (setChoose(null), payOnline(choose))}>
                <span className="pm-icon">💳</span>
                <span><b>Pay online</b><small>UPI apps, cards, netbanking · plan starts instantly</small></span>
              </button>
            )}
            {cfg.upi && (
              <button className="pay-method" onClick={() => (setChoose(null), setUpiPlan(choose))}>
                <span className="pm-icon">📱</span>
                <span><b>Scan UPI QR</b><small>Pay from any UPI app, then enter the reference number</small></span>
              </button>
            )}
            {cfg.paymentLink && (
              <button className="pay-method" onClick={() => (setChoose(null), setLinkPlan(choose))}>
                <span className="pm-icon">🔗</span>
                <span>
                  <b>{cfg.razorpayKeyId ? "Paid on razorpay.me?" : "Pay on razorpay.me"}</b>
                  <small>{cfg.razorpayKeyId ? "Enter your payment ID to activate" : "Open the payment page, then enter the payment ID"}</small>
                </span>
              </button>
            )}
          </div>
          <p className="hint" style={{ margin: "10px 0 0", textAlign: "center" }}>🔒 Payments are processed securely by Razorpay / your UPI app.</p>
        </Modal>
      )}
      {linkPlan && cfg?.paymentLink && <LinkModal plan={linkPlan} link={cfg.paymentLink} autoCheck={!!cfg.razorpayKeyId} onClose={() => setLinkPlan(null)} onSubmitted={load} onPaid={afterPaid} />}
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
              await post("/pay/upi", { plan: plan.id, utr, ...(plan.promo && { promo: plan.promo.code }) });
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

// Pay on the owner's Razorpay.me page, then submit the payment ID for approval.
function LinkModal({ plan, link, autoCheck, onClose, onSubmitted, onPaid }) {
  const toast = useToast();
  const [payId, setPayId] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Modal title={`Pay ₹${plan.amount} via Razorpay`} onClose={onClose}>
      <div className="stack">
        <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Tap the button below and enter the amount <b>₹{plan.amount}</b>.</li>
          <li>Pay with UPI, card or netbanking.</li>
          <li>Copy the <b>Payment ID</b> from the receipt (starts with <code>pay_</code>) and paste it here.</li>
        </ol>
        <a className="btn btn-primary" href={link} target="_blank" rel="noopener noreferrer">
          Open payment page (₹{plan.amount})
        </a>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await post("/pay/upi", { plan: plan.id, via: "link", utr: payId, ...(plan.promo && { promo: plan.promo.code }) });
              if (r.autoApproved) {
                toast("Payment confirmed by Razorpay. Your plan is active ✅");
                await onPaid();
              } else {
                toast("Submitted. Your plan starts as soon as the payment is confirmed.");
                onSubmitted();
              }
              onClose();
            });
          }}
        >
          <Field label="Razorpay Payment ID" hint="Also in the confirmation SMS / email from Razorpay.">
            <input required value={payId} onChange={(e) => setPayId(e.target.value.trim())} placeholder="pay_XXXXXXXXXXXXXX" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          {error && <div className="error">{error}</div>}
          <button className="btn" disabled={busy}>{busy ? (autoCheck ? "Checking with Razorpay…" : "Submitting…") : "I have paid – submit"}</button>
        </form>
      </div>
    </Modal>
  );
}
