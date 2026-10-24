import { useEffect, useReducer, useState } from "react";
import { Link } from "react-router-dom";
import { useApp, accessState } from "../lib/store.jsx";
import { post, put } from "../lib/api.js";
import { fmtDate } from "../lib/format.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { PAPER } from "../printer/receipt.js";
import { printTest, warmLogo } from "../printer/index.js";
import { prepareLogo, prepareQrImage } from "../printer/escpos.js";
import { resizeLogo, resizeQr } from "../lib/image.js";
import { billQr, qrSvg } from "../../shared/billQr.js";
import { planName } from "../../shared/plans.js";
import { useShowPictures } from "../lib/prefs.js";
import { useTheme } from "../lib/theme.js";
import { usePref } from "../lib/prefs.js";
import { downloadTableQrs, orderUrl } from "../lib/tableQr.js";
import { LANGUAGE_OPTIONS, DEFAULT_LANGUAGE, DEFAULT_TEMPLATE, reminderText } from "../../shared/messages.js";
import {
  printer, bleConnect, bleWrite, shortUuid, saveChannel, savedChannelFor, onPrinterChange, explainPrintError, isIOS, BLUEFY_URL,
} from "../printer/transports.js";

const pick = (s) => ({
  tables: (s.tables || []).map((t) => ({ ...t })),
  qrOrdering: !!s.qrOrdering,
  qrPayment: s.qrPayment || "end",
  name: s.name || "",
  logo: s.logo || "",
  address: s.address || "",
  phone: s.phone || "",
  gstin: s.gstin || "",
  footer: s.footer || "",
  currency: s.currency || "₹",
  upiId: s.upiId || "",
  qrMode: s.qrMode || "off",
  qrOn: s.qrOn || "all",
  qrImage: s.qrImage || "",
  reminderLanguage: s.reminderLanguage || DEFAULT_LANGUAGE,
  reminderTemplate: s.reminderTemplate || "",
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
  const [theme, setTheme] = useTheme();
  // Opened from "Set up tables": jump to that card.
  useEffect(() => {
    if (window.location.hash === "#tables") setTimeout(() => document.getElementById("tables")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  }, []);
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
      if (draft.qrMode === "image" && draft.qrImage) await prepareQrImage(draft.qrImage, draft.printer.paperSize);
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
              <Field label="GST number (GSTIN)" hint="Printed in bold at the top of every bill.">
                <input maxLength={15} placeholder="e.g. 09ABCDE1234F1Z5" value={f.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/\s/g, ""))} />
              </Field>
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

          <QrSettings f={f} set={set} toast={toast} />

          <section className="card stack">
            <h2>Udhar reminders</h2>
            <Field label="Message language" hint="Used for WhatsApp reminders and payment receipts. You can also set a different language for any customer.">
              <select value={f.reminderLanguage} onChange={(e) => set("reminderLanguage", e.target.value)}>
                {LANGUAGE_OPTIONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </Field>
            {f.reminderLanguage === "custom" && (
              <Field label="Your message" hint="Use {name}, {amount}, {shop} and {upi}. They are filled in for each customer.">
                <textarea rows={4} maxLength={500} placeholder={DEFAULT_TEMPLATE} value={f.reminderTemplate} onChange={(e) => set("reminderTemplate", e.target.value)} />
              </Field>
            )}
            <div className="field">
              Preview
              <pre className="diag-log" style={{ minHeight: 0 }}>{reminderText({ name: "Ramesh", due: 450 }, { ...shop, ...f })}</pre>
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
          <TablesCard f={f} set={set} shop={shop} saveShop={saveShop} dirty={dirty} access={access} />

          {user.role !== "admin" && <KitchenStaffCard />}
          <BillSafetyCard />

          <section className="card stack">
            <h2>Appearance</h2>
            <div className="field">
              Theme (this device)
              <Seg value={theme} onChange={setTheme} options={[["light", "☀️ Light"], ["dark", "🌙 Dark"], ["auto", "📱 Auto"]]} />
              <span className="hint">Dark is easier on the eyes at night and saves battery on many phones. Auto follows your phone's setting.</span>
            </div>
          </section>

          <section className="card stack">
            <h2>Printer</h2>
            {isIOS() && !navigator.bluetooth && <IPhonePrintHelp />}
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
                {access.state === "paid" && `${planName(access.plan)} plan until ${fmtDate(access.endsAt)}`}
                {access.state === "expired" && "Plan ended"}
              </div>
            </div>
            <div className="btn-row">
              <Link className="btn" to="/plans">Plans &amp; payments</Link>
              <button className="btn" onClick={() => setPw(true)}>Change password</button>
              <button
                className="btn"
                onClick={() =>
                  confirm("Log out on every other phone and computer? This one stays logged in.") &&
                  run(async () => {
                    await post("/auth/logout-others");
                    toast("Logged out on all other devices");
                  })
                }
              >
                Log out other devices
              </button>
              <button className="btn btn-danger" onClick={() => confirm("Log out of this device?") && logout()}>Log out</button>
            </div>
            <div className="small muted">
              App version {__APP_VERSION__} ·{" "}
              <button className="link-btn" onClick={() => checkForUpdate(toast)}>Check for update</button>
            </div>
          </section>
        </div>
      </div>

      {diag && <Diagnostics slowMode={f.printer.slowMode} onClose={() => setDiag(false)} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

// Asks for the newest version of the app; if there is one, the page reloads with it.
async function checkForUpdate(toast) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    if (reg?.installing || reg?.waiting) {
      toast("Updating to the new version…");
      setTimeout(() => window.location.reload(), 1500);
    } else toast("You have the latest version.");
  } catch {
    toast("Couldn't check right now. Check the internet and try again.");
  }
}

// Tables for table orders, the customer QR codes, and KOT printing on this device.
function TablesCard({ f, set, shop, saveShop, dirty, access }) {
  const toast = useToast();
  const [kotAuto, setKotAuto] = usePref("kotAuto", true);
  const [kotCopies, setKotCopies] = usePref("kotCopies", 1);
  const { busy, error, run } = useAction();
  const tables = f.tables;
  const nextId = () => `T${Math.max(0, ...tables.map((t) => Number(String(t.id).replace(/\D/g, "")) || 0)) + 1}`;
  const setCount = (n) => {
    n = Math.max(0, Math.min(100, Math.floor(Number(n) || 0)));
    const next = tables.slice(0, n);
    while (next.length < n) {
      const id = `T${Math.max(0, ...next.map((t) => Number(String(t.id).replace(/\D/g, "")) || 0)) + 1}`;
      next.push({ id, name: `Table ${id.slice(1)}` });
    }
    set("tables", next);
  };
  const rename = (i, name) => set("tables", tables.map((t, j) => (j === i ? { ...t, name } : t)));
  const remove = (i) => set("tables", tables.filter((_, j) => j !== i));
  const paid = access.state === "paid" || access.state === "admin";
  const saved = (shop.tables || []).length > 0;

  return (
    <section className="card stack" id="tables">
      <h2>Tables &amp; QR ordering</h2>
      <p className="small muted" style={{ margin: 0 }}>Take orders by table, print KOTs for the kitchen, and bill each table at the end. Works offline too.</p>
      <div className="grid2">
        <Field label="Number of tables">
          <input type="number" min="0" max="100" inputMode="numeric" value={tables.length} onChange={(e) => setCount(e.target.value)} />
        </Field>
      </div>
      {tables.length > 0 && (
        <div className="table-names">
          {tables.map((t, i) => (
            <div key={t.id} className="table-name">
              <input className="input" maxLength={30} value={t.name} onChange={(e) => rename(i, e.target.value)} aria-label={`Name of ${t.id}`} />
              <button className="btn btn-sm btn-ghost" onClick={() => remove(i)} aria-label={`Remove ${t.name}`}>✕</button>
            </div>
          ))}
          <button className="btn btn-sm" onClick={() => set("tables", [...tables, { id: nextId(), name: `Table ${nextId().slice(1)}` }])}>+ Add table</button>
        </div>
      )}
      {tables.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={f.qrOrdering} onChange={(e) => set("qrOrdering", e.target.checked)} />
          Let customers order by scanning the table QR code {!paid && <span className="tag warn">paid plan</span>}
        </label>
      )}
      {tables.length > 0 && f.qrOrdering && (
        <div className="field">
          When do customers pay?
          <Seg value={f.qrPayment} onChange={(v) => set("qrPayment", v)} options={[["end", "At the end"], ["choose", "Customer chooses"], ["first", "Pay first, then cook"]]} />
          <span className="hint">
            {f.qrPayment === "end"
              ? "They ask for the bill after eating and pay by UPI or at the counter."
              : f.qrPayment === "choose"
                ? "After ordering they can pay that order by UPI right away, or pay at the end. Food goes to the kitchen either way."
                : "Orders wait until the payment is confirmed by staff (UPI or cash at the counter); only then they go to the kitchen."}
            {f.qrPayment !== "end" && !f.upiId && " Add your shop UPI ID (Bill QR) so customers can pay from their phone; otherwise they pay at the counter."}
            {f.qrPayment !== "end" && " Staff confirm each UPI payment after seeing it in the UPI app or soundbox."}
          </span>
        </div>
      )}
      {dirty && <p className="hint" style={{ margin: 0 }}>Tap “Save settings” at the top to save your tables.</p>}

      {saved && f.qrOrdering && !dirty && (
        <div className="stack">
          {!paid && <div className="banner warn" style={{ borderRadius: 8 }}>Customers can order once you're on a paid plan. You can set up and print the QR codes now.</div>}
          {shop.orderToken ? (
            <>
              <div className="btn-row">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => downloadTableQrs(shop, shop.tables))}>⬇️ Download table QR codes (PDF)</button>
                <a className="btn btn-sm" href={orderUrl(shop, shop.tables[0].id)} target="_blank" rel="noopener noreferrer">👀 See customer page</a>
              </div>
              <div className="order-link">
                <code>{orderUrl(shop, shop.tables[0].id)}</code>
              </div>
              <button
                className="link-btn"
                style={{ justifySelf: "start" }}
                onClick={() =>
                  confirm("Make new QR codes? The old printed QR codes will stop working, so you'll need to print and stick the new ones.") &&
                  run(async () => {
                    const updated = await post("/shop/order-token");
                    await saveShop({});
                    toast("New QR link made. Download and print the new QR codes.");
                    return updated;
                  })
                }
              >
                Make new QR codes (stop the old ones)
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(async () => (await post("/shop/order-token"), await saveShop({})))}>
              Create table QR codes
            </button>
          )}
        </div>
      )}

      {saved && (
        <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <b className="small">Kitchen tickets (KOT) on this device</b>
          <label className="check">
            <input type="checkbox" checked={kotAuto} onChange={(e) => setKotAuto(e.target.checked)} />
            Print a KOT when an order is accepted or taken on this device
          </label>
          <div className="field">
            Copies
            <Seg value={String(kotCopies)} onChange={(v) => setKotCopies(Number(v))} options={[["1", "1"], ["2", "2"], ["3", "3"]]} />
          </div>
          <span className="hint">KOTs print on the printer set below. Bluetooth and USB printers work without internet.</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

// Payment QR printed on bills: from the UPI ID (exact bill amount) or an uploaded QR picture.
function QrSettings({ f, set, toast }) {
  const onPick = async (file) => {
    if (!file) return;
    try {
      set("qrImage", await resizeQr(file));
    } catch {
      toast("Couldn't read that image. Try a PNG or JPEG.");
    }
  };
  const sample = billQr({ ...f, upiId: f.upiId }, { billNo: "A-1", total: 100, paymentMode: "cash" });
  return (
    <section className="card stack">
      <h2>Payment QR on bills</h2>
      <Field label="Shop UPI ID" hint="Used for the bill QR and in udhar reminders so customers can pay you directly.">
        <input maxLength={60} placeholder="e.g. grillhive@okaxis" value={f.upiId} onChange={(e) => set("upiId", e.target.value.trim())} />
      </Field>
      <Seg
        value={f.qrMode}
        onChange={(v) => set("qrMode", v)}
        options={[["off", "No QR"], ["upi", "From UPI ID"], ["image", "My QR picture"]]}
      />
      {f.qrMode === "upi" && (
        <p className="hint" style={{ margin: 0 }}>
          {f.upiId
            ? "Each bill gets its own QR with the exact bill amount filled in. Customers just scan and pay."
            : "Add your UPI ID above first."}
        </p>
      )}
      {f.qrMode === "image" && (
        <div className="btn-row">
          <label className="btn btn-sm">
            {f.qrImage ? "Change QR picture" : "Upload QR picture"}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onPick(e.target.files[0])} />
          </label>
          {f.qrImage && <button className="btn btn-sm btn-ghost" onClick={() => set("qrImage", "")}>Remove</button>}
          <span className="hint" style={{ width: "100%" }}>A clear screenshot or photo of your PhonePe / Paytm / bank QR. Crop it to just the QR for the best print.</span>
        </div>
      )}
      {f.qrMode !== "off" && (
        <>
          <Field label="Print the QR on">
            <Seg value={f.qrOn} onChange={(v) => set("qrOn", v)} options={[["all", "Every bill"], ["credit", "Only udhar bills"]]} />
          </Field>
          {sample && (
            <div className="qr-preview">
              <div className="small"><b>Scan & pay ₹100.00</b> (sample)</div>
              {sample.kind === "upi" ? <div dangerouslySetInnerHTML={{ __html: qrSvg(sample.payload, 150) }} /> : <img src={sample.image} alt="Your QR" />}
            </div>
          )}
          <p className="hint" style={{ margin: 0 }}>Print a test bill after saving to check your printer reads it well. A QR makes printing a little slower.</p>
        </>
      )}
    </section>
  );
}

// iPhone browsers can't reach Bluetooth printers; Bluefy (a free BLE-enabled browser) can.
function IPhonePrintHelp() {
  const toast = useToast();
  const link = window.location.origin;
  return (
    <div className="ios-help">
      <b>Printing from iPhone</b>
      <p className="small" style={{ margin: "4px 0 8px" }}>
        Apple doesn't let Safari or Chrome on iPhone connect to Bluetooth printers. Use the free <b>Bluefy</b> browser instead:
      </p>
      <ol className="small" style={{ margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.6 }}>
        <li>Install <b>Bluefy – Web BLE Browser</b> from the App Store.</li>
        <li>Copy this app's link and open it in Bluefy, then log in.</li>
        <li>Tap <b>Connect</b> above Print bill and pick your printer.</li>
      </ol>
      <div className="btn-row">
        <a className="btn btn-sm btn-primary" href={BLUEFY_URL} target="_blank" rel="noopener noreferrer">Get Bluefy</a>
        <button
          className="btn btn-sm"
          onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Link copied. Paste it in Bluefy."), () => toast(link))}
        >
          Copy app link
        </button>
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>Until then, use <b>PDF</b> on the bill to share it on WhatsApp.</p>
    </div>
  );
}

// Bill safety: an owner PIN for editing, deleting and restoring bills (set or removed with the password).
function BillSafetyCard() {
  const { shop, saveShop } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(null); // "set" | "off"
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await put("/shop/bill-pin", { password, pin: open === "off" ? null : pin });
      await saveShop({});
      toast(open === "off" ? "Owner PIN turned off" : "Owner PIN saved");
      setOpen(null);
      setPin("");
      setPassword("");
    });
  };
  return (
    <section className="card stack">
      <h2>Bill safety</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Every edited or deleted bill is recorded with who did it and why, and you see it in Alerts, on the Dashboard and in the morning email.
        Turn on an <b>owner PIN</b> so staff using this login can't edit, delete or restore bills without you. Bills more than a week old always need it.
      </p>
      <div className="small">{shop.billPin ? <span className="tag good">Owner PIN is on</span> : <span className="tag">Owner PIN is off</span>}</div>
      {!open ? (
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => setOpen("set")}>{shop.billPin ? "Change PIN" : "Set owner PIN"}</button>
          {shop.billPin && <button className="btn btn-sm btn-ghost" onClick={() => setOpen("off")}>Turn off</button>}
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {open === "set" && (
            <Field label="New 4-digit owner PIN" hint="Don't share it with staff.">
              <input className="pin-input" type="password" inputMode="numeric" autoComplete="off" required pattern="\d{4}" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}
          <Field label="Your account password (to confirm)">
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <div className="error">{error}</div>}
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => setOpen(null)}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={busy}>{open === "off" ? "Turn off PIN" : "Save PIN"}</button>
          </div>
        </form>
      )}
    </section>
  );
}

