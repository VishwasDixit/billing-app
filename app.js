"use strict";

/* ================= Store ================= */
const KEYS = { menu: "billing.menu", settings: "billing.settings", billNo: "billing.billNo" };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

const DEFAULT_SETTINGS = {
  shopName: "My Shop",
  address: "",
  phone: "",
  gstin: "",
  currency: "₹",
  gstPercent: 0,
  footer: "Thank you! Visit again.",
  discountType: "percent",
  printMethod: "bluetooth", // bluetooth | serial | rawbt | browser
  charsPerLine: 32,
  cutPaper: false,
  largeText: false, // double-size shop name & total (more power per line)
  slowMode: false,
  printerChannels: {}, // printer name -> characteristic UUID chosen in diagnostics
};

const SAMPLE_MENU = [
  { name: "Tea", price: 15, category: "Drinks" },
  { name: "Coffee", price: 25, category: "Drinks" },
  { name: "Lime Soda", price: 30, category: "Drinks" },
  { name: "Samosa", price: 20, category: "Snacks" },
  { name: "Veg Sandwich", price: 60, category: "Snacks" },
  { name: "Masala Dosa", price: 80, category: "Meals" },
  { name: "Veg Thali", price: 150, category: "Meals" },
].map((it) => ({ id: uid(), ...it }));

let menu = load(KEYS.menu, null) ?? SAMPLE_MENU;
let settings = { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) };
let billNo = load(KEYS.billNo, 1);
if (!load(KEYS.menu, null)) save(KEYS.menu, menu);

const cart = new Map(); // itemId -> qty
let activeCategory = "All";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ================= Helpers ================= */
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (n) => round2(n).toFixed(2);
const money = (n) => settings.currency + num(n);

/* ================= Totals ================= */
function computeTotals() {
  const lines = [];
  for (const [id, qty] of cart) {
    const item = menu.find((m) => m.id === id);
    if (!item) continue;
    lines.push({ name: item.name, rate: item.price, qty, amount: round2(item.price * qty) });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));

  const dVal = Math.max(0, parseFloat($("#discountValue").value) || 0);
  const dType = $("#discountType").value;
  let discount = dType === "percent" ? (subtotal * Math.min(dVal, 100)) / 100 : dVal;
  discount = round2(Math.min(discount, subtotal));

  const taxable = round2(subtotal - discount);
  const gstPct = Number(settings.gstPercent) || 0;
  const gst = round2((taxable * gstPct) / 100);
  const total = round2(taxable + gst);

  return { lines, subtotal, discount, dVal, dType, taxable, gstPct, gst, total };
}

/* ================= Render: menu ================= */
function categories() {
  const set = new Set(menu.map((m) => m.category).filter(Boolean));
  return ["All", ...[...set].sort()];
}

function renderCategories() {
  const cats = categories();
  if (!cats.includes(activeCategory)) activeCategory = "All";
  $("#categories").innerHTML =
    cats.length > 1
      ? cats
          .map((c) => `<button class="chip${c === activeCategory ? " active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`)
          .join("")
      : "";
  $("#categoryList").innerHTML = cats.slice(1).map((c) => `<option value="${esc(c)}">`).join("");
}

function renderMenu() {
  const q = $("#search").value.trim().toLowerCase();
  const items = menu
    .filter((m) => activeCategory === "All" || m.category === activeCategory)
    .filter((m) => !q || m.name.toLowerCase().includes(q));

  $("#menuGrid").innerHTML = items.length
    ? items
        .map((m) => {
          const qty = cart.get(m.id);
          return `<button class="menu-item" data-id="${m.id}">
            ${qty ? `<span class="badge">${qty}</span>` : ""}
            <span class="name">${esc(m.name)}</span>
            <span class="price">${esc(money(m.price))}</span>
          </button>`;
        })
        .join("")
    : `<div class="empty">${menu.length ? "No items match." : "No menu items yet. Click “+ Add Item”."}</div>`;
}

