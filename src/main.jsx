import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppProvider } from "./lib/store.jsx";
import App from "./App.jsx";
import "./styles.css";
import { startTheme } from "./lib/theme.js";
import { registerSW } from "virtual:pwa-register";

startTheme();

// The app is saved on the phone for offline use. Look for a new version when the app is
// opened or brought back, and every 15 minutes; a new version reloads the page by itself
// (the bill being made is kept, see Billing).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => navigator.onLine && reg.update().catch(() => {});
    setInterval(check, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
  },
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
);
