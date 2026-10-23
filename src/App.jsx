import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, Link, useLocation } from "react-router-dom";
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
  const prev = useRef(st.waiting);
  useEffect(() => {
    if (st.waiting > prev.current) {
      beep();
      if (loc.pathname !== "/orders") toast(`🔔 New table order (${st.waiting} waiting). Open Orders to accept.`);
    }
    prev.current = st.waiting;
  }, [st.waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  return { hasTables, waiting: st.waiting };
}

function Shell({ children }) {
  const { shop, user, online, sync, syncNow } = useApp();
  const access = accessState(shop);
  const isAdmin = user.role === "admin";
  const helpUnread = useHelpUnread(!isAdmin);
  const paid = access.state === "paid" || isAdmin;
  const { waiting } = useOrderAlerts(shop);
  const loc = useLocation();
  if (loc.pathname === "/kitchen") return <ToastFree>{children}</ToastFree>;
  const links = [
    ["/", "🧾", "Billing"],
    ["/orders", waiting ? "🔔" : "🍽️", waiting ? `Orders (${waiting})` : "Orders", waiting ? `${waiting} new` : "Orders"],
    ["/bills", "📄", "Bills"],
    ["/customers", "📒", "Udhar"],
    ["/dashboard", paid ? "📊" : "🔒", "Dashboard", "Stats"],
    ["/expenses", "💸", "Expenses", "Costs"],
    ["/settings", "⚙️", "Settings", "Setup"],
    ...(isAdmin ? [["/admin", "🛡️", "Admin"]] : [["/help", helpUnread ? "🔴" : "❓", "Help"]]),
  ];

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
          {links.map(([to, ico, label, short]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <span className="ico" aria-hidden="true">{ico}</span>
              <span className="lbl">
                <span className="lbl-long">{label}</span>
                <span className="lbl-short">{short || label}</span>
              </span>
            </NavLink>
          ))}
        </nav>
      </header>
      <AccessBanner access={access} blocked={sync.blocked} />
      <main className="main">
        <Suspense fallback={<div className="empty">Loading…</div>}>{children}</Suspense>
      </main>
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
