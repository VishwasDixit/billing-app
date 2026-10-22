// Dashboard reports for shop owners (paid plans): Profit & Loss as PDF, and the same
// data plus every bill as Excel. Libraries load only when a report is downloaded.
import { get } from "./api.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (g) => (g === null || g === undefined ? "new" : `${g > 0 ? "+" : ""}${g}%`);
const dmy = (ymd) => new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const modeName = (m) => (m === "credit" ? "Udhar" : String(m || "").toUpperCase());
const fileBase = (shop, range) => `${String(shop.name).replace(/[^\w-]+/g, "-").slice(0, 30)}-report-${range[0]}-to-${range[1]}`;

function summaryRows(d) {
  const t = d.totals;
  const rows = [
    ["Sales", t.sales, pct(d.growth.sales)],
    ["Bills", t.bills, pct(d.growth.bills)],
    ["Average bill", t.avgBill, ""],
    ["Items sold", t.items, ""],
    ["Discounts given", t.discount, ""],
    ["GST collected", t.gst, ""],
    ["Expenses", t.expenses, pct(d.growth.expenses)],
    [t.profit < 0 ? "LOSS" : "PROFIT", t.profit, pct(d.growth.profit)],
  ];
  if (d.credit) rows.push(["Udhar given", d.credit.given, ""], ["Udhar collected", d.credit.collected, ""], ["Udhar outstanding (all time)", d.credit.outstanding, ""]);
  return rows;
}

// The built-in PDF fonts have no ₹ sign, so the PDF writes "Rs".
export async function downloadReportPdf(shop, d, range) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const rs = (n) => "Rs " + r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const head = { fillColor: [15, 118, 110] };
  const styles = { fontSize: 9, cellPadding: 1.8 };
  let y = 14;
  doc.setFontSize(15);
  doc.text(shop.name, 14, y);
  doc.setFontSize(9);
  doc.setTextColor(100);
  y += 6;
  doc.text([`Profit & Loss report · ${dmy(range[0])} to ${dmy(range[1])}`, shop.gstin ? `GSTIN: ${shop.gstin}` : "", `Downloaded ${new Date().toLocaleString("en-IN")}`].filter(Boolean), 14, y);
  doc.setTextColor(0);
  y += shop.gstin ? 14 : 10;

  const section = (title, columns, body, opts = {}) => {
    if (!body.length) return;
    if (y > 260) {
      doc.addPage();
      y = 14;
    }
    doc.setFontSize(11);
    doc.text(title, 14, y);
    autoTable(doc, { startY: y + 2, head: [columns], body, styles, headStyles: head, margin: { left: 14, right: 14 }, ...opts });
    y = doc.lastAutoTable.finalY + 8;
  };

  section(
    "Summary",
    ["", "Amount", `vs previous (${dmy(d.range.prevFrom)} – ${dmy(d.range.prevTo)})`],
    summaryRows(d).map(([k, v, g]) => [k, typeof v === "number" && !/Bills|Items/.test(k) ? rs(v) : String(v), g]),
    {
      columnStyles: { 1: { halign: "right" } },
      didParseCell: (c) => {
        if (c.section === "body" && /PROFIT|LOSS/.test(c.row.raw[0])) {
          c.cell.styles.fontStyle = "bold";
          c.cell.styles.textColor = d.totals.profit < 0 ? [190, 40, 40] : [22, 128, 61];
        }
      },
    }
  );
  section(
    "Day by day",
    ["Date", "Bills", "Sales", "Expenses", "Profit"],
    [...d.days.map((x) => [dmy(x.date), x.bills, rs(x.sales), rs(x.expenses), rs(x.profit)]), ["Total", d.totals.bills, rs(d.totals.sales), rs(d.totals.expenses), rs(d.totals.profit)]],
    { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } }, didParseCell: (c) => c.section === "body" && c.row.index === d.days.length && (c.cell.styles.fontStyle = "bold") }
  );
  section("Payment modes", ["Mode", "Bills", "Sales"], d.payments.map((p) => [modeName(p.mode), p.bills, rs(p.sales)]), { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } } });
  section("Top items", ["Item", "Qty", "Sales"], d.topItems.slice(0, 20).map((i) => [i.name, i.qty, rs(i.revenue)]), { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } } });
  section("Sales by category", ["Category", "Qty", "Sales"], d.categories.map((c) => [c.category, c.qty, rs(c.revenue)]), { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } } });
  section("Expenses by category", ["Category", "Amount"], (d.expenseCategories || []).map((e) => [e.category || "Other", rs(e.amount)]), { columnStyles: { 1: { halign: "right" } } });

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text("Profit = sales - expenses. Void bills are not counted.", 14, Math.min(y, 288));
  doc.save(fileBase(shop, range) + ".pdf");
}

export async function downloadReportExcel(shop, d, range) {
  const [{ default: writeExcelFile }, { bills }] = await Promise.all([import("write-excel-file/browser"), get(`/bills?from=${range[0]}&to=${range[1]}&limit=5000`)]);
  const b = (v) => ({ value: v, fontWeight: "bold" });
  const sheet = (name, header, rows, widths) => ({
    sheet: name,
    data: [header.map(b), ...rows.map((row) => row.map((v) => (v === "" || v === undefined ? null : v)))],
    stickyRowsCount: 1,
    columns: header.map((_, i) => ({ width: widths?.[i] ?? 14 })),
  });
  const date = (ymd) => ({ value: new Date(ymd + "T00:00:00"), type: Date, format: "dd mmm yyyy" });
  const sheets = [
    sheet("Summary", ["", "Amount", "vs previous period"], [
      [`${shop.name} · ${range[0]} to ${range[1]}`, "", ""],
      ...summaryRows(d).map(([k, v, g]) => [k, typeof v === "number" ? r2(v) : v, g]),
    ], [30, 14, 18]),
    sheet("Daily", ["Date", "Bills", "Sales", "Expenses", "Profit"], d.days.map((x) => [date(x.date), x.bills, x.sales, x.expenses, x.profit])),
    sheet("Items", ["Item", "Qty", "Sales"], d.topItems.map((i) => [i.name, i.qty, i.revenue]), [30, 10, 14]),
    sheet("Categories", ["Category", "Qty", "Sales"], d.categories.map((c) => [c.category, c.qty, c.revenue]), [24, 10, 14]),
    sheet("Payments", ["Mode", "Bills", "Sales"], d.payments.map((p) => [modeName(p.mode), p.bills, p.sales])),
    sheet("Expenses", ["Category", "Amount"], (d.expenseCategories || []).map((e) => [e.category || "Other", e.amount]), [24, 14]),
    sheet(
      "Bills",
      ["Date", "Bill no", "Items", "Subtotal", "Discount", "GST", "Total", "Payment", "Status", "Customer"],
      bills.map((x) => [
        { value: new Date(x.createdAt), type: Date, format: "dd mmm yyyy hh:mm" },
        x.billNo,
        x.items.map((i) => `${i.qty}x ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", "),
        x.subtotal,
        x.discount?.amount || 0,
        x.gst?.amount || 0,
        x.total,
        modeName(x.paymentMode),
        x.status,
        x.customer?.name || "",
      ]),
      [18, 10, 40, 10, 10, 10, 10, 10, 8, 16]
    ),
  ];
  await writeExcelFile(sheets).toFile(fileBase(shop, range) + ".xlsx");
}
