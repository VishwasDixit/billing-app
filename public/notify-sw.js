// Added to the app's service worker: tapping an order notification opens (or focuses) Orders.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/orders";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if ("navigate" in c && !c.url.endsWith(url)) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Web Push from the server (new orders, table requests, bills): shown even when the phone is
// locked or the app is closed. One "orders" notification that each new alert replaces and rings.
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "🔔 New order", {
      body: d.body || "Open Orders to see it.",
      tag: d.tag || "orders",
      renotify: true,
      requireInteraction: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      vibrate: [300, 150, 300, 150, 300],
      data: { url: d.url || "/orders" },
    })
  );
});
