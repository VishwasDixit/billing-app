import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { useApp, accessState } from "./lib/store.jsx";
import { ToastProvider } from "./components/ui.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import FindEmail from "./pages/FindEmail.jsx";
import StaffLogin from "./pages/StaffLogin.jsx";
import Billing from "./pages/Billing.jsx";
import Bills from "./pages/Bills.jsx";
import Expenses from "./pages/Expenses.jsx";
import Menu from "./pages/Menu.jsx";
import Settings from "./pages/Settings.jsx";
import Plans from "./pages/Plans.jsx";
import Admin from "./pages/Admin.jsx";
import Customers from "./pages/Customers.jsx";
import CustomerDetail from "./pages/CustomerDetail.jsx";
import Help from "./pages/Help.jsx";
import CustomerOrder from "./pages/CustomerOrder.jsx";
import Orders from "./pages/Orders.jsx";
import Kitchen from "./pages/Kitchen.jsx";
import { initOrders, refreshOrders, useOrders, chime, unlockAudio, audioReady } from "./lib/orders.js";
import { startRinging, stopRinging, clearRinging, ringerState, nextReminderAt, remindMinutes } from "./lib/ringer.js";
import { notifyOrders, clearOrderNotifications, ensurePush } from "./lib/notify.js";
import { RingBar } from "./components/RingBar.jsx";
import { AlertSetupBar } from "./components/AlertSetupBar.jsx";
import { AlertsButton, AlertsPanel, useAlertCount } from "./components/AlertsPanel.jsx";
import { useToast } from "./components/ui.jsx";
import { signOutStaff } from "./lib/kitchen.js";
import { get } from "./lib/api.js";
import { StaffGate } from "./components/StaffPin.jsx";

const Dashboard = lazy(() => import("./pages/Dashboard.jsx")); // charts load on first visit
const KitchenManage = lazy(() => import("./pages/KitchenManage.jsx"));
const Staff = lazy(() => import("./pages/Staff.jsx"));