/* ================= Render: cart ================= */
function renderCart() {
  const t = computeTotals();

  $("#cartList").innerHTML = t.lines.length
    ? [...cart.keys()]
        .map((id) => {
          const item = menu.find((m) => m.id === id);
          if (!item) return "";
          const qty = cart.get(id);
          return `<div class="cart-line" data-id="${id}">
            <div>
              <div class="ln-name">${esc(item.name)}</div>
              <div class="ln-rate">${esc(money(item.price))}</div>
            </div>
            <div class="qty">
              <button data-act="dec" aria-label="Decrease">−</button>
              <input data-act="set" type="number" min="0" value="${qty}" inputmode="numeric">
              <button data-act="inc" aria-label="Increase">+</button>
            </div>
            <div class="ln-amt">${esc(money(item.price * qty))}</div>
          </div>`;
        })
        .join("")
    : `<div class="empty">Tap menu items to add them.</div>`;

  let rows = `<div class="row"><span>Subtotal</span><span>${esc(money(t.subtotal))}</span></div>`;
  if (t.discount > 0) {
    const label = t.dType === "percent" ? `Discount (${t.dVal}%)` : "Discount";
    rows += `<div class="row"><span>${label}</span><span>−${esc(money(t.discount))}</span></div>`;
  }
  if (t.gstPct > 0) {
    rows += `<div class="row"><span>GST (${t.gstPct}%)</span><span>${esc(money(t.gst))}</span></div>`;
  }
  rows += `<div class="row grand"><span>Total</span><span>${esc(money(t.total))}</span></div>`;
  $("#totals").innerHTML = rows;

  $("#printBtn").disabled = t.lines.length === 0;
}

function renderAll() {
  $("#shopTitle").textContent = settings.shopName || "Billing";
  document.title = (settings.shopName || "Billing") + " · Billing";
  renderCategories();
  renderMenu();
  renderCart();
}

/* ================= Cart actions ================= */
function setQty(id, qty) {
  qty = Math.max(0, Math.floor(qty) || 0);
  if (qty === 0) cart.delete(id);
  else cart.set(id, qty);
  renderMenu();
  renderCart();
}

$("#menuGrid").addEventListener("click", (e) => {
  const btn = e.target.closest(".menu-item");
  if (!btn) return;
  const id = btn.dataset.id;
  if ($("#editMode").checked) openItemDialog(id);
  else setQty(id, (cart.get(id) || 0) + 1);
});

$("#cartList").addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  const id = e.target.closest(".cart-line")?.dataset.id;
  if (!id || !act) return;
  if (act === "inc") setQty(id, cart.get(id) + 1);
  if (act === "dec") setQty(id, cart.get(id) - 1);
});

$("#cartList").addEventListener("change", (e) => {
  if (e.target.dataset.act !== "set") return;
  const id = e.target.closest(".cart-line").dataset.id;
  setQty(id, parseInt(e.target.value, 10));
});

$("#clearCart").addEventListener("click", () => {
  if (cart.size && !confirm("Clear all items from the cart?")) return;
  cart.clear();
  renderMenu();
  renderCart();
});

$("#discountValue").addEventListener("input", renderCart);
$("#discountType").addEventListener("change", () => {
  settings.discountType = $("#discountType").value;
  save(KEYS.settings, settings);
  renderCart();
});

$("#search").addEventListener("input", renderMenu);
$("#categories").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  activeCategory = chip.dataset.cat;
  renderCategories();
  renderMenu();
});

$("#editMode").addEventListener("change", (e) => document.body.classList.toggle("editing", e.target.checked));

/* ================= Menu item dialog ================= */
let editingId = null;

function openItemDialog(id = null) {
  editingId = id;
  const form = $("#itemForm");
  const item = id ? menu.find((m) => m.id === id) : null;
  form.reset();
  $("#itemDialogTitle").textContent = item ? "Edit Item" : "Add Item";
  $("#deleteItemBtn").style.display = item ? "" : "none";
  if (item) {
    form.name.value = item.name;
    form.price.value = item.price;
    form.category.value = item.category || "";
  } else if (activeCategory !== "All") {
    form.category.value = activeCategory;
  }
  $("#itemDialog").showModal();
  form.name.focus();
}

$("#addItemBtn").addEventListener("click", () => openItemDialog());

