import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/store.jsx";
import { StaffBar } from "../components/StaffPin.jsx";
import Stock from "./kitchen/Stock.jsx";
import Recipes from "./kitchen/Recipes.jsx";
import { Alerts, Shopping, Report } from "./kitchen/Panels.jsx";

// Kitchen management: stock, recipes, alerts, shopping list and (owner) the kitchen report.
export default function KitchenManage() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const owner = user.role !== "kitchen";
  const tabs = [
    ["stock", "🥫 Stock"],
    ["recipes", "📖 Recipes"],
    ["alerts", "🔔 Alerts"],
    ["shopping", "🛒 Shopping list"],
    ...(owner ? [["report", "📊 Report"]] : []),
  ];
  const tab = tabs.some(([k]) => k === params.get("tab")) ? params.get("tab") : "stock";
  const [alertCount, setAlertCount] = useState(null);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Kitchen</h1>
        <div className="btn-row">
          <StaffBar />
          <Link className="btn btn-sm" to="/kitchen">🍳 Order board</Link>
        </div>
      </div>
      <div className="admin-tabs" style={{ marginBottom: 12 }}>
        <div className="seg" role="tablist">
          {tabs.map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setParams({ tab: k }, { replace: true })}>
              {l}{k === "alerts" && alertCount ? ` (${alertCount})` : ""}
            </button>
          ))}
        </div>
      </div>
      {tab === "stock" && <Stock />}
      {tab === "recipes" && <Recipes />}
      {tab === "alerts" && <Alerts onCount={setAlertCount} />}
      {tab === "shopping" && <Shopping />}
      {tab === "report" && owner && <Report />}
    </div>
  );
}