// Staff, kitchen stock, and turning a phone into a kitchen-only phone.
function KitchenStaffCard() {
  const { completeLogin } = useApp();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  return (
    <section className="card stack">
      <h2>Kitchen &amp; staff</h2>
      <div className="btn-row">
        <Link className="btn btn-sm" to="/staff">👥 Staff, attendance &amp; salary</Link>
        <Link className="btn btn-sm" to="/kitchen-manage">🥫 Kitchen stock &amp; recipes</Link>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Make this phone a <b>kitchen phone</b>: cooks see only the order board, kitchen stock, recipes and alerts, never sales, bills or money. Each cook signs in with their PIN.
      </p>
      {!open ? (
        <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setOpen(true)}>🍳 Make this a kitchen phone</button>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => completeLogin(await post("/auth/kitchen-mode", { password })));
          }}
        >
          <Field label="Your password (to confirm)" hint="To leave kitchen mode later, you'll log in again with your email and password.">
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <div className="error">{error}</div>}
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={busy}>Switch to kitchen phone</button>
          </div>
        </form>
      )}
    </section>
  );
}

function PasswordModal({ onClose }) {
  const toast = useToast();
  const { user } = useApp();
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
            await post("/auth/password", user.canSetPassword ? { password } : { current, password });
            toast("Password changed. Other devices are logged out.");
            onClose();
          });
        }}
      >
        {!user.canSetPassword && <Field label="Current password"><input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>}
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
