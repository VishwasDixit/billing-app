import { useEffect, useReducer, useState } from "react";
import { Link } from "react-router-dom";
import { useApp, accessState } from "../lib/store.jsx";
import { post } from "../lib/api.js";
import { fmtDate } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { PAPER } from "../printer/receipt.js";
import { printTest, warmLogo } from "../printer/index.js";
import { prepareLogo } from "../printer/escpos.js";
import { resizeLogo } from "../lib/image.js";
import { useShowPictures } from "../lib/prefs.js";
import {
  printer, bleConnect, bleWrite, shortUuid, saveChannel, savedChannelFor, onPrinterChange, explainPrintError,
} from "../printer/transports.js";

const pick = (s) => ({
  name: s.name || "",
  logo: s.logo || "",
  address: s.address || "",
  phone: s.phone || "",
  gstin: s.gstin || "",
  footer: s.footer || "",
  currency: s.currency || "₹",
  gstPercent: s.gstPercent ?? 0,
  defaultDiscount: { ...(s.defaultDiscount || { type: "percent", value: 0 }) },
  printer: { ...s.printer },
});

export default function Settings() {
  const { shop, user, saveShop, logout } = useApp();
  const toast = useToast();
  const [f, setF] = useState(() => pick(shop));
  const [diag, setDiag] = useState(false);
  const [pw, setPw] = useState(false);
  const [showPictures, setShowPictures] = useShowPictures();
  const { busy, error, run } = useAction();
  const access = accessState(shop);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setP = (k, v) => setF((x) => ({ ...x, printer: { ...x.printer, [k]: v } }));
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(shop));

  const save = () =>
    run(async () => {
      const saved = await saveShop({ ...f, gstPercent: Number(f.gstPercent) || 0, defaultDiscount: { ...f.defaultDiscount, value: Number(f.defaultDiscount.value) || 0 } });
      warmLogo(saved);
      toast("Settings saved");
    });

  const onLogo = async (file) => {
    if (!file) return;
    try {
      set("logo", await resizeLogo(file));
    } catch {
      toast("Couldn't read that image. Try a PNG or JPEG.");
    }
  };

  const testPrint = async () => {
    const draft = { ...shop, ...f };
    try {
      if (draft.printer.printLogo && draft.logo) await prepareLogo(draft.logo, draft.printer.paperSize);
      await printTest(draft);
    } catch (err) {
      const msg = explainPrintError(err);
      if (msg) toast(msg);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <div className="btn-row">
          {dirty && <button className="btn" onClick={() => setF(pick(shop))}>Undo changes</button>}
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="settings-grid">
        <div className="cards">
          <section className="card stack">
            <h2>Shop</h2>
            <div className="logo-pick">
              <div className="logo-box">{f.logo ? <img src={f.logo} alt="Shop logo" /> : "No logo"}</div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="btn btn-sm">
                  {f.logo ? "Change logo" : "Upload logo"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onLogo(e.target.files[0])} />
                </label>
                {f.logo && <button className="btn btn-sm btn-ghost" onClick={() => set("logo", "")}>Remove</button>}
              </div>
            </div>
            <Field label="Shop name"><input maxLength={40} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Address"><textarea rows={2} maxLength={160} value={f.address} onChange={(e) => set("address", e.target.value)} /></Field>
            <div className="grid2">
              <Field label="Phone"><input maxLength={30} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
              <Field label="GSTIN (optional)"><input maxLength={20} value={f.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} /></Field>
            </div>
            <Field label="Bill footer"><input maxLength={80} value={f.footer} onChange={(e) => set("footer", e.target.value)} /></Field>
          </section>

          <section className="card stack">
            <h2>Bill defaults</h2>
            <div className="grid2">
              <Field label="GST %" hint="Applied after discount; printed as CGST + SGST.">
                <input type="number" min="0" max="100" step="0.01" value={f.gstPercent} onChange={(e) => set("gstPercent", e.target.value)} />
              </Field>
              <Field label="Currency symbol"><input maxLength={4} value={f.currency} onChange={(e) => set("currency", e.target.value)} /></Field>
            </div>
            <div className="field">
              Default discount
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input" type="number" min="0" step="0.01" value={f.defaultDiscount.value} onChange={(e) => set("defaultDiscount", { ...f.defaultDiscount, value: e.target.value })} />
                <Seg value={f.defaultDiscount.type} onChange={(v) => set("defaultDiscount", { ...f.defaultDiscount, type: v })} options={[["percent", "%"], ["flat", "Flat"]]} />
              </div>
              <span className="hint">You can still change discount and GST on any single bill.</span>
            </div>
          </section>

          <section className="card stack">
            <h2>Menu</h2>
            <p className="muted small" style={{ margin: 0 }}>Add, edit or hide items, set Half/Full prices and add photos.</p>
            <Link className="btn" to="/menu">Edit menu</Link>
            <label className="check">
              <input type="checkbox" checked={showPictures} onChange={(e) => setShowPictures(e.target.checked)} />
              Show pictures on the billing screen (this device)
            </label>
          </section>
        </div>

        <div className="cards">
          <section className="card stack">
            <h2>Printer</h2>
            <div className="field">
              Paper size
              <Seg
                value={f.printer.paperSize}
                onChange={(v) => setF((x) => ({ ...x, printer: { ...x.printer, paperSize: v, charsPerLine: PAPER[v].cols } }))}
                options={[[58, "58 mm"], [80, "80 mm"], [110, "110 mm"]]}
              />
            </div>
            <Field label="Print method">
              <select value={f.printer.method} onChange={(e) => setP("method", e.target.value)}>
                <option value="bluetooth">Bluetooth printer (Chrome, Android / computer)</option>
                <option value="rawbt">RawBT app (Android)</option>
                <option value="serial">Bluetooth serial (Chrome, computer)</option>
                <option value="browser">Browser print dialog (installed printer)</option>
              </select>
            </Field>
            <Field label="Characters per line" hint={`Default for ${f.printer.paperSize} mm is ${PAPER[f.printer.paperSize].cols}. Lower it if lines wrap on the test print.`}>
              <input type="number" min="16" max="80" value={f.printer.charsPerLine} onChange={(e) => setP("charsPerLine", parseInt(e.target.value, 10) || PAPER[f.printer.paperSize].cols)} />
            </Field>
            <label className="check"><input type="checkbox" checked={f.printer.printLogo} onChange={(e) => setP("printLogo", e.target.checked)} /> Print logo on bills</label>
            <label className="check"><input type="checkbox" checked={f.printer.largeText} onChange={(e) => setP("largeText", e.target.checked)} /> Large shop name &amp; total</label>
            <label className="check"><input type="checkbox" checked={f.printer.slowMode} onChange={(e) => setP("slowMode", e.target.checked)} /> Slow mode (if the printer drops data)</label>
            <label className="check"><input type="checkbox" checked={f.printer.cut} onChange={(e) => setP("cut", e.target.checked)} /> Cut paper (auto-cutter only)</label>
            <p className="hint" style={{ margin: 0 }}>Logo and large text use more battery. Turn them off if the printer switches off while printing.</p>
            <div className="btn-row">
              <button className="btn" onClick={testPrint}>Test print</button>
              <button className="btn" onClick={() => setDiag(true)}>Diagnose printer</button>
            </div>
          </section>

          <section className="card stack">
            <h2>Account &amp; plan</h2>
            <div className="small">
              <div><b>{user.name}</b> · {user.email}</div>
              <div className="muted">
                {access.state === "admin" && "Admin account"}
                {access.state === "trial" && `Free trial until ${fmtDate(access.endsAt)}`}
                {access.state === "paid" && `${access.plan === "yearly" ? "Yearly" : "Monthly"} plan until ${fmtDate(access.endsAt)}`}
                {access.state === "expired" && "Plan ended"}
              </div>
            </div>
            <div className="btn-row">
              <Link className="btn" to="/plans">Plans &amp; payments</Link>
              <button className="btn" onClick={() => setPw(true)}>Change password</button>
              <button className="btn btn-danger" onClick={() => confirm("Log out of this device?") && logout()}>Log out</button>
            </div>
          </section>
        </div>
      </div>

      {diag && <Diagnostics slowMode={f.printer.slowMode} onClose={() => setDiag(false)} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function PasswordModal({ onClose }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Modal title="Change password" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await post("/auth/password", { current, password });
            toast("Password changed");
            onClose();
          });
        }}
      >
        <Field label="Current password"><input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 6 characters"><input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Change</button>
        </div>
      </form>
    </Modal>
  );
}

