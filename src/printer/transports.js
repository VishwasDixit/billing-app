// Ways to get ESC/POS bytes to the printer: BLE (Web Bluetooth), Bluetooth
// serial (Web Serial) and the RawBT Android app. Ported from the v1 app.

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

export const printer = { device: null, char: null, channels: [], port: null };
const listeners = new Set();
export const onPrinterChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());

// Chosen print channel per printer name; Bluetooth pairing is per device anyway.
function savedChannels() {
  try {
    return JSON.parse(localStorage.getItem("printerChannels") || "{}");
  } catch {
    return {};
  }
}
export function saveChannel(deviceName, uuid) {
  try {
    localStorage.setItem("printerChannels", JSON.stringify({ ...savedChannels(), [deviceName]: uuid }));
  } catch {
    /* ignore */
  }
}
export const savedChannelFor = (name) => savedChannels()[name];

export function shortUuid(u) {
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

export function pickChannel(channels, deviceName) {
  const writable = channels.filter((ch) => ch.writable);
  const saved = savedChannelFor(deviceName);
  return (
    writable.find((ch) => ch.uuid === saved) ||
    PRINT_CHARS.map((u) => writable.find((ch) => ch.uuid === u)).find(Boolean) ||
    // Unknown printer: skip 0xFExx services (vendor/firmware-update channels).
    writable.find((ch) => !/^0000fe/i.test(ch.service)) ||
    null
  );
}

export async function bleConnect(pickNew) {
  if (!navigator.bluetooth) {
    throw new Error("This browser can't use Bluetooth. Open the app in Google Chrome (Android or computer), or pick another print method in Settings.");
  }
  if (pickNew || !printer.device) {
    printer.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    printer.char = null;
    printer.device.addEventListener("gattserverdisconnected", () => {
      printer.char = null;
      changed();
    });
  }
  if (!printer.char || !printer.device.gatt.connected) {
    const server = await printer.device.gatt.connect();
    printer.channels = await listChannels(server);
    const ch = pickChannel(printer.channels, printer.device.name);
    if (!ch) throw new Error("Connected, but this printer has no print channel the app recognises. Open Settings → Diagnose printer, or try the RawBT (Android) print method.");
    printer.char = ch.char;
  }
  changed();
}

export async function bleWrite(c, bytes, slowMode) {
  const withResp = c.properties.write; // printer confirms each chunk: built-in flow control
  const gap = slowMode ? 100 : 40;
  let sent = 0;
  try {
    for (; sent < bytes.length; sent += 20) {
      const chunk = bytes.slice(sent, sent + 20);
      if (withResp) {
        await c.writeValueWithResponse(chunk);
        if (slowMode) await sleep(gap);
      } else {
        await c.writeValueWithoutResponse(chunk);
        await sleep(gap);
      }
    }
  } catch (err) {
    if (printer.device && !printer.device.gatt.connected) {
      throw new Error(
        `Printer disconnected while printing (after ${sent} of ${bytes.length} bytes).\n\n` +
          "If the printer switched off: charge it fully, keep “Large shop name & total” and “Print logo” off, and turn on Slow mode in Settings."
      );
    }
    throw err;
  }
}

export async function serialConnect(pickNew) {
  if (!navigator.serial) throw new Error("This browser can't use Bluetooth serial. Use Google Chrome on a computer.");
  if (pickNew || !printer.port) {
    printer.port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
  }
  if (!printer.port.writable) await printer.port.open({ baudRate: 9600 });
  changed();
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

export function connectedName(method) {
  if (method === "bluetooth" && printer.device && printer.char) return printer.device.name || "Bluetooth printer";
  if (method === "serial" && printer.port?.writable) return "Bluetooth serial printer";
  return null;
}

export async function connect(method) {
  return method === "serial" ? serialConnect(true) : bleConnect(true);
}

export async function sendBytes(method, bytes, { slowMode } = {}) {
  switch (method) {
    case "bluetooth":
      await bleConnect(false);
      return bleWrite(printer.char, bytes, slowMode);
    case "serial":
      return serialSend(bytes);
    case "rawbt":
      return rawbtSend(bytes);
    default:
      throw new Error("Unknown print method.");
  }
}

// Turns browser errors into advice a shopkeeper can act on. null = user cancelled.
export function explainPrintError(err) {
  if (err?.name === "NotFoundError" && /cancel/i.test(err.message)) return null;
  if (err?.name === "NotFoundError") return "No printer selected. Make sure the printer is on, Bluetooth is on, and no other app (e.g. Bill Sarthy) is connected to it.";
  if (err?.name === "NetworkError") return "Couldn't reach the printer. Turn it off and on, close other apps connected to it, then try again.";
  if (err?.name === "SecurityError" || err?.name === "NotAllowedError") return "Bluetooth permission was blocked. Allow Bluetooth for Chrome and try again.";
  return err?.message || String(err);
}
