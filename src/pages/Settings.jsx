import { useEffect, useReducer, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp, accessState } from "../lib/store.jsx";
import { del, get, post, put } from "../lib/api.js";
import { fmtDate, money } from "../lib/format.js";
import { promoSummary, DAY_NAMES, cleanCode, tablesText, timeText } from "../../shared/promo.js";
import { groupPrice, deliveryText, deliveryRule, MAX_GROUPS } from "../../shared/tableGroups.js";
import { storeOpen, hoursText, DEFAULT_CLOSED_MESSAGE, closureActive, istDay } from "../../shared/hours.js";
import { HELP_ASKS, QUICK_ASKS, HELP_PRESETS, helpSettings } from "../../shared/tableHelp.js";
import { Field, Modal, Seg, useAction, useToast } from "../components/ui.jsx";
import { PAPER } from "../printer/receipt.js";
import { printTest, warmLogo } from "../printer/index.js";
import { prepareLogo, prepareQrImage } from "../printer/escpos.js";
import { resizeLogo, resizeQr } from "../lib/image.js";
import { billQr, qrSvg } from "../../shared/billQr.js";
import { planName } from "../../shared/plans.js";
import { useShowPictures } from "../lib/prefs.js";
import { useTheme } from "../lib/theme.js";
import { TableRangePicker, tableRuns } from "../components/TableRangePicker.jsx";
import { usePref } from "../lib/prefs.js";
import { matchSetting } from "../lib/settingsSearch.js";
import { downloadTableQrs, orderUrl, parseTableNumbers } from "../lib/tableQr.js";
import { LANGUAGE_OPTIONS, DEFAULT_LANGUAGE, DEFAULT_TEMPLATE, reminderText } from "../../shared/messages.js";
import {
  printer, bleConnect, bleWrite, shortUuid, saveChannel, savedChannelFor, onPrinterChange, explainPrintError, isIOS, BLUEFY_URL,
} from "../printer/transports.js";

