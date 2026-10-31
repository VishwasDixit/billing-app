// "📸 Insta reward" (Settings › Instagram reward): the customer showed their story, so staff give
// this mobile its one free-meal code. Asking again shows the same code.
import { useState } from "react";
import { useApp } from "../lib/store.jsx";
import { post } from "../lib/api.js";
import { fmtDate } from "../lib/format.js";
import { waLink } from "../lib/udhar.js";
import { Modal, useAction } from "./ui.jsx";

export function InstaReward({ phone, name = "", small = true }) {
  const { shop } = useApp();
  const [r, setR] = useState(null);
  const { busy, error, run } = useAction();
  if (!shop.insta?.on || !phone) return null;
  const cur = shop.currency || "₹";
  const give = () => run(async () => setR(await post("/insta-reward", { phone })));
  const link =
    r &&
    waLink(
      phone,
      `Hi ${String(name).split(" ")[0] || "there"}! 🎉 Thanks for sharing ${shop.name} on Instagram. Your code *${r.code}* gives you 1 meal free (up to ${cur}${r.maxDiscount}), valid till ${fmtDate(r.validTo)}.` +
        (shop.qrOrdering && shop.orderToken ? `\nOrder here: ${window.location.origin}/order/${shop.orderToken}?code=${r.code}` : "\nShow this code when you pay.")
    );
  return (
    <>
      <button className={"btn btn-ig" + (small ? " btn-sm" : "")} disabled={busy} onClick={give} title="The customer showed their Instagram story">
        {busy ? "…" : "📸 Insta reward"}
      </button>
      {error && !r && <span className="error small">{error}</span>}
      {r && (
        <Modal title="📸 Instagram reward" onClose={() => setR(null)}>
          <div className="stack" style={{ textAlign: "center" }}>
            {r.already && <div className="banner warn">{r.used ? "Already given and used" : "Already given"} on {fmtDate(r.givenAt)}. Each mobile gets it once.</div>}
            <div className="small muted">Code for {name || "this customer"} · {phone}</div>
            <div className="ig-code">{r.code}</div>
            <div>1 meal free, up to <b>{cur}{r.maxDiscount}</b>, once, till {fmtDate(r.validTo)}.</div>
            {r.sentOnWa && <div className="ok-text small">✅ Sent to the customer on WhatsApp</div>}
            <div className="btn-row" style={{ justifyContent: "center" }}>
              {!r.used && !r.sentOnWa && link && <a className="btn btn-wa" href={link} target="_blank" rel="noopener noreferrer">📲 Send on WhatsApp</a>}
              <button className="btn" onClick={() => setR(null)}>Done</button>
            </div>
            <span className="hint">Use it at Billing or in the customer's QR cart: it takes the meal off, up to {cur}{r.maxDiscount}.</span>
          </div>
        </Modal>
      )}
    </>
  );
}