$("#itemDialog").addEventListener("close", () => {
  if ($("#itemDialog").returnValue !== "save") return;
  const form = $("#itemForm");
  const data = {
    name: form.name.value.trim(),
    price: round2(Math.max(0, parseFloat(form.price.value) || 0)),
    category: form.category.value.trim(),
  };
  if (!data.name) return;
  if (editingId) {
    Object.assign(menu.find((m) => m.id === editingId), data);
  } else {
    menu.push({ id: uid(), ...data });
  }
  save(KEYS.menu, menu);
  renderAll();
});

$("#deleteItemBtn").addEventListener("click", () => {
  const item = menu.find((m) => m.id === editingId);
  if (!item || !confirm(`Delete “${item.name}” from the menu?`)) return;
  menu = menu.filter((m) => m.id !== editingId);
  cart.delete(editingId);
  save(KEYS.menu, menu);
  $("#itemDialog").close("cancel");
  renderAll();
});

/* ================= Settings dialog ================= */
$("#settingsBtn").addEventListener("click", () => {
  const form = $("#settingsForm");
  for (const key of ["shopName", "address", "phone", "gstin", "currency", "gstPercent", "footer", "printMethod", "charsPerLine"]) {
    form[key].value = settings[key];
  }
  form.cutPaper.checked = !!settings.cutPaper;
  form.largeText.checked = !!settings.largeText;
  form.slowMode.checked = !!settings.slowMode;
  form.billNo.value = billNo;
  $("#settingsDialog").showModal();
});

$("#settingsDialog").addEventListener("close", () => {
  if ($("#settingsDialog").returnValue !== "save") return;
  const form = $("#settingsForm");
  settings = {
    ...settings,
    shopName: form.shopName.value.trim(),
    address: form.address.value.trim(),
    phone: form.phone.value.trim(),
    gstin: form.gstin.value.trim(),
    currency: form.currency.value.trim(),
    gstPercent: Math.max(0, parseFloat(form.gstPercent.value) || 0),
    footer: form.footer.value.trim(),
    printMethod: form.printMethod.value,
    charsPerLine: Math.min(64, Math.max(16, parseInt(form.charsPerLine.value, 10) || 32)),
    cutPaper: form.cutPaper.checked,
    largeText: form.largeText.checked,
    slowMode: form.slowMode.checked,
  };
  billNo = Math.max(1, parseInt(form.billNo.value, 10) || 1);
  save(KEYS.settings, settings);
  save(KEYS.billNo, billNo);
  renderAll();
  updatePrinterUI();
});