export default function App() {
  const { session, booting } = useApp();
  const loc = useLocation();
  // The customer's QR order page works without logging in.
  if (loc.pathname.startsWith("/order/")) {
    return (
      <Routes>
        <Route path="/order/:token" element={<CustomerOrder />} />
      </Routes>
    );
  }
  if (booting && !session) return <div className="empty">Loading…</div>;

  return (
    <ToastProvider>
      {!session ? (
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/forgot" element={<ForgotPassword />} />
          <Route path="/find-email" element={<FindEmail />} />
          <Route path="/staff-login" element={<StaffLogin />} />
          <Route path="*" element={<Login />} />
        </Routes>
      ) : (
        <Shell>
          {session.user.role === "kitchen" ? (
            // A kitchen phone: only the kitchen screens, never sales or money.
            <Routes>
              <Route path="/kitchen" element={<Kitchen />} />
              <Route path="/kitchen-manage" element={<KitchenManage />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="*" element={<Navigate to="/kitchen" replace />} />
            </Routes>
          ) : session.user.role === "manager" ? (
            // Counter staff: billing, tables and the kitchen. No reports, money summaries or settings.
            <Routes>
              <Route path="/" element={<Billing />} />
              <Route path="/bills" element={<Bills />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/customers/:id" element={<CustomerDetail />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/kitchen" element={<Kitchen />} />
              <Route path="/kitchen-manage" element={<KitchenManage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : (
          <Routes>
            <Route path="/" element={<Billing />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/menu" element={<Menu />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/plans" element={<Plans />} />
            <Route path="/help" element={<Help />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/kitchen" element={<Kitchen />} />
            <Route path="/kitchen-manage" element={<KitchenManage />} />
            <Route path="/staff" element={<Staff />} />
            {session.user.role === "admin" && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          )}
        </Shell>
      )}
    </ToastProvider>
  );
}

// True when support has replied to a help message the owner hasn't read yet.
function useHelpUnread(enabled) {
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const check = () => get("/help/threads").then((r) => setUnread(r.threads.some((t) => t.unreadByShop))).catch(() => {});
    check();
    const t = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return unread;
}

// Number of open kitchen alerts (low stock, expiring, waste) for the More menu.
// Checked every minute; a new one plays a chime and shows its message.
function useKitchenAlerts(enabled) {
  const loc = useLocation();
  const toast = useToast();
  const [n, setN] = useState(0);
  const prev = useRef(null);
  const check = () =>
    get("/kitchen/alerts/count").then(
      (r) => {
        if (prev.current !== null && r.count > prev.current) {
          chime();
          if (r.latest) toast(`🔔 Kitchen: ${r.latest.message}`);
        }
        prev.current = r.count;
        setN(r.count);
      },
      () => {}
    );
  useEffect(() => {
    if (enabled) check();
  }, [enabled, loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => document.visibilityState === "visible" && check(), 60000);
    return () => clearInterval(t);
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return [n, check];
}

// Someone is looking at the app: it's on screen and the window is the active one (another app
// in front, or another Chrome window, counts as not looking).
const looking = () => document.visibilityState === "visible" && document.hasFocus();

// Keeps table orders fresh on every screen, rings the bell when something new needs staff
// (QR order, bill request, payment, table help) until someone stops it, and rings again every
// few minutes (device setting, 5 by default) while anything is still waiting.
function useOrderAlerts(shop, isKitchen) {
  const toast = useToast();
  const loc = useLocation();
  const st = useOrders();
  const hasTables = (shop.tables || []).length > 0;
  // Alerts while the app is closed: on whenever notifications are allowed (once per app start).
  useEffect(() => {
    ensurePush();
  }, [shop._id]);
  // Kitchen phones ring for new tickets and table help; the counter for everything waiting.
  const attention = isKitchen ? st.waiting + (st.helpOpen || 0) : st.attention;
  useEffect(() => {
    initOrders(shop.id).then(() => hasTables && refreshOrders().catch(() => {}));
  }, [shop.id, hasTables]);
  // Every 15 s on screen; every 30 s in the background, so the bell and notifications still come.
  useEffect(() => {
    if (!hasTables) return;
    let last = 0;
    const t = setInterval(() => {
      const gap = document.visibilityState === "visible" ? 15000 : 30000;
      if (Date.now() - last < gap - 500) return;
      last = Date.now();
      refreshOrders().catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [hasTables]);
  // A push from the server (public/notify-sw.js) wakes this page at once, even in a background
  // tab whose timers the browser slows down: fetch now, and the bell rings for what's new.
  useEffect(() => {
    if (!hasTables || !("serviceWorker" in navigator)) return;
    const onMsg = (e) => e.data?.type === "orders-alert" && refreshOrders().catch(() => {});
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [hasTables]);
  const what = () => {
    const parts = [];
    if (st.waiting) parts.push(`${st.waiting} new order${st.waiting === 1 ? "" : "s"}`);
    if (st.helpOpen) parts.push(`${st.helpOpen} table request${st.helpOpen === 1 ? "" : "s"}`);
    const other = attention - st.waiting - (st.helpOpen || 0);
    if (!isKitchen && other > 0) parts.push(`${other} bill/payment${other === 1 ? "" : "s"}`);
    return parts.join(" · ") || `${attention} waiting`;
  };
  const ring = (reminder) => {
    startRinging();
    if (!looking()) notifyOrders(reminder ? `🔔 Still waiting: ${what()}` : `🔔 ${what()}`, `${shop.name}: open Orders to see it.`);
  };
  const prev = useRef(attention);
  useEffect(() => {
    if (attention > prev.current) {
      ring(false);
      if (loc.pathname !== "/orders" && !isKitchen) toast(`🔔 ${what()}. Open Orders.`);
    }
    if (attention === 0) {
      clearRinging();
      clearOrderNotifications();
    }
    prev.current = attention;
  }, [attention]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening Orders (or the kitchen screen) means someone is looking: stop ringing.
  useEffect(() => {
    if (loc.pathname === "/orders" || (isKitchen && loc.pathname === "/kitchen")) {
      if (ringerState().ringing) stopRinging();
      if (looking()) clearOrderNotifications();
    }
  }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  // The reminder: checked every 15 s.
  const latest = useRef({ attention, ring });
  latest.current = { attention, ring };
  useEffect(() => {
    const t = setInterval(() => {
      const { attention: n, ring: r } = latest.current;
      const due = nextReminderAt({ lastAlertAt: ringerState().lastAlertAt, intervalMin: remindMinutes(), attention: n });
      if (due && Date.now() >= due && !ringerState().ringing) r(true);
    }, 15000);
    return () => clearInterval(t);
  }, []);
  return { hasTables, waiting: st.attention, attention, what };
}

// Page links. `bottom` ones sit in the phone's bottom bar; the rest live in the ☰ More sheet
// (on wide screens all `top` ones show in the top bar).
function useNavLinks({ isAdmin, isKitchen, isManager, paid, waiting, helpUnread, kitchenAlerts }) {
  if (isManager) {
    return [
      { to: "/", ico: "🧾", label: "Billing", bottom: true, top: true },
      { to: "/orders", ico: waiting ? "🔔" : "🍽️", label: waiting ? `Orders (${waiting})` : "Orders", short: waiting ? `${waiting} new` : "Orders", bottom: true, top: true, alert: waiting > 0 },
      { to: "/bills", ico: "📄", label: "Bills", bottom: true, top: true },
      { to: "/customers", ico: "📒", label: "Udhar", top: true },
      { to: "/expenses", ico: "💸", label: "Expenses", top: true },
      { to: "/kitchen-manage", ico: "🥫", label: kitchenAlerts ? `Kitchen stock (${kitchenAlerts})` : "Kitchen stock", topLabel: kitchenAlerts ? `Kitchen (${kitchenAlerts})` : "Kitchen", top: true, alert: kitchenAlerts > 0 },
      { to: "/kitchen", ico: "🍳", label: "Kitchen screen" },
    ];
  }
  if (isKitchen) {
    return [
      { to: "/kitchen", ico: "🍳", label: "Board", bottom: true, top: true },
      { to: "/kitchen-manage", ico: "🥫", label: kitchenAlerts ? `Kitchen (${kitchenAlerts})` : "Kitchen", bottom: true, top: true, alert: kitchenAlerts > 0 },
      { to: "/orders", ico: waiting ? "🔔" : "🍽️", label: waiting ? `Orders (${waiting})` : "Orders", short: waiting ? `${waiting} new` : "Orders", bottom: true, top: true, alert: waiting > 0 },
      { to: "/kitchen-manage?tab=shopping", ico: "🛒", label: "Shopping list" },
      { to: "/kitchen-manage?tab=recipes", ico: "📖", label: "Recipes" },
    ];
  }
  return [
    ...(isAdmin ? [{ to: "/admin", ico: "🛡️", label: "Admin", bottom: true, top: true }] : []),
    { to: "/", ico: "🧾", label: "Billing", bottom: true, top: true },
    { to: "/orders", ico: waiting ? "🔔" : "🍽️", label: waiting ? `Orders (${waiting})` : "Orders", short: waiting ? `${waiting} new` : "Orders", bottom: true, top: true, alert: waiting > 0 },
    { to: "/bills", ico: "📄", label: "Bills", top: true },
    { to: "/customers", ico: "📒", label: "Udhar", top: true },
    { to: "/dashboard", ico: paid ? "📊" : "🔒", label: "Dashboard", top: true },
    { to: "/expenses", ico: "💸", label: "Expenses", top: true },
    { to: "/kitchen", ico: "🍳", label: "Kitchen screen" },
    { to: "/kitchen-manage", ico: "🥫", label: kitchenAlerts ? `Kitchen stock (${kitchenAlerts})` : "Kitchen stock", topLabel: kitchenAlerts ? `Kitchen (${kitchenAlerts})` : "Kitchen", top: true, alert: kitchenAlerts > 0 },
    ...(isAdmin ? [] : [{ to: "/staff", ico: "👥", label: "Staff & salary", topLabel: "Staff", top: true }]),
    { to: "/menu", ico: "🍔", label: "Menu & stock" },
    { to: "/plans", ico: "💳", label: "Plans" },
    { to: "/settings", ico: "⚙️", label: "Settings", short: "Setup", bottom: true, top: true },
    ...(isAdmin ? [] : [{ to: "/help", ico: helpUnread ? "🔴" : "❓", label: "Help", top: true, alert: helpUnread }]),
  ];
}

let adminLanded = false; // the admin starts on the Admin portal once per app open

function Shell({ children }) {
  const { shop, user, online, sync, syncNow, logout } = useApp();
  const access = accessState(shop);
  const isAdmin = user.role === "admin";
  const isKitchen = user.role === "kitchen";
  const isManager = user.role === "manager";
  const helpUnread = useHelpUnread(!isAdmin && !isKitchen && !isManager);
  const paid = access.state === "paid" || isAdmin;
  const [kitchenAlerts, recheckKitchen] = useKitchenAlerts(true);
  const alertCount = useAlertCount(kitchenAlerts, isKitchen);
  const [alertsOpen, setAlertsOpen] = useState(null); // "drop" (wide screens) | "sheet" (phones)
  // Browsers only play sound after a tap or key press (and phones may pause it again after a
  // call or a while in the background): any tap or key unlocks it whenever it's not running.
  useEffect(() => {
    const events = ["pointerdown", "keydown"];
    const unlock = () => audioReady() || unlockAudio();
    events.forEach((e) => window.addEventListener(e, unlock, true));
    return () => events.forEach((e) => window.removeEventListener(e, unlock, true));
  }, []);
  const { waiting, attention, what, hasTables } = useOrderAlerts(shop, isKitchen);
  const loc = useLocation();
  const nav = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (isAdmin && !adminLanded) {
      adminLanded = true;
      if (loc.pathname === "/") nav("/admin", { replace: true });
    }
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (setMoreOpen(false), setAlertsOpen(null)), [loc.pathname]);
  const links = useNavLinks({ isAdmin, isKitchen, isManager, paid, waiting, helpUnread, kitchenAlerts });
  if (loc.pathname === "/kitchen") return <ToastFree><RingBar attention={attention} what={what} kitchen />{hasTables && !isAdmin && <AlertSetupBar />}{children}<StaffGate /></ToastFree>;
  const onTop = links.some((l) => l.top && !l.bottom && (loc.pathname === l.to || loc.pathname.startsWith(l.to + "/")));
  const inMore = !links.some((l) => l.bottom && (l.to === "/" ? loc.pathname === "/" : loc.pathname === l.to || loc.pathname.startsWith(l.to + "/")));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {shop.logo ? <img src={shop.logo} alt="" /> : <img src="/icon.svg" alt="" />}
          <span>{shop.name}</span>
        </div>
        {(!online || sync.pending > 0) && (
          <button className={"sync-pill" + (online ? "" : " offline")} onClick={() => syncNow()} title="Upload saved bills now">
            {!online ? "Offline" : ""}
            {!online && sync.pending > 0 ? " · " : ""}
            {sync.pending > 0 ? `${sync.pending} bill${sync.pending > 1 ? "s" : ""} to sync` : ""}
          </button>
        )}
        <nav className="nav">
          {links
            .filter((l) => l.top || l.bottom)
            .map((l) => (
              <NavLink key={l.to} to={l.to} end={l.to === "/"} className={(l.bottom ? "in-bottom" : "top-only") + (l.alert ? " alert" : "")}>
                <span className="ico" aria-hidden="true">{l.ico}</span>
                <span className="lbl">
                  <span className="lbl-long">{l.topLabel || l.label}</span>
                  <span className="lbl-short">{l.short || l.label}</span>
                </span>
              </NavLink>
            ))}
          <AlertsButton count={alertCount} open={alertsOpen === "drop"} onClick={() => (stopRinging(), setAlertsOpen(alertsOpen ? null : "drop"))} />
          <button type="button" className={"more-btn" + (isKitchen || isManager ? " keep" : "") + (inMore || moreOpen ? " active" : "") + (onTop && !moreOpen ? " on-top" : "")} onClick={() => setMoreOpen(true)} aria-label="More pages">
            <span className="ico" aria-hidden="true">☰</span>
            <span className="lbl">More</span>
            {(helpUnread || alertCount > 0) && <span className="dot" aria-hidden="true" />}
          </button>
        </nav>
      </header>
      {loc.pathname !== "/orders" && <RingBar attention={attention} what={what} />}
      {hasTables && !isAdmin && <AlertSetupBar />}
      {!isKitchen && !isManager && <AccessBanner access={access} blocked={sync.blocked} />}
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>{children}</Suspense>
      </main>
      <StaffGate />
      {moreOpen && (
        <MoreSheet
          links={links.filter((l) => !l.bottom)}
          shop={shop}
          user={user}
          access={access}
          alertCount={alertCount}
          onAlerts={() => (setMoreOpen(false), setAlertsOpen("sheet"))}
          onClose={() => setMoreOpen(false)}
          onLogout={logout}
        />
      )}
      {alertsOpen && <AlertsPanel sheet={alertsOpen === "sheet"} isKitchen={isKitchen} isOwner={!isKitchen && !isManager} onKitchenChange={recheckKitchen} onClose={() => setAlertsOpen(null)} />}
    </div>
  );
}

// ☰ More: every other page as big tiles, plus the account and Log out.
function MoreSheet({ links, shop, user, access, alertCount, onAlerts, onClose, onLogout }) {
  const loc = useLocation();
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const planLine =
    user.staff ? `Signed in as ${user.staff.name} · ${user.role === "manager" ? "billing manager" : "kitchen"}` : user.role === "kitchen" ? "Kitchen phone (no sales or money)" : access.state === "admin" ? "Admin account" : access.state === "paid" ? `Plan active · ${access.daysLeft} days left` : access.state === "trial" ? `Free trial · ${access.daysLeft} days left` : "Plan ended";
  return (
    <div className="more-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="more-sheet" role="dialog" aria-label="More pages">
        <div className="more-grab" aria-hidden="true" />
        <div className="more-grid">
          <button type="button" className={"more-tile" + (alertCount ? " alert-tile" : "")} onClick={onAlerts}>
            <span className="more-ico" aria-hidden="true">🔔</span>
            <span>{alertCount ? `Alerts (${alertCount})` : "Alerts"}</span>
          </button>
          {links.map((l) => (
            <Link key={l.to} to={l.to} className={"more-tile" + (loc.pathname === l.to || loc.pathname.startsWith(l.to + "/") ? " active" : "")} onClick={onClose}>
              <span className="more-ico" aria-hidden="true">{l.ico}</span>
              <span>{l.label}</span>
            </Link>
          ))}
        </div>
        <div className="more-foot">
          <div className="small">
            <b>{shop.name}</b> · {user.name}
            <div className="muted">{planLine}</div>
          </div>
          <div className="btn-row">
            {user.role === "kitchen" && !user.staff && <button className="btn btn-sm" onClick={() => (signOutStaff(), onClose())}>Switch user</button>}
            <button className="btn btn-sm btn-danger" onClick={() => confirm(user.role === "kitchen" && !user.staff ? "Exit kitchen mode? The owner will need to log in again on this phone." : "Log out of this device?") && onLogout()}>
              {user.role === "kitchen" && !user.staff ? "Exit kitchen mode" : "Log out"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessBanner({ access, blocked }) {
  if (access.state === "expired") {
    return (
      <div className="banner danger">
        Your free trial / plan has ended. You can view your data, but new bills need an active plan.
        <Link to="/plans">Choose a plan →</Link>
      </div>
    );
  }
  if (blocked > 0) {
    return (
      <div className="banner danger">
        {blocked} bill(s) couldn't be saved because the plan ended. <Link to="/plans">Renew</Link> to upload them.
      </div>
    );
  }
  if (access.state === "trial") {
    return (
      <div className={"banner " + (access.daysLeft <= 2 ? "warn" : "info")}>
        Free trial: {access.daysLeft} day{access.daysLeft === 1 ? "" : "s"} left. <Link to="/plans">See plans</Link>
      </div>
    );
  }
  if (access.state === "paid" && access.daysLeft <= 5) {
    return (
      <div className="banner warn">
        Your plan ends in {access.daysLeft} day{access.daysLeft === 1 ? "" : "s"}. <Link to="/plans">Renew now</Link>
      </div>
    );
  }
  return null;
}

// The kitchen screen uses the whole window (no top bar or bottom navigation).
function ToastFree({ children }) {
  return <main className="main kitchen-main">{children}</main>;
}
