// Phone / computer notifications for new orders and reminders, shown through the service worker
// (needed on Android and installed apps). Tapping one opens Orders (public/notify-sw.js).
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