/* ================= Receipt + print ================= */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildReceipt() {
  const t = computeTotals();
  const d = new Date();
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const itemCount = t.lines.reduce((s, l) => s + l.qty, 0);
  const s = settings;

  const row = (l, r, cls = "") => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`;

  let html = `<div class="c shop">${esc(s.shopName)}</div>`;
  if (s.address) html += `<div class="c small">${esc(s.address).replace(/\n/g, "<br>")}</div>`;
  if (s.phone) html += `<div class="c small">Ph: ${esc(s.phone)}</div>`;
  if (s.gstin) html += `<div class="c small">GSTIN: ${esc(s.gstin)}</div>`;
  html += `<div class="sep"></div>`;
  html += row(`Bill: ${billNo}`, date);
  html += row("", time);
  html += `<div class="sep"></div>`;

  for (const l of t.lines) {
    html += `<div class="item-name">${esc(l.name)}</div>`;
    html += row(`<span class="item-calc">${l.qty} x ${num(l.rate)}</span>`, num(l.amount));
  }

  html += `<div class="sep"></div>`;
  html += row(`Items: ${itemCount}`, "");
  html += row("Subtotal", num(t.subtotal));
  if (t.discount > 0) {
    html += row(t.dType === "percent" ? `Discount ${t.dVal}%` : "Discount", "-" + num(t.discount));
  }
  if (t.gstPct > 0) {
    html += row(`CGST ${round2(t.gstPct / 2)}%`, num(t.gst / 2));
    html += row(`SGST ${round2(t.gstPct / 2)}%`, num(t.gst - round2(t.gst / 2)));
  }
  html += `<div class="sep"></div>`;
  html += row("TOTAL", esc(money(t.total)), "total");
  html += `<div class="sep"></div>`;
  if (s.footer) html += `<div class="c">${esc(s.footer)}</div>`;

  $("#receipt").innerHTML = html;
}

/* ================= Direct printer connection ================= */
// GATT services used by common BLE thermal printers.
const BLE_SERVICES = [
  0x18f0, 0xff00, 0xffe0, 0xae30, 0xae3a,
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];
const uuid16 = (n) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
// Known print-data characteristics, most common first. Other writable
// characteristics are often control/firmware channels that reset the printer.
const PRINT_CHARS = [
  uuid16(0x2af1), uuid16(0xff02), uuid16(0xae01), uuid16(0xffe1),
  "49535343-8841-43f4-a8d4-ecbe34729bb3",
  "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
];
const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const printer = { device: null, char: null, channels: [], port: null };

function shortUuid(u) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u);
  return m ? "0x" + m[1].toUpperCase() : u;
}

async function listChannels(server) {
  const out = [];
  for (const svc of await server.getPrimaryServices()) {
    for (const c of await svc.getCharacteristics()) {
      const p = c.properties;
      out.push({
        service: svc.uuid,
        uuid: c.uuid,
        char: c,
        writable: !!(p.write || p.writeWithoutResponse),
        props: ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter((k) => p[k]),
      });
    }
  }
  return out;
}

function pickChannel(channels, deviceName) {
  const writable = channels.filter((ch) => ch.writable);
  const saved = settings.printerChannels?.[deviceName];
  return (
    writable.find((ch) => ch.uuid === saved) ||
    PRINT_CHARS.map((u) => writable.find((ch) => ch.uuid === u)).find(Boolean) ||
    // Unknown printer: skip 0xFExx services (vendor/firmware-update channels).
    writable.find((ch) => !/^0000fe/i.test(ch.service)) ||
    null
  );
}

async function bleConnect(pickNew) {
  if (!navigator.bluetooth) {
    throw new Error("This browser can't use Bluetooth. Open the app in Google Chrome (Android or Mac), or pick another print method in Settings.");
  }
  if (pickNew || !printer.device) {
    printer.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    printer.char = null;
    printer.device.addEventListener("gattserverdisconnected", () => {
      printer.char = null;
      updatePrinterUI();
      renderDiag();
    });
  }
  if (!printer.char || !printer.device.gatt.connected) {
    const server = await printer.device.gatt.connect();
    printer.channels = await listChannels(server);
    const ch = pickChannel(printer.channels, printer.device.name);
    if (!ch) throw new Error("Connected, but this printer has no print channel the app recognises. Open Settings → Diagnose printer, or try the RawBT (Android) print method.");
    printer.char = ch.char;
  }
  updatePrinterUI();
}

async function bleWrite(c, bytes) {
  const withResp = c.properties.write; // printer confirms each chunk: built-in flow control
  const gap = settings.slowMode ? 100 : 40;
  let sent = 0;
  try {
    for (; sent < bytes.length; sent += 20) {
      const chunk = bytes.slice(sent, sent + 20);
      if (withResp) {
        await c.writeValueWithResponse(chunk);
        if (settings.slowMode) await sleep(gap);
      } else {
        await c.writeValueWithoutResponse(chunk);
        await sleep(gap);
      }
    }
  } catch (err) {
    if (printer.device && !printer.device.gatt.connected) {
      throw new Error(
        `Printer disconnected while printing (after ${sent} of ${bytes.length} bytes).\n\n` +
          "If the printer switched off: charge it fully, keep \u201cLarge shop name & total\u201d off, and turn on Slow mode in Settings. " +
          "Use Settings → Diagnose printer to try each channel with a tiny \u201cHello\u201d print."
      );
    }
    throw err;
  }
}

async function bleSend(bytes) {
  await bleConnect(false);
  await bleWrite(printer.char, bytes);
}

async function serialConnect(pickNew) {
  if (!navigator.serial) {
    throw new Error("This browser can't use Bluetooth serial. Use Google Chrome on a Mac or PC.");
  }
  if (pickNew || !printer.port) {
    printer.port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
  }
  if (!printer.port.writable) await printer.port.open({ baudRate: 9600 });
  updatePrinterUI();
}

async function serialSend(bytes) {
  await serialConnect(false);
  const writer = printer.port.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

function rawbtSend(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  window.location.href = "rawbt:base64," + btoa(bin);
}

function printerName() {
  if (settings.printMethod === "bluetooth" && printer.device && printer.char) return printer.device.name || "Bluetooth printer";
  if (settings.printMethod === "serial" && printer.port?.writable) return "Bluetooth serial printer";
  return null;
}

function updatePrinterUI() {
  const direct = settings.printMethod === "bluetooth" || settings.printMethod === "serial";
  $("#printerBar").hidden = !direct;
  const name = printerName();
  $("#printerStatus").textContent = name ? `Printer: ${name}` : "Printer: not connected";
  $("#printerStatus").classList.toggle("ok", !!name);
  $("#connectBtn").textContent = name ? "Change" : "Connect";
}

async function sendToPrinter(bytes) {
  switch (settings.printMethod) {
    case "bluetooth": return bleSend(bytes);
    case "serial": return serialSend(bytes);
    case "rawbt": return rawbtSend(bytes);
  }
}

function explain(err) {
  if (err?.name === "NotFoundError" && /cancel/i.test(err.message)) return null; // user closed the chooser
  if (err?.name === "NotFoundError") return "No printer selected. Make sure the printer is on, Bluetooth is on, and Bill Sarthy (or any other app) is not connected to it.";
  if (err?.name === "NetworkError") return "Couldn't reach the printer. Turn it off and on, close other apps connected to it, then try again.";
  if (err?.name === "SecurityError" || err?.name === "NotAllowedError") return "Bluetooth permission was blocked. Allow Bluetooth for Chrome and try again.";
  return err?.message || String(err);
}

async function withPrinter(task) {
  try {
    await task();
    return true;
  } catch (err) {
    console.error(err);
    const msg = explain(err);
    if (msg) alert("Printing failed:\n\n" + msg);
    updatePrinterUI();
    return false;
  }
}

$("#connectBtn").addEventListener("click", () =>
  withPrinter(() => (settings.printMethod === "serial" ? serialConnect(true) : bleConnect(true)))
);

$("#testPrintBtn").addEventListener("click", () => {
  // Use the values currently in the form, even before saving.
  const form = $("#settingsForm");
  const s = {
    ...settings,
    printMethod: form.printMethod.value,
    charsPerLine: parseInt(form.charsPerLine.value, 10) || 32,
    cutPaper: form.cutPaper.checked,
    slowMode: form.slowMode.checked,
  };
  if (s.printMethod === "browser") return alert("Test print is for the direct printer methods. Choose Bluetooth, Bluetooth serial or RawBT.");
  const prev = settings;
  settings = s;
  withPrinter(() => sendToPrinter(EscPos.testPage(s))).finally(() => {
    settings = { ...prev, printerChannels: s.printerChannels };
    updatePrinterUI();
  });
});

/* ================= Printer diagnostics ================= */
const HELLO = new Uint8Array([0x1b, 0x40, ...[..."Hello\n"].map((c) => c.charCodeAt(0)), 0x0a, 0x0a]);
let diagLog = [];

function logDiag(msg) {
  diagLog.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  renderDiag();
}

function renderDiag() {
  if (!$("#diagDialog").open) return;
  const d = printer.device;
  const connected = !!(d && d.gatt.connected);
  $("#diagStatus").textContent = d ? `${d.name || "Unnamed printer"} \u2014 ${connected ? "connected" : "disconnected"}` : "No printer connected.";
  $("#diagConnect").textContent = d ? (connected ? "Choose another printer" : "Reconnect") : "Connect printer";

  const saved = d && settings.printerChannels?.[d.name];
  $("#diagChannels").innerHTML = connected && printer.channels.length
    ? printer.channels
        .map((ch, i) => {
          const inUse = printer.char === ch.char;
          return `<div class="diag-ch${inUse ? " in-use" : ""}">
            <div>
              <div class="diag-uuid">${esc(shortUuid(ch.uuid))}${inUse ? ' <span class="tag">in use</span>' : ""}${ch.uuid === saved ? ' <span class="tag">saved</span>' : ""}</div>
              <div class="diag-meta">service ${esc(shortUuid(ch.service))} \u00b7 ${esc(ch.props.join(", ") || "none")}</div>
            </div>
            ${ch.writable ? `<div class="diag-actions">
              <button type="button" class="btn btn-sm" data-hello="${i}">Send Hello</button>
              <button type="button" class="btn btn-sm" data-use="${i}">Use this</button>
            </div>` : ""}
          </div>`;
        })
        .join("")
    : `<div class="empty">${d ? "Reconnect to list the printer's channels." : "Connect to list the printer's channels."}</div>`;
  $("#diagLog").textContent = diagLog.join("\n");
  $("#diagLog").scrollTop = 1e6;
}

$("#diagBtn").addEventListener("click", () => {
  if (settings.printMethod !== "bluetooth") logDiag("Note: diagnostics use the Bluetooth printer method.");
  $("#diagDialog").showModal();
  renderDiag();
});

$("#diagConnect").addEventListener("click", async () => {
  const pickNew = !printer.device || printer.device.gatt.connected;
  logDiag(pickNew ? "Choosing printer..." : "Reconnecting...");
  try {
    printer.char = null;
    await bleConnect(pickNew);
    const ch = printer.channels.find((c) => c.char === printer.char);
    logDiag(`Connected to ${printer.device.name || "printer"}. ${printer.channels.length} channels found; auto-picked ${shortUuid(ch.uuid)}.`);
  } catch (err) {
    const msg = explain(err);
    if (msg) logDiag("Error: " + msg);
  }
  renderDiag();
});

$("#diagChannels").addEventListener("click", async (e) => {
  const helloIdx = e.target.dataset.hello;
  const useIdx = e.target.dataset.use;
  if (useIdx != null) {
    const ch = printer.channels[useIdx];
    printer.char = ch.char;
    settings.printerChannels = { ...settings.printerChannels, [printer.device.name]: ch.uuid };
    save(KEYS.settings, settings);
    logDiag(`Will print to ${shortUuid(ch.uuid)} for ${printer.device.name}.`);
    updatePrinterUI();
  }
  if (helloIdx != null) {
    const ch = printer.channels[helloIdx];
    logDiag(`Sending Hello to ${shortUuid(ch.uuid)}...`);
    try {
      await bleWrite(ch.char, HELLO);
      await sleep(1500);
      logDiag(printer.device.gatt.connected ? "Sent. Did the printer print \u201cHello\u201d?" : "Sent, but the printer disconnected afterwards (it may have reset). Avoid this channel.");
    } catch (err) {
      logDiag("Error: " + (explain(err) || err));
    }
  }
});

function startNextBill() {
  if (!confirm("Bill printed? Clear cart and start the next bill?")) return;
  billNo += 1;
  save(KEYS.billNo, billNo);
  cart.clear();
  $("#discountValue").value = 0;
  renderMenu();
  renderCart();
}

$("#printBtn").addEventListener("click", async () => {
  if (!cart.size) return;

  if (settings.printMethod === "browser") {
    buildReceipt();
    window.print();
    // window.print() blocks until the dialog closes in most browsers.
    setTimeout(startNextBill, 300);
    return;
  }

  // Build the bytes before any await so the Bluetooth chooser still counts as a user gesture.
  const bytes = EscPos.receipt(settings, computeTotals(), billNo, new Date());
  const btn = $("#printBtn");
  btn.disabled = true;
  btn.textContent = "Printing…";
  const ok = await withPrinter(() => sendToPrinter(bytes));
  btn.textContent = "Print Bill";
  renderCart();
  if (ok) setTimeout(startNextBill, settings.printMethod === "rawbt" ? 1500 : 300);
});

/* ================= Init ================= */
$("#discountType").value = settings.discountType;
renderAll();
updatePrinterUI();
