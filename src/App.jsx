import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { useApp, accessState } from "./lib/store.jsx";
import { ToastProvider } from "./components/ui.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import FindEmail from "./pages/FindEmail.jsx";
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
import { initOrders, refreshOrders, useOrders, beep } from "./lib/orders.js";
import { useToast } from "./components/ui.jsx";
import { get } from "./lib/api.js";

const Dashboard = lazy(() => import("./pages/Dashboard.jsx")); // charts load on first visit

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
          <Route path="*" element={<Login />} />
        </Routes>
      ) : (
        <Shell>
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
            {session.user.role === "admin" && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
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

// Keeps table orders fresh on every screen and rings when a QR order is waiting.
function useOrderAlerts(shop) {
  const toast = useToast();
  const loc = useLocation();
  const st = useOrders();
  const hasTables = (shop.tables || []).length > 0;
  useEffect(() => {
    initOrders(shop.id).then(() => hasTables && refreshOrders().catch(() => {}));
  }, [shop.id, hasTables]);
  useEffect(() => {
    if (!hasTables) return;
    const t = setInterval(() => document.visibilityState === "visible" && refreshOrders().catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [hasTables]);
  const prev = useRef(st.attention);
  useEffect(() => {
    if (st.attention > prev.current) {
      beep();
      if (loc.pathname !== "/orders") toast(`🔔 ${st.attention} table request${st.attention === 1 ? "" : "s"} waiting (orders, bills or payments). Open Orders.`);
    }
    prev.current = st.attention;
  }, [st.attention]); // eslint-disable-line react-hooks/exhaustive-deps
  return { hasTables, waiting: st.attention };
}

// Page links. `bottom` ones sit in the phone's bottom bar; the rest live in the ☰ More sheet
// (on wide screens all `top` ones show in the top bar).
function useNavLinks({ isAdmin, paid, waiting, helpUnread }) {
  return [
    ...(isAdmin ? [{ to: "/admin", ico: "🛡️", label: "Admin", bottom: true, top: true }] : []),
    { to: "/", ico: "🧾", label: "Billing", bottom: true, top: true },
    { to: "/orders", ico: waiting ? "🔔" : "🍽️", label: waiting ? `Orders (${waiting})` : "Orders", short: waiting ? `${waiting} new` : "Orders", bottom: true, top: true, alert: waiting > 0 },
    { to: "/bills", ico: "📄", label: "Bills", top: true },
    { to: "/customers", ico: "📒", label: "Udhar", top: true },
    { to: "/dashboard", ico: paid ? "📊" : "🔒", label: "Dashboard", top: true },
    { to: "/expenses", ico: "💸", label: "Expenses", top: true },
    { to: "/kitchen", ico: "🍳", label: "Kitchen screen" },
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
  const helpUnread = useHelpUnread(!isAdmin);
  const paid = access.state === "paid" || isAdmin;
  const { waiting } = useOrderAlerts(shop);
  const loc = useLocation();
  const nav = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (isAdmin && !adminLanded) {
      adminLanded = true;
      if (loc.pathname === "/") nav("/admin", { replace: true });
    }
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMoreOpen(false), [loc.pathname]);
  const links = useNavLinks({ isAdmin, paid, waiting, helpUnread });
  if (loc.pathname === "/kitchen") return <ToastFree>{children}</ToastFree>;
  const inMore = !links.some((l) => l.bottom && (l.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(l.to)));

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
                  <span className="lbl-long">{l.label}</span>
                  <span className="lbl-short">{l.short || l.label}</span>
                </span>
              </NavLink>
            ))}
          <button type="button" className={"more-btn" + (inMore || moreOpen ? " active" : "")} onClick={() => setMoreOpen(true)} aria-label="More pages">
            <span className="ico" aria-hidden="true">☰</span>
            <span className="lbl">More</span>
            {helpUnread && <span className="dot" aria-hidden="true" />}
          </button>
        </nav>
      </header>
      <AccessBanner access={access} blocked={sync.blocked} />
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>{children}</Suspense>
      </main>
      {moreOpen && <MoreSheet links={links.filter((l) => !l.bottom)} shop={shop} user={user} access={access} onClose={() => setMoreOpen(false)} onLogout={logout} />}
    </div>
  );
}

// ☰ More: every other page as big tiles, plus the account and Log out.
function MoreSheet({ links, shop, user, access, onClose, onLogout }) {
  const loc = useLocation();
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const planLine =
    access.state === "admin" ? "Admin account" : access.state === "paid" ? `Plan active · ${access.daysLeft} days left` : access.state === "trial" ? `Free trial · ${access.daysLeft} days left` : "Plan ended";
  return (
    <div className="more-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="more-sheet" role="dialog" aria-label="More pages">
        <div className="more-grab" aria-hidden="true" />
        <div className="more-grid">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className={"more-tile" + (loc.pathname.startsWith(l.to) ? " active" : "")} onClick={onClose}>
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
          <button className="btn btn-sm btn-danger" onClick={() => confirm("Log out of this device?") && onLogout()}>Log out</button>
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
