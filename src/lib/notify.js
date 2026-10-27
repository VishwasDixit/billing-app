// Phone / computer notifications for new orders and reminders, shown through the service worker
// (needed on Android and installed apps). Tapping one opens Orders (public/notify-sw.js).
import { get, post } from "./api.js";

const TAG = "orders";
export const notifySupported = () => typeof window !== "undefined" && "Notification" in window;
export const notifyPermission = () => (notifySupported() ? Notification.permission : "unsupported");
const wanted = () => {
  try {
    return JSON.parse(localStorage.getItem("notifyOn") ?? "true") !== false;
  } catch {
    return true;
  }
};

// Must be called from a tap (browsers only ask then).
export async function askNotify() {
  if (!notifySupported()) return "unsupported";
  const r = await Notification.requestPermission();
  try {
    localStorage.setItem("notifyOn", JSON.stringify(r === "granted"));
  } catch {
    /* private mode */
  }
  return r;
}

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
}

// One notification for all orders: each new one replaces the last (and rings again).
export async function notifyOrders(title, body) {
  if (notifyPermission() !== "granted" || !wanted()) return false;
  const opts = { body, tag: TAG, renotify: true, requireInteraction: true, icon: "/icon-192.png", badge: "/icon-192.png", vibrate: [300, 150, 300], data: { url: "/orders" } };
  try {
    const reg = await registration();
    if (reg?.showNotification) await reg.showNotification(title, opts);
    else new Notification(title, opts);
    return true;
  } catch {
    return false;
  }
}

export async function clearOrderNotifications() {
  try {
    const reg = await registration();
    for (const n of (await reg?.getNotifications?.({ tag: TAG })) || []) n.close();
  } catch {
    /* nothing to close */
  }
}

// ---- Lock-screen alerts (Web Push): the server sends them, so they arrive with the phone locked
// or the app closed. iPhone: iOS 16.4+ and only in the app added to the Home Screen.
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && notifySupported();
// iPhone in Safari (not the Home Screen app): push exists only after "Add to Home Screen".
export const pushNeedsHomeScreen = () => typeof window !== "undefined" && isIos() && !standalone();

const keyBytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function pushSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  return (await reg?.pushManager.getSubscription().catch(() => null)) || null;
}

// Must be called from a tap. Returns "on", "denied", "unsupported" or "not-set-up".
export async function pushOn() {
  if (!pushSupported()) return "unsupported";
  const { publicKey } = await get("/push/key");
  if (!publicKey) return "not-set-up";
  if ((await askNotify()) !== "granted") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an old server key can't receive: start again.
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await post("/push/subscribe", sub.toJSON());
  return "on";
}

export async function pushOff() {
  const sub = await pushSubscription();
  if (!sub) return;
  await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// On app start: tell the server again (it forgets devices that moved shop or stopped answering).
export async function refreshPush() {
  const sub = await pushSubscription();
  if (sub) await post("/push/subscribe", sub.toJSON()).catch(() => {});
}
