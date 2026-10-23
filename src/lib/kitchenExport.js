// Kitchen downloads: shopping list and kitchen report as PDF or Excel (loaded only when used).
const day = () => new Date().toISOString().slice(0, 10);
const safe = (s) => String(s).replace(/[^\w-]+/g, "-").slice(0, 30);

async function pdfTable(title, sub, sections, file) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setFontSize(15);
  doc.text(title, 14, 15);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(sub, 14, 21);
  doc.setTextColor(0);
  let y = 27;
  for (const s of sections) {
    if (!s.body.length) continue;
    if (y > 260) {
      doc.addPage();
      y = 15;
    }
    if (s.title) {
      doc.setFontSize(11);
      doc.text(s.title, 14, y);
      y += 2;
    }
    autoTable(doc, { startY: y, head: [s.head], body: s.body, styles: { fontSize: 9, cellPadding: 1.8 }, headStyles: { fillColor: [15, 118, 110] }, margin: { left: 14, right: 14 }, ...(s.opts || {}) });
    y = doc.lastAutoTable.finalY + 8;
  }
  doc.save(file);
}

async function excel(sheets, file) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  await writeExcelFile(
    sheets.map((s) => ({
      sheet: s.sheet,
      data: [s.head.map((h) => ({ value: h, fontWeight: "bold" })), ...s.body.map((r) => r.map((v) => (v === "" || v == null ? null : v)))],
      stickyRowsCount: 1,
      columns: s.head.map(() => ({ width: 16 })),
    }))
  ).toFile(file);
}

// PDFs use the built-in fonts, which have no ₹ sign: amounts say "Rs".
export function shoppingPdf(shop, list) {
  const groups = list.items.reduce((m, i) => (m[i.category] = [...(m[i.category] || []), i], m), {});
  return pdfTable(
    `${shop.name} · Shopping list`,
    `${new Date().toLocaleDateString("en-IN")} · enough for ${list.coverDays} days · approx. Rs ${list.total}`,
    Object.entries(groups).map(([c, items]) => ({
      title: c,
      head: ["Item", "Buy", "Left now", "Approx. Rs", "Bought"],
      body: items.map((i) => [i.name + (i.urgent ? " (urgent)" : ""), `${i.qty} ${i.unit}`, `${i.stock} ${i.unit}`, i.cost || "", "[  ]"]),
    })),
    `${safe(shop.name)}-shopping-list-${day()}.pdf`
  );
}
export function shoppingExcel(shop, list) {
  return excel([{ sheet: "Shopping list", head: ["Category", "Item", "Buy", "Unit", "Left now", "Per day", "Approx ₹"], body: list.items.map((i) => [i.category, i.name, i.qty, i.unit, i.stock, i.perDay, i.cost]) }], `${safe(shop.name)}-shopping-list-${day()}.xlsx`);
}
export function shoppingText(shop, list) {
  const groups = list.items.reduce((m, i) => (m[i.category] = [...(m[i.category] || []), i], m), {});
  return (
    `*${shop.name} – Shopping list (${new Date().toLocaleDateString("en-IN")})*\n` +
    Object.entries(groups)
      .map(([c, items]) => `\n_${c}_\n` + items.map((i) => `• ${i.name}: ${i.qty} ${i.unit}${i.urgent ? " ⚠️" : ""}`).join("\n"))
      .join("\n") +
    (list.total ? `\n\nApprox. ₹${list.total}` : "")
  );
}

export function reportPdf(shop, r) {
  const t = r.totals;
  return pdfTable(
    `${shop.name} · Kitchen report`,
    `${r.from} to ${r.to}`,
    [
      { head: ["", "Amount"], body: [["Sales", `Rs ${t.sales}`], ["Ingredients used", `Rs ${t.usedCost}`], ["Wasted / expired", `Rs ${t.wasteCost}`], ["Missing in counts", `Rs ${t.missingCost}`], ["Bought", `Rs ${t.purchaseCost}`], ["Food cost %", t.foodCostPct == null ? "-" : `${t.foodCostPct}%`]] },
      { title: "Ingredients", head: ["Item", "Used", "Rs", "Wasted", "Rs", "Missing", "Bought"], body: r.rows.map((x) => [x.name, `${x.used} ${x.unit}`, x.usedCost, x.wasted ? `${x.wasted} ${x.unit}` : "", x.wasteCost || "", x.missing ? `${x.missing} ${x.unit}` : "", x.purchased ? `${x.purchased} ${x.unit}` : ""]) },
      { title: "Waste", head: ["When", "Item", "Qty", "Why", "Rs", "By"], body: r.waste.map((w) => [new Date(w.at).toLocaleString("en-IN"), w.name, `${w.qty} ${w.unit}`, w.reason, w.cost, w.by]) },
    ],
    `${safe(shop.name)}-kitchen-report-${r.from}-to-${r.to}.pdf`
  );
}
export function reportExcel(shop, r) {
  return excel(
    [
      { sheet: "Ingredients", head: ["Item", "Unit", "Used", "Used ₹", "Wasted", "Waste ₹", "Missing", "Missing ₹", "Bought", "Bought ₹"], body: r.rows.map((x) => [x.name, x.unit, x.used, x.usedCost, x.wasted, x.wasteCost, x.missing, x.missingCost, x.purchased, x.purchaseCost]) },
      { sheet: "Waste", head: ["When", "Item", "Qty", "Unit", "Why", "₹", "By"], body: r.waste.map((w) => [new Date(w.at).toLocaleString("en-IN"), w.name, w.qty, w.unit, w.reason, w.cost, w.by]) },
    ],
    `${safe(shop.name)}-kitchen-report-${r.from}-to-${r.to}.xlsx`
  );
}