const HELLO = new Uint8Array([0x1b, 0x40, ...[..."Hello\n"].map((c) => c.charCodeAt(0)), 0x0a, 0x0a]);

// Lists the printer's Bluetooth channels so the right print channel can be picked.
function Diagnostics({ slowMode, onClose }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const [log, setLog] = useState([]);
  useEffect(() => onPrinterChange(rerender), []);
  const say = (m) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]);

  const d = printer.device;
  const connected = !!(d && d.gatt.connected);
  const saved = d && savedChannelFor(d.name);

  const doConnect = async () => {
    const pickNew = !d || connected;
    say(pickNew ? "Choosing printer…" : "Reconnecting…");
    try {
      printer.char = null;
      await bleConnect(pickNew);
      const ch = printer.channels.find((c) => c.char === printer.char);
      say(`Connected to ${printer.device.name || "printer"}. ${printer.channels.length} channels; auto-picked ${shortUuid(ch.uuid)}.`);
    } catch (err) {
      const msg = explainPrintError(err);
      if (msg) say("Error: " + msg);
    }
    rerender();
  };

  return (
    <Modal title="Printer diagnostics" wide onClose={onClose} actions={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          Close other printer apps first. Connect, then press <b>Send Hello</b> on each writable channel. Press <b>Use this</b> on the one that prints “Hello”.
        </p>
        <b>{d ? `${d.name || "Unnamed printer"} — ${connected ? "connected" : "disconnected"}` : "No printer connected."}</b>
        <button className="btn btn-primary" onClick={doConnect}>{d ? (connected ? "Choose another printer" : "Reconnect") : "Connect printer"}</button>
        {connected &&
          printer.channels.map((ch, i) => (
            <div key={i} className={"diag-ch" + (printer.char === ch.char ? " in-use" : "")}>
              <div>
                <div className="diag-uuid">
                  {shortUuid(ch.uuid)} {printer.char === ch.char && <span className="tag accent">in use</span>} {ch.uuid === saved && <span className="tag good">saved</span>}
                </div>
                <div className="muted small">service {shortUuid(ch.service)} · {ch.props.join(", ") || "none"}</div>
              </div>
              {ch.writable && (
                <div className="btn-row">
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      say(`Sending Hello to ${shortUuid(ch.uuid)}…`);
                      try {
                        await bleWrite(ch.char, HELLO, slowMode);
                        await new Promise((r) => setTimeout(r, 1500));
                        say(printer.device.gatt.connected ? "Sent. Did the printer print “Hello”?" : "Sent, but the printer disconnected (it may have reset). Avoid this channel.");
                      } catch (err) {
                        say("Error: " + (explainPrintError(err) || err));
                      }
                    }}
                  >
                    Send Hello
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      printer.char = ch.char;
                      saveChannel(d.name, ch.uuid);
                      say(`Will print to ${shortUuid(ch.uuid)} for ${d.name}.`);
                      rerender();
                    }}
                  >
                    Use this
                  </button>
                </div>
              )}
            </div>
          ))}
        <pre className="diag-log">{log.join("\n")}</pre>
      </div>
    </Modal>
  );
}