const pick = (s) => ({
  tables: (s.tables || []).map((t) => ({ ...t })),
  qrOrdering: !!s.qrOrdering,
  qrPayment: s.qrPayment || "end",
  payLater: s.payLater || "unblocked",
  help: helpSettings(s),
  payFail: s.payFail || "later",
  blockAfter: s.blockAfter ?? 0,
  hours: { enabled: false, open: "10:00", close: "21:00", closedDays: [], message: "", ...(s.hours || {}) },
  askCustomer: s.askCustomer || "optional",
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

// The settings list (like Instagram): grouped rows with a search; tapping one opens only that setting.
// form: the card edits the shared settings form, saved with the Save bar.
const SECTIONS = [
  { id: "shop", group: "Your shop", icon: "🏪", title: "Shop profile", desc: "Logo, name, address, phone, GSTIN", keywords: ["logo", "gst", "gstin", "address", "phone", "footer", "bill footer", "name"], form: true, render: (p) => <ShopCard {...p} /> },
  { id: "hours", group: "Your shop", icon: "🕒", title: "Opening hours", desc: "When customers can order by QR", keywords: ["open", "close", "closed", "holiday", "time", "timing"], form: true, hint: ({ shop }) => (shop.hours?.enabled ? hoursText(shop.hours) : "Always open"), render: (p) => <HoursCard {...p} /> },
  { id: "account", group: "Your shop", icon: "👤", title: "Account & plan", desc: "Plan, password, log out other devices", keywords: ["password", "subscription", "plan", "payment", "logout", "log out", "devices", "email", "update", "version"], hint: ({ access }) => (access.state === "trial" ? `Trial until ${fmtDate(access.endsAt)}` : access.state === "paid" ? `Plan until ${fmtDate(access.endsAt)}` : access.state === "expired" ? "Plan ended" : ""), render: (p) => <AccountCard {...p} /> },

  { id: "bill", group: "Billing", icon: "🧾", title: "Bill defaults", desc: "GST, discount, customer details", keywords: ["gst", "tax", "discount", "currency", "customer", "name", "phone", "rupee"], form: true, render: (p) => <BillDefaultsCard {...p} /> },
  { id: "printer", group: "Billing", icon: "🖨️", title: "Printer", desc: "Paper size, Bluetooth, test print", keywords: ["print", "paper", "58mm", "80mm", "bluetooth", "rawbt", "logo", "cut", "test print", "diagnose", "kot"], form: true, hint: ({ shop }) => `${shop.printer?.paperSize || 58} mm`, render: (p) => <PrinterCard {...p} /> },
  { id: "payqr", group: "Billing", icon: "💳", title: "Payment QR on bills", desc: "UPI QR printed on the bill", keywords: ["upi", "qr", "gpay", "phonepe", "paytm", "payment"], form: true, render: (p) => <QrSettings {...p} /> },
  { id: "safety", group: "Billing", icon: "🔒", title: "Bill safety", desc: "PIN to edit or delete bills", keywords: ["pin", "delete", "edit", "lock", "security"], render: () => <BillSafetyCard /> },
  { id: "udhar", group: "Billing", icon: "📒", title: "Udhar reminders", desc: "WhatsApp reminder language and message", keywords: ["whatsapp", "credit", "reminder", "language", "hindi", "message", "due"], form: true, render: (p) => <UdharCard {...p} /> },

  { id: "tables", group: "QR ordering", icon: "🪑", title: "Tables & QR codes", desc: "Tables, QR ordering, download QR cards", keywords: ["table", "qr", "scan", "lens", "pdf", "download", "pay first", "order"], form: true, hint: ({ shop }) => `${(shop.tables || []).length} tables · QR ordering ${shop.qrOrdering ? "on" : "off"}`, render: (p) => <TablesCard {...p} /> },
  { id: "groups", group: "QR ordering", icon: "🗺️", title: "Table groups", desc: "Own prices and delivery for some tables", keywords: ["delivery", "far", "price", "group", "charge"], show: ({ shop }) => (shop.tables || []).length > 0, render: () => <TableGroupsCard /> },
  { id: "online", group: "QR ordering", icon: "💰", title: "Online payments", desc: "Cashfree, pay later rules", keywords: ["cashfree", "gateway", "upi", "online", "pay later", "unpaid", "card"], form: true, hint: ({ shop }) => (shop.gateway?.name ? "Connected" : ""), render: (p) => <OnlinePaymentsCard {...p} /> },
  { id: "help", group: "QR ordering", icon: "🙋", title: "Customer help", desc: "Water, call waiter and other help buttons", keywords: ["help", "water", "waiter", "bell", "call", "napkin"], form: true, render: (p) => <CustomerHelpCard {...p} /> },
  { id: "promos", group: "QR ordering", icon: "🏷️", title: "Promo codes", desc: "Coupons and offers", keywords: ["coupon", "offer", "discount", "code", "promo"], render: () => <PromosCard /> },

  { id: "menu", group: "Menu & team", icon: "🍽️", title: "Menu & pictures", desc: "Edit dishes, pictures on billing", keywords: ["menu", "dish", "item", "photo", "picture", "price"], render: (p) => <MenuCard {...p} /> },
  { id: "staff", group: "Menu & team", icon: "👨‍🍳", title: "Kitchen & staff", desc: "Kitchen and staff logins", keywords: ["kitchen", "staff", "login", "waiter", "manager", "device"], show: ({ user }) => user.role !== "admin", render: () => <KitchenStaffCard /> },

  { id: "appearance", group: "This phone", icon: "🌙", title: "Appearance", desc: "Light, dark or auto", keywords: ["dark", "light", "theme", "night", "mode"], render: (p) => <AppearanceCard {...p} /> },
];
const OLD_HASH = { tables: "tables", hours: "hours", "online-payments": "online", "customer-help": "help", promos: "promos", "table-groups": "groups" };

export default function Settings() {
  const { shop, user, saveShop, logout } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const { section: openId } = useParams();
  const [f, setF] = useState(() => pick(shop));
  const [q, setQ] = useState("");
  const [diag, setDiag] = useState(false);
  const [pw, setPw] = useState(false);
  const wide = useWide();
  // Old links like /settings#tables open that setting.
  useEffect(() => {
    const id = OLD_HASH[window.location.hash.slice(1)];
    if (id) nav(`/settings/${id}`, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useAction();
  const access = accessState(shop);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(shop));

  const save = () =>
    run(async () => {
      const saved = await saveShop({ ...f, gstPercent: Number(f.gstPercent) || 0, defaultDiscount: { ...f.defaultDiscount, value: Number(f.defaultDiscount.value) || 0 } });
      warmLogo(saved);
      toast("Settings saved");
    });

  const ctx = { shop, user, f, access };
  const visible = SECTIONS.filter((s) => !s.show || s.show(ctx));
  // Wide screens show the first setting beside the list.
  const open = visible.find((s) => s.id === openId) || (wide ? visible[0] : null);
  const props = { f, set, setF, shop, saveShop, dirty, access, toast, user, run, logout, onDiag: () => setDiag(true), onPassword: () => setPw(true) };

  const saveBar = dirty && (
    <div className="set-savebar">
      <span>Unsaved changes</span>
      <button className="btn" onClick={() => setF(pick(shop))}>Undo</button>
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button>
    </div>
  );

  const list = (
    <SettingsList
      sections={visible}
      ctx={ctx}
      q={q}
      setQ={setQ}
      openId={open?.id}
      onOpen={(id) => nav(`/settings/${id}`, { replace: wide && !!openId })}
      onLogout={() => confirm("Log out of this device?") && logout()}
      toast={toast}
    />
  );

  return (
    <div className={"page settings-page" + (open ? " has-open" : "")}>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="set-layout">
        {(wide || !open) && <div className="set-side">{list}</div>}
        {open && (
          <div className="set-main">
            <div className="set-head">
              {!wide && <button className="co-back" onClick={() => nav("/settings")} aria-label="Back to settings">←</button>}
              <h1>{open.icon} {open.title}</h1>
            </div>
            <div className="set-body">{open.render(props)}</div>
          </div>
        )}
      </div>
      {saveBar}

      {diag && <Diagnostics slowMode={f.printer.slowMode} onClose={() => setDiag(false)} />}
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function useWide() {
  const query = "(min-width: 900px)";
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

function SettingsList({ sections, ctx, q, setQ, openId, onOpen, onLogout, toast }) {
  const found = sections.filter((s) => matchSetting(s, q));
  const groups = q.trim() ? [["", found]] : [...new Set(sections.map((s) => s.group))].map((g) => [g, sections.filter((s) => s.group === g)]);
  return (
    <div className="set-list">
      <h1 className="set-title">Settings</h1>
      <div className="set-search">
        <input className="input" type="search" placeholder="🔍 Search settings (GST, printer, tables…)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {q.trim() && !found.length && <div className="empty">No setting found for “{q.trim()}”.</div>}
      {groups.map(([g, rows]) => (
        <div key={g || "found"} className="set-group">
          {g && <h3>{g}</h3>}
          <div className="set-rows">
            {rows.map((s) => {
              const hint = s.hint?.(ctx);
              return (
                <button key={s.id} className={"set-row" + (s.id === openId ? " on" : "")} onClick={() => onOpen(s.id)}>
                  <span className="set-ico">{s.icon}</span>
                  <span className="set-text">
                    <b>{s.title}</b>
                    <small>{hint || s.desc}</small>
                  </span>
                  <span className="set-chev">›</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!q.trim() && (
        <div className="set-group">
          <div className="set-rows">
            <button className="set-row danger" onClick={onLogout}>
              <span className="set-ico">🚪</span>
              <span className="set-text"><b>Log out</b></span>
            </button>
          </div>
          <p className="small muted set-version">
            App version {__APP_VERSION__} · <button className="link-btn" onClick={() => checkForUpdate(toast)}>Check for update</button>
          </p>
        </div>
      )}
    </div>
  );
}

function ShopCard({ f, set, toast }) {
  const onLogo = async (file) => {
    if (!file) return;
    try {
      set("logo", await resizeLogo(file));
    } catch {
      toast("Couldn't read that image. Try a PNG or JPEG.");
    }
  };
  return (
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
  );
}

function BillDefaultsCard({ f, set }) {
  return (
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
      <div className="field">
        Ask for customer name and phone
        <Seg value={f.askCustomer} onChange={(v) => set("askCustomer", v)} options={[["optional", "Optional"], ["required", "Required"], ["off", "Off"]]} />
        <span className="hint">
          {f.askCustomer === "required"
            ? "A bill can't be saved or printed without the customer. Builds a complete customer list."
            : f.askCustomer === "off"
              ? "Only asked for udhar bills."
              : "The customer box is on every bill; skip it when busy. Name and phone print on the bill and go to your customer list."}
        </span>
      </div>
    </section>
  );
}

function UdharCard({ f, set, shop }) {
  return (
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
  );
}

function MenuCard() {
  const [showPictures, setShowPictures] = useShowPictures();
  return (
    <section className="card stack">
      <h2>Menu</h2>
      <p className="muted small" style={{ margin: 0 }}>Add, edit or hide items, set Half/Full prices, add photos, add-ons and which tables can order a dish.</p>
      <Link className="btn" to="/menu">Edit menu</Link>
      <label className="check">
        <input type="checkbox" checked={showPictures} onChange={(e) => setShowPictures(e.target.checked)} />
        Show pictures on the billing screen (this device)
      </label>
    </section>
  );
}

function AppearanceCard() {
  const [theme, setTheme] = useTheme();
  return (
    <section className="card stack">
      <h2>Appearance</h2>
      <div className="field">
        Theme (this device)
        <Seg value={theme} onChange={setTheme} options={[["light", "☀️ Light"], ["dark", "🌙 Dark"], ["auto", "📱 Auto"]]} />
        <span className="hint">Dark is easier on the eyes at night and saves battery on many phones. Auto follows your phone's setting.</span>
      </div>
    </section>
  );
}

function PrinterCard({ f, setF, shop, onDiag, toast }) {
  const setP = (k, v) => setF((x) => ({ ...x, printer: { ...x.printer, [k]: v } }));
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
        <button className="btn" onClick={onDiag}>Diagnose printer</button>
      </div>
    </section>
  );
}

function AccountCard({ user, access, run, toast, logout, onPassword }) {
  return (
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
        <button className="btn" onClick={onPassword}>Change password</button>
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

// The customer QR page's Help: on/off, which one-tap buttons, and written questions
// (a library doesn't want "Water please").
function CustomerHelpCard({ f, set, dirty }) {
  const h = f.help;
  const put = (patch) => set("help", { ...h, ...patch });
  const toggle = (k) => put({ asks: h.asks.includes(k) ? h.asks.filter((x) => x !== k) : QUICK_ASKS.filter((x) => x === k || h.asks.includes(x)) });
  const same = (a) => a.enabled === h.enabled && a.questions === h.questions && a.asks.join() === h.asks.join();
  const shows = [...h.asks.map((k) => HELP_ASKS[k][1]), ...(h.questions ? ["written questions"] : [])];
  return (
    <section className="card stack" id="customer-help">
      <h2>Customer help</h2>
      <p className="small muted" style={{ margin: 0 }}>
        The 💬 Help tab on the QR page, where customers ask your staff for things. Requests ring on the Orders screen. Choose what fits your place.
      </p>
      <label className="check">
        <input type="checkbox" checked={h.enabled} onChange={(e) => put({ enabled: e.target.checked })} />
        Show Help on the QR page
      </label>
      {h.enabled && (
        <>
          <div className="field">
            Ready-made
            <div className="btn-row">
              {Object.entries(HELP_PRESETS).map(([k, p]) => (
                <button key={k} type="button" className={"chip" + (same(p.help) ? " on" : "")} onClick={() => set("help", { ...p.help, asks: [...p.help.asks] })}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="field">
            One-tap buttons
            <div className="day-chips">
              {QUICK_ASKS.map((k) => (
                <button key={k} type="button" className={"chip" + (h.asks.includes(k) ? " on" : "")} aria-pressed={h.asks.includes(k)} onClick={() => toggle(k)}>
                  {HELP_ASKS[k][0]} {HELP_ASKS[k][1]}
                </button>
              ))}
            </div>
            <span className="hint">“Call staff” suits a library, shop or office; “Call a waiter”, water and the bill suit restaurants.</span>
          </div>
          <label className="check">
            <input type="checkbox" checked={h.questions} onChange={(e) => put({ questions: e.target.checked })} />
            Let customers write a question to the staff
          </label>
          <div className="small">
            {shows.length ? <>Customers see: <b>{shows.join(" · ")}</b></> : <span className="error">Nothing to ask with: add a button or allow questions, or turn Help off.</span>}
          </div>
        </>
      )}
      {!h.enabled && <div className="small muted">The Help tab is hidden. Customers can still order, pay and see their bill.</div>}
      {dirty && <p className="hint" style={{ margin: 0 }}>Tap “Save changes” at the bottom to save.</p>}
    </section>
  );
}

// The shop's own Cashfree account for online payments, and the pay-later rules.
function OnlinePaymentsCard({ f, set, shop, saveShop, dirty }) {
  const toast = useToast();
  const { busy, error, run } = useAction();
  const [form, setForm] = useState(null); // { appId, secret, mode } while connecting
  const g = shop.gateway;
  const connect = (e) => {
    e.preventDefault();
    run(async () => {
      await put("/shop/gateway", { appId: form.appId.trim(), secret: form.secret.trim(), mode: form.mode });
      await saveShop({});
      setForm(null);
      toast("Cashfree connected");
    });
  };
  const disconnect = () =>
    confirm("Disconnect Cashfree? Customers will pay by UPI or at the counter again, and staff confirm payments by hand.") &&
    run(async () => {
      await put("/shop/gateway", { disconnect: true });
      await saveShop({});
      toast("Cashfree disconnected");
    });
  return (
    <section className="card stack" id="online-payments">
      <h2>Online payments</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Connect your own <b>Cashfree</b> account and customers pay QR orders online (UPI, cards, netbanking, wallets). Paid orders are confirmed by themselves, with no staff step, and
        the money goes straight to your Cashfree account. Cashfree charges its own fee (about 2%); this app takes nothing.
      </p>
      {g ? (
        <div className="shop-state open">
          <b>✅ Cashfree connected · {g.mode === "live" ? "Live" : "Test mode"}</b>
          <span className="small muted">App ID …{g.appIdEnd}{g.connectedAt ? ` · since ${fmtDate(g.connectedAt)}` : ""}</span>
          {g.mode !== "live" && <span className="small">Test mode: no real money moves. Switch to your Production keys when you're ready.</span>}
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setForm({ appId: "", secret: "", mode: g.mode })}>Change keys</button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={disconnect}>Disconnect</button>
          </div>
        </div>
      ) : (
        !form && <button className="btn btn-primary" style={{ justifySelf: "start" }} onClick={() => setForm({ appId: "", secret: "", mode: "test" })}>Connect Cashfree</button>
      )}
      {form && (
        <form className="stack" onSubmit={connect} autoComplete="off">
          <div className="small muted">
            In the Cashfree dashboard open <b>Developers › API Keys</b> (Payment Gateway) and copy the App ID and Secret key. Start with <b>Test</b> keys to try it safely.
          </div>
          <div className="field">
            Keys for
            <Seg value={form.mode} onChange={(v) => setForm({ ...form, mode: v })} options={[["test", "Test (sandbox)"], ["live", "Live (real money)"]]} />
          </div>
          <Field label="App ID (Client ID)">
            <input required autoComplete="off" spellCheck={false} value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} />
          </Field>
          <Field label="Secret key" hint="Saved encrypted. It's never shown again, even to you.">
            <input required type="password" autoComplete="new-password" spellCheck={false} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
          </Field>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy}>{busy ? "Checking with Cashfree…" : "Check & connect"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}

      <div className="field">
        Who can pay later (at the table or counter)?
        <Seg value={f.payLater} onChange={(v) => set("payLater", v)} options={[["all", "Everyone"], ["unblocked", "All except blocked"], ["none", "No one"]]} />
        <span className="hint">
          {f.payLater === "none"
            ? "Every QR order is paid before it's cooked (online, or at the counter first)."
            : f.payLater === "unblocked"
              ? "Customers you block (Udhar › customer, or after “Left without paying”) must pay before their food is cooked."
              : "Anyone can pay after eating."}
        </span>
      </div>
      {g && (
        <div className="field">
          If an online payment fails
          <Seg value={f.payFail} onChange={(v) => set("payFail", v)} options={[["later", "Let them pay later"], ["cancel", "Must pay online"]]} />
          <span className="hint">
            {f.payFail === "later"
              ? "They can try again, or pay at the end (if they're allowed to pay later)."
              : "They can only try again. Orders that must be paid first are cancelled if still unpaid after 15 minutes."}
          </span>
        </div>
      )}
      <Field label="Block a customer from paying later after" hint="Counted when staff tap “Left without paying” on a table.">
        <select value={f.blockAfter} onChange={(e) => set("blockAfter", Number(e.target.value))}>
          <option value={0}>Never by itself (I'll decide)</option>
          <option value={1}>1 time left without paying</option>
          <option value={2}>2 times</option>
          <option value={3}>3 times</option>
        </select>
      </Field>
      {dirty && <p className="hint" style={{ margin: 0 }}>Tap “Save changes” at the bottom to save these rules.</p>}
    </section>
  );
}

// Opening hours and closing the shop for a day (both are about QR table orders; billing always works).
function HoursCard({ f, set, shop, saveShop, dirty }) {
  const toast = useToast();
  const { busy, error, run } = useAction();
  const [closing, setClosing] = useState(null); // null | "days"
  const [until, setUntil] = useState(istDay());
  const [message, setMessage] = useState("");
  const closed = closureActive(shop.closure);
  const state = storeOpen(shop.hours, new Date(), shop.closure);
  const close = (u) =>
    run(async () => {
      await put("/shop/closure", { until: u, message });
      await saveShop({});
      setClosing(null);
      toast(u ? "Shop closed for QR orders" : "Shop open again");
    });
  const untilText = shop.closure?.until === "manual" ? "until you open it" : shop.closure?.until === istDay() ? "for today" : `till ${fmtDate(shop.closure?.until)}`;
  return (
    <section className="card stack" id="hours">
      <h2>Opening hours</h2>
      <div className={"shop-state " + (state.open ? "open" : "closed")}>
        <b>{state.open ? "🟢 Open for QR orders" : closed ? `🔴 Shop closed ${untilText}` : "🌙 Closed now (outside opening hours)"}</b>
        {!state.open && <span className="small">Customers see: “{state.message}”</span>}
        {!shop.qrOrdering && <span className="small muted">QR ordering is off. Turn it on in Tables &amp; QR ordering for customers to order from tables.</span>}
      </div>

      {closed ? (
        <button className="btn btn-primary" disabled={busy} onClick={() => close(null)}>🟢 Open the shop now</button>
      ) : (
        <div className="stack">
          <div className="small muted">Closed today or for a holiday? Close the shop and customers can't order from the table QR. Billing at the counter still works.</div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => close("today")}>🔴 Close for today</button>
            <button className="btn" disabled={busy} onClick={() => setClosing(closing ? null : "days")}>📅 Close for some days</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => close("manual")}>Close until I open it</button>
          </div>
          {closing === "days" && (
            <div className="inline range-add">
              <span>Closed till (last closed day)</span>
              <input type="date" min={istDay()} value={until} onChange={(e) => setUntil(e.target.value)} />
              <button className="btn btn-sm btn-primary" disabled={busy || !until} onClick={() => close(until)}>Close</button>
            </div>
          )}
          <Field label="Message for customers while closed" hint="Optional. {open} becomes when you're back (tomorrow, a date, or soon).">
            <textarea rows={2} maxLength={200} placeholder="We're closed today 🙏 See you tomorrow!" value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <HoursField hours={f.hours} onChange={(h) => set("hours", h)} />
      {dirty && <p className="hint" style={{ margin: 0 }}>Tap “Save changes” at the bottom to save the hours.</p>}
    </section>
  );
}

// QR orders only during opening hours; a friendly note for customers otherwise.
function HoursField({ hours: h, onChange }) {
  const set = (k, v) => onChange({ ...h, [k]: v });
  const now = storeOpen(h);
  // Exactly what a customer sees now, or (while open) with the usual opening time.
  const preview = now.message || (h.message.trim() || DEFAULT_CLOSED_MESSAGE).replaceAll("{open}", timeText(h.open)).replaceAll("{close}", timeText(h.close));
  return (
    <div className="field hours-field">
      <label className="check">
        <input type="checkbox" checked={h.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Take QR orders only during opening hours
      </label>
      {h.enabled && (
        <>
          <div className="grid2">
            <Field label="Opens at">
              <input type="time" required value={h.open} onChange={(e) => set("open", e.target.value)} />
            </Field>
            <Field label="Closes at" hint={h.close < h.open ? "Closes after midnight" : undefined}>
              <input type="time" required value={h.close} onChange={(e) => set("close", e.target.value)} />
            </Field>
          </div>
          <div className="field">
            Weekly off <span className="hint">Days with no QR orders</span>
            <div className="day-chips">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button type="button" key={d} className={"chip" + (h.closedDays.includes(d) ? " on" : "")} aria-pressed={h.closedDays.includes(d)}
                  onClick={() => set("closedDays", h.closedDays.includes(d) ? h.closedDays.filter((x) => x !== d) : [...h.closedDays, d].slice(0, 6))}>
                  {DAY_NAMES[d]}
                </button>
              ))}
            </div>
          </div>
          <Field label="Message when closed" hint="Optional. {open} becomes the next opening time.">
            <textarea rows={2} maxLength={200} placeholder={DEFAULT_CLOSED_MESSAGE} value={h.message} onChange={(e) => set("message", e.target.value)} />
          </Field>
          <div className="small">
            Customers will see: <i>“{preview}”</i>
          </div>
          <div className="small muted">
            {hoursText(h)} · right now QR ordering is <b>{now.open ? "open" : "closed"}</b>. Staff billing and the menu always work.
          </div>
        </>
      )}
    </div>
  );
}

const MAX_TABLES = 1000;
const PAGE = 50;
const QR_BATCH = 60; // 10 pages of QR codes per PDF, so big shops don't freeze the phone

// Tables for table orders, the customer QR codes, and KOT printing on this device.
function TablesCard({ f, set, shop, saveShop, dirty, access }) {
  const toast = useToast();
  const [kotAuto, setKotAuto] = usePref("kotAuto", true);
  const [kotCopies, setKotCopies] = usePref("kotCopies", 1);
  const { busy, error, run } = useAction();
  const tables = f.tables;
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [range, setRange] = useState(0);
  const idNum = (t) => Number(String(t.id).replace(/\D/g, "")) || 0;
  const nextId = () => `T${tables.reduce((m, t) => Math.max(m, idNum(t)), 0) + 1}`;
  const setCount = (n) => {
    n = Math.max(0, Math.min(MAX_TABLES, Math.floor(Number(n) || 0)));
    const next = tables.slice(0, n);
    let last = next.reduce((m, t) => Math.max(m, idNum(t)), 0);
    while (next.length < n) {
      last += 1;
      next.push({ id: `T${last}`, name: `Table ${last}` });
    }
    set("tables", next);
  };
  // Many tables: search, and 50 at a time.
  const listed = tables.map((t, i) => [t, i]).filter(([t]) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.id.toLowerCase() === q.toLowerCase());
  // Which tables' QR cards to download: all, or the ones picked.
  const [qrPick, setQrPick] = usePref("qrPick", "all");
  const [picked, setPicked] = useState(() => new Set());
  const [pickQ, setPickQ] = useState("");
  const [nums, setNums] = useState("");
  const savedTables = shop.tables || [];
  const qrTables = qrPick === "all" ? savedTables : savedTables.filter((t) => picked.has(t.id));
  const qrBatches = [];
  for (let i = 0; i < qrTables.length; i += QR_BATCH) qrBatches.push([i, Math.min(i + QR_BATCH, qrTables.length)]);
  const pickShown = savedTables.filter((t) => !pickQ || t.name.toLowerCase().includes(pickQ.toLowerCase()));
  const togglePick = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
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
          <input type="number" min="0" max={MAX_TABLES} inputMode="numeric" value={tables.length} onChange={(e) => setCount(e.target.value)} />
        </Field>
        {tables.length > PAGE && (
          <Field label="Find a table">
            <input type="search" placeholder="Name or number" value={q} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} />
          </Field>
        )}
      </div>
      {tables.length > 0 && (
        <div className="table-names">
          {listed.slice(0, shown).map(([t, i]) => (
            <div key={t.id} className="table-name">
              <input className="input" maxLength={30} value={t.name} onChange={(e) => rename(i, e.target.value)} aria-label={`Name of ${t.id}`} />
              <button className="btn btn-sm btn-ghost" onClick={() => remove(i)} aria-label={`Remove ${t.name}`}>✕</button>
            </div>
          ))}
          {listed.length > shown && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShown((n) => n + PAGE)}>Show more ({listed.length - shown} left)</button>
          )}
          {!q && tables.length < MAX_TABLES && (
            <button className="btn btn-sm" onClick={() => (set("tables", [...tables, { id: nextId(), name: `Table ${nextId().slice(1)}` }]), setShown((n) => Math.max(n, tables.length + 1)))}>+ Add table</button>
          )}
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
      {dirty && <p className="hint" style={{ margin: 0 }}>Tap “Save changes” at the bottom to save your tables.</p>}

      {saved && f.qrOrdering && !dirty && (
        <div className="stack">
          {!paid && <div className="banner warn" style={{ borderRadius: 8 }}>Customers can order once you're on a paid plan. You can set up and print the QR codes now.</div>}
          {shop.orderToken ? (
            <>
              <div className="field">
                Which tables?
                <Seg value={qrPick} onChange={(v) => (setQrPick(v), setRange(0))} options={[["all", `All tables (${savedTables.length})`], ["pick", "Choose tables"]]} />
              </div>
              {qrPick === "pick" && (
                <div className="qr-pick stack">
                  <div className="grid2">
                    <input className="input" inputMode="numeric" placeholder="Numbers, e.g. 1-10, 15" value={nums} onChange={(e) => setNums(e.target.value)} onBlur={() => nums.trim() && (setPicked((prev) => new Set([...prev, ...parseTableNumbers(nums, savedTables)])), setNums(""))} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} aria-label="Table numbers" />
                    {savedTables.length > 12 && <input className="input" type="search" placeholder="Find a table" value={pickQ} onChange={(e) => setPickQ(e.target.value)} />}
                  </div>
                  <div className="chips wrap qr-pick-list">
                    {pickShown.slice(0, 200).map((t) => (
                      <button key={t.id} type="button" className={"chip" + (picked.has(t.id) ? " on" : "")} onClick={() => togglePick(t.id)}>
                        {picked.has(t.id) ? "✓ " : ""}{t.name}
                      </button>
                    ))}
                  </div>
                  <div className="btn-row small">
                    <button type="button" className="link-btn" onClick={() => setPicked((prev) => new Set([...prev, ...pickShown.map((t) => t.id)]))}>Select all shown</button>
                    <button type="button" className="link-btn" onClick={() => setPicked(new Set())}>Clear</button>
                    <span className="muted">{picked.size} picked</span>
                  </div>
                </div>
              )}
              <div className="btn-row">
                {qrBatches.length > 1 && (
                  <select value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label="Which part">
                    {qrBatches.map(([a, b], k) => (
                      <option key={k} value={k}>{qrTables[a].name} – {qrTables[b - 1].name}</option>
                    ))}
                  </select>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || !qrTables.length}
                  onClick={() => run(() => downloadTableQrs(shop, qrTables.slice(...(qrBatches[range] || qrBatches[0])), { part: qrBatches.length > 1 ? range + 1 : 0 }))}
                >
                  ⬇️ Download {qrBatches.length > 1 ? "these" : qrTables.length} QR card{qrTables.length === 1 ? "" : "s"} (PDF)
                </button>
                <a className="btn btn-sm" href={orderUrl(shop, shop.tables[0].id)} target="_blank" rel="noopener noreferrer">👀 See customer page</a>
              </div>
              {qrBatches.length > 1 && <span className="hint">{qrTables.length} cards download {QR_BATCH} at a time so the phone doesn't freeze: pick each part above.</span>}
              <span className="hint">4 cards per A4 page, with your logo (Settings › Shop) and “scan with camera or Google Lens” steps. The QR codes stay the same as the ones you already printed.</span>
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
      <p className="hint" style={{ margin: "-6px 0 0" }}>
        💡 Use a <b>business UPI ID</b> (PhonePe Business, Paytm for Business or Google Pay for Business). Payment apps often block or limit
        payments with the amount filled in when they go to a personal UPI ID ("declined for security reasons"). Business IDs also work with a soundbox.
      </p>
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
        <Field label="New password" hint="At least 8 characters"><input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
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

// ---------- Promo codes ----------
const BLANK_PROMO = {
  tables: [],
  code: "", description: "", type: "percent", value: 10, maxDiscount: 0, minOrder: 0, validFrom: "", validTo: "", active: true,
  days: [], timeFrom: "", timeTo: "", maxUses: 0, onePerPhone: false, where: "both", showOnMenu: false,
};
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Table groups: far tables (e.g. QR codes at places that get deliveries) with their own prices
// and a delivery charge on smaller orders.
const pctText = (n) => (n > 0 ? `+${n}% prices` : n < 0 ? `${n}% prices` : "Menu prices");
function TableGroupsCard() {
  const { shop, saveShop } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const tables = shop.tables || [];
  const groups = shop.tableGroups || [];
  const [edit, setEdit] = useState(null);
  const { busy, error, run } = useAction();
  const remove = (g) =>
    confirm(`Delete “${g.name}”? Its tables go back to menu prices with no delivery charge.`) &&
    run(async () => {
      await saveShop({ tableGroups: groups.filter((x) => x.id !== g.id) });
      toast(`${g.name} deleted`);
    });
  return (
    <section className="card stack" id="table-groups">
      <h2>Table groups · prices &amp; delivery</h2>
      <p className="small muted" style={{ margin: 0 }}>
        For tables whose QR codes are far away (deliveries): their own prices, and a delivery charge on smaller orders. Customers at these tables see only their prices. Other tables keep the menu prices.
      </p>
      {error && <div className="error">{error}</div>}
      {groups.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>No groups yet. Example: <b>Delivery 1–3 km</b>, Table 50 – Table 80, +10% prices, {cur}30 delivery below {cur}300.</p>
      ) : (
        <div className="promo-list">
          {groups.map((g) => {
            const pct = Number(g.pricePercent) || 0;
            const own = Object.keys(g.prices || {}).length;
            return (
              <div key={g.id} className="promo-row">
                <div className="promo-main">
                  <b>{g.name}</b>
                  <span className="small">
                    {g.tables.length ? tableRuns(g.tables, tables).map(([a, b]) => (a === b ? a.name : `${a.name} – ${b.name}`)).join(", ") : "No tables yet"}
                  </span>
                  <span className="small muted">
                    {pctText(pct)}{own ? ` · own price for ${own} dish${own === 1 ? "" : "es"}` : ""} · {deliveryRule(g) ? deliveryText(deliveryRule(g), cur) : "no delivery charge"}
                  </span>
                </div>
                <div className="btn-row">
                  <button className="btn btn-sm" onClick={() => setEdit(g)}>Edit</button>
                  <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => remove(g)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {groups.length < MAX_GROUPS && (
        <button className="btn" onClick={() => setEdit({ id: "", name: "", tables: [], pricePercent: 0, prices: {}, delivery: { charge: 30, freeFrom: 300 } })}>+ New table group</button>
      )}
      {edit && (
        <TableGroupModal
          group={edit}
          groups={groups}
          cur={cur}
          onClose={() => setEdit(null)}
          onSave={async (next) => {
            await saveShop({ tableGroups: next });
            setEdit(null);
            toast("Table group saved");
          }}
        />
      )}
    </section>
  );
}

function TableGroupModal({ group, groups, cur, onClose, onSave }) {
  const { shop, menu } = useApp();
  const tables = shop.tables || [];
  const [g, setG] = useState(() => ({ ...group, prices: { ...(group.prices || {}) }, delivery: { ...group.delivery } }));
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const set = (k, v) => setG((x) => ({ ...x, [k]: v }));
  const pct = Number(g.pricePercent) || 0;
  const items = (menu || []).filter((m) => m.active !== false);
  const sample = items.find((m) => m.variants?.[0]?.price > 0);
  const own = items.filter((m) => g.prices[m.id]);
  const found = q.trim() ? items.filter((m) => !g.prices[m.id] && m.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const setOwn = (m, label, v) =>
    setG((x) => {
      const prices = { ...x.prices, [m.id]: { ...(x.prices[m.id] || {}) } };
      if (v === "") delete prices[m.id][label];
      else prices[m.id][label] = Math.max(0, Number(v) || 0);
      if (!Object.keys(prices[m.id]).length) delete prices[m.id];
      return { ...x, prices };
    });
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const mine = { ...g, id: g.id || `g${Date.now().toString(36)}`, name: g.name.trim(), pricePercent: pct, delivery: { charge: Math.max(0, Number(g.delivery.charge) || 0), freeFrom: Math.max(0, Number(g.delivery.freeFrom) || 0) } };
      let others = groups.filter((x) => x.id !== group.id);
      // A table can be in one group only: move it here, or leave it where it is.
      const taken = others.filter((o) => o.tables.some((t) => mine.tables.includes(t)));
      if (taken.length) {
        const names = taken.map((o) => `“${o.name}”`).join(", ");
        if (confirm(`Some of these tables are already in ${names}. Move them to “${mine.name}”?\n\nOK = move them here · Cancel = leave them where they are`))
          others = others.map((o) => ({ ...o, tables: o.tables.filter((t) => !mine.tables.includes(t)) }));
        else mine.tables = mine.tables.filter((t) => !taken.some((o) => o.tables.includes(t)));
      }
      await onSave(group.id ? groups.map((x) => (x.id === group.id ? mine : others.find((o) => o.id === x.id) || x)) : [...others, mine]);
    });
  };
  const ownRow = (m) => (
    <div key={m.id} className="group-price">
      <span className="small"><b>{m.name}</b></span>
      {m.variants.map((v) => (
        <label key={v.label} className="group-price-in small">
          {v.label || "Price"} <span className="muted">({money(v.price, cur)})</span>
          <input type="number" min="0" step="1" inputMode="numeric" placeholder={String(groupPrice({ pricePercent: pct }, m.id, v.label, v.price))} value={g.prices[m.id]?.[v.label || ""] ?? ""} onChange={(e) => setOwn(m, v.label || "", e.target.value)} />
        </label>
      ))}
      {g.prices[m.id] && <button type="button" className="chip-x" aria-label={`Use the group price for ${m.name}`} onClick={() => set("prices", Object.fromEntries(Object.entries(g.prices).filter(([k]) => k !== m.id)))}>✕</button>}
    </div>
  );
  return (
    <Modal title={group.id ? `Edit ${group.name}` : "New table group"} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <Field label="Group name" hint="e.g. Delivery 1–3 km">
          <input required autoFocus={!group.id} maxLength={40} value={g.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="field">
          Tables in this group
          <TableRangePicker tables={tables} ids={g.tables} onChange={(ids) => set("tables", ids)} hint={`${g.tables.length} table${g.tables.length === 1 ? "" : "s"}. A table can be in one group only.`} />
        </div>
        <div className="grid2">
          <Field label="Change all prices by (%)" hint="e.g. 10 = 10% more, −5 = 5% less, 0 = menu prices. Rounded to whole rupees.">
            <input type="number" min="-50" max="200" step="1" inputMode="numeric" value={g.pricePercent} onChange={(e) => set("pricePercent", e.target.value)} />
          </Field>
          <div className="field">
            Example
            <span className="hint" style={{ fontSize: 14 }}>
              {sample ? <>{sample.name}: {money(sample.variants[0].price, cur)} → <b>{money(groupPrice({ ...g, pricePercent: pct }, sample.id, sample.variants[0].label, sample.variants[0].price), cur)}</b></> : "Add dishes to the menu to see an example."}
            </span>
          </div>
        </div>
        <div className="field">
          Own price for some dishes <span className="hint">Optional. Wins over the % change.</span>
          {own.map(ownRow)}
          <input type="search" placeholder="Search a dish to set its price…" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.map(ownRow)}
        </div>
        <div className="grid2">
          <Field label={`Delivery charge (${cur})`} hint="0 = no delivery charge">
            <input type="number" min="0" step="1" inputMode="numeric" value={g.delivery.charge} onChange={(e) => set("delivery", { ...g.delivery, charge: e.target.value })} />
          </Field>
          <Field label={`Free delivery from (${cur})`} hint="Order amount (food, before discount). 0 = always charge">
            <input type="number" min="0" step="1" inputMode="numeric" value={g.delivery.freeFrom} onChange={(e) => set("delivery", { ...g.delivery, freeFrom: e.target.value })} />
          </Field>
        </div>
        {Number(g.delivery.charge) > 0 && <p className="hint" style={{ margin: 0 }}>Customers see: {deliveryText({ charge: Number(g.delivery.charge), freeFrom: Number(g.delivery.freeFrom) || 0 }, cur)}</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save group"}</button>
        </div>
      </form>
    </Modal>
  );
}

function promoStatus(p) {
  if (!p.active) return ["Paused", ""];
  if (p.validTo && p.validTo < todayIST()) return ["Expired", "bad"];
  if (p.validFrom && p.validFrom > todayIST()) return [`Starts ${fmtDate(p.validFrom)}`, "warn"];
  if (p.maxUses > 0 && p.uses >= p.maxUses) return ["Used up", "warn"];
  return ["Active", "good"];
}
const WHERE = { both: "Table QR + Billing", qr: "Table QR only", billing: "Billing only" };

function PromosCard() {
  const { shop } = useApp();
  const toast = useToast();
  const cur = shop.currency || "₹";
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // promo being edited, or BLANK_PROMO
  const { busy, error, run } = useAction();
  const load = () => run(async () => setList((await get("/promos")).promos));
  useEffect(() => {
    load();
  }, []);
  const remove = (p) =>
    confirm(p.uses ? `Delete ${p.code}? It was used ${p.uses} time${p.uses === 1 ? "" : "s"}; old bills keep showing it.` : `Delete ${p.code}?`) &&
    run(async () => {
      await del(`/promos/${p.id}`);
      toast(`${p.code} deleted`);
      await load();
    });
  return (
    <section className="card stack" id="promos">
      <h2>Promo codes</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Discount codes customers type when ordering from the table QR, or staff apply on the Billing screen. Set when they work, the minimum order and how many times they can be used.
      </p>
      {error && <div className="error">{error}</div>}
      {list === null ? (
        <p className="muted small">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>No codes yet. Try one like <b>WELCOME10</b>: 10% off up to {money(100, cur)}, once per mobile.</p>
      ) : (
        <div className="promo-list">
          {list.map((p) => {
            const [label, tone] = promoStatus(p);
            return (
              <div key={p.id} className="promo-row">
                <div className="promo-main">
                  <div className="promo-head">
                    <b className="promo-code">{p.code}</b>
                    <span className={"tag " + tone}>{label}</span>
                    {p.showOnMenu && <span className="tag">On menu</span>}
                  </div>
                  {p.description && <div className="small">{p.description}</div>}
                  <div className="small muted">{promoSummary(p, cur)} · {WHERE[p.where]}{p.tables?.length ? ` · ${tablesText(p.tables, shop.tables)}` : " · all tables"}</div>
                  <div className="small muted">
                    Used {p.uses}{p.maxUses > 0 ? ` of ${p.maxUses}` : ""} time{p.uses === 1 && !p.maxUses ? "" : "s"} · {money(p.discountGiven, cur)} given
                    {(p.validFrom || p.validTo) && ` · ${p.validFrom ? fmtDate(p.validFrom) : "now"} to ${p.validTo ? fmtDate(p.validTo) : "no end"}`}
                  </div>
                </div>
                <div className="btn-row">
                  <button className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button>
                  <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => remove(p)} aria-label={`Delete ${p.code}`}>🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => setEdit(BLANK_PROMO)}>+ New code</button>
      {edit && (
        <PromoModal
          promo={edit}
          cur={cur}
          onClose={() => setEdit(null)}
          onSaved={(p) => {
            toast(`${p.code} saved`);
            setEdit(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function PromoModal({ promo, cur, onClose, onSaved }) {
  const { shop } = useApp();
  const tables = shop.tables || [];
  const [p, setP] = useState(() => ({ ...BLANK_PROMO, ...promo, tables: (promo.tables || []).filter((id) => tables.some((t) => t.id === id)) }));
  const { busy, error, run } = useAction();
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const num = (v) => Math.max(0, Number(v) || 0);
  const toggleDay = (d) => set("days", p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d]);
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = { ...p, code: cleanCode(p.code), value: num(p.value), maxDiscount: p.type === "percent" ? num(p.maxDiscount) : 0, minOrder: num(p.minOrder), maxUses: Math.floor(num(p.maxUses)) };
      for (const k of ["id", "uses", "discountGiven", "createdAt", "updatedAt", "archived"]) delete body[k];
      const r = promo.id ? await put(`/promos/${promo.id}`, body) : await post("/promos", body);
      onSaved(r.promo);
    });
  };
  return (
    <Modal title={promo.id ? `Edit ${promo.code}` : "New promo code"} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label="Code" hint="Letters and numbers, like WELCOME10">
            <input required autoFocus={!promo.id} maxLength={20} pattern="[A-Za-z0-9]{3,20}" value={p.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} style={{ textTransform: "uppercase", fontWeight: 700 }} />
          </Field>
          <Field label="Description for customers" hint="Optional">
            <input maxLength={80} placeholder="10% off your first order" value={p.description} onChange={(e) => set("description", e.target.value)} />
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
            <Field label={`Up to (${cur})`} hint="Biggest discount. 0 = no cap">
              <input type="number" min="0" step="1" inputMode="numeric" value={p.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} />
            </Field>
          )}
          <Field label={`Minimum order (${cur})`} hint="Before discount and GST. 0 = any order">
            <input type="number" min="0" step="1" inputMode="numeric" value={p.minOrder} onChange={(e) => set("minOrder", e.target.value)} />
          </Field>
          <Field label="Total uses" hint="0 = no limit">
            <input type="number" min="0" step="1" inputMode="numeric" value={p.maxUses} onChange={(e) => set("maxUses", e.target.value)} />
          </Field>
        </div>
        {tables.length > 0 && (
          <div className="field">
            Which tables
            <Seg value={p.tables.length ? "some" : "all"} onChange={(v) => set("tables", v === "all" ? [] : p.tables.length ? p.tables : tables.slice(0, Math.min(10, tables.length)).map((t) => t.id))} options={[["all", "All tables"], ["some", "Only some tables"]]} />
            {p.tables.length > 0 && (
              <TableRangePicker tables={tables} ids={p.tables} onChange={(ids) => set("tables", ids)} hint={`${p.tables.length} table${p.tables.length === 1 ? "" : "s"}. At Billing, it works on these tables' bills only, not counter bills.`} />
            )}
          </div>
        )}
        <div className="field">
          Works on
          <Seg value={p.where} onChange={(v) => set("where", v)} options={[["both", "Table QR + Billing"], ["qr", "Table QR"], ["billing", "Billing"]]} />
        </div>
        <div className="grid2">
          <Field label="Valid from" hint="Optional">
            <input type="date" value={p.validFrom} onChange={(e) => set("validFrom", e.target.value)} />
          </Field>
          <Field label="Valid until" hint="Optional (last day it works)">
            <input type="date" min={p.validFrom || undefined} value={p.validTo} onChange={(e) => set("validTo", e.target.value)} />
          </Field>
        </div>
        <div className="field">
          Days <span className="hint">None selected = every day</span>
          <div className="day-chips">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <button type="button" key={d} className={"chip" + (p.days.includes(d) ? " on" : "")} aria-pressed={p.days.includes(d)} onClick={() => toggleDay(d)}>{DAY_NAMES[d]}</button>
            ))}
          </div>
        </div>
        <div className="grid2">
          <Field label="From time" hint="Optional, e.g. happy hours">
            <input type="time" value={p.timeFrom} onChange={(e) => set("timeFrom", e.target.value)} />
          </Field>
          <Field label="To time">
            <input type="time" value={p.timeTo} onChange={(e) => set("timeTo", e.target.value)} />
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={p.onePerPhone} onChange={(e) => set("onePerPhone", e.target.checked)} /> Once per mobile number</label>
        {p.where !== "billing" && (
          <label className="check"><input type="checkbox" checked={p.showOnMenu} onChange={(e) => set("showOnMenu", e.target.checked)} /> Show this offer on the customer menu</label>
        )}
        <label className="check"><input type="checkbox" checked={p.active} onChange={(e) => set("active", e.target.checked)} /> Active</label>
        {p.code && Number(p.value) > 0 && <p className="hint" style={{ margin: 0 }}>{cleanCode(p.code)}: {promoSummary({ ...p, value: num(p.value), maxDiscount: num(p.maxDiscount), minOrder: num(p.minOrder) }, cur)}</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save code"}</button>
        </div>
      </form>
    </Modal>
  );
}
