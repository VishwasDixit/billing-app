// Downloads the admin's shop list (as filtered on screen) as Excel or PDF.
// Both libraries load only when the admin asks for a file.

const statusText = (s) => (s.blocked ? "Blocked" : { trial: "Trial", paid: "Paying", expired: "Expired", admin: "Admin" }[s.status.state] || s.status.state);
const day = (d) => (d ? new Date(d) : null);
const fmt = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

export const COLUMNS = [
  { header: "Shop", width: 24, value: (s) => s.name },
  { header: "Owner", width: 18, value: (s) => s.owner?.name || "" },
  { header: "Email", width: 28, value: (s) => s.owner?.email || "" },
  { header: "Phone", width: 14, value: (s) => s.owner?.phone || "" },
  { header: "Status", width: 10, value: statusText },
  { header: "Plan", width: 9, value: (s) => (s.status.plan === "yearly" ? "Yearly" : s.status.plan === "monthly" ? "Monthly" : "") },
  { header: "Access till", width: 13, date: true, value: (s) => day(s.status.endsAt) },
  { header: "Days left", width: 9, value: (s) => s.status.daysLeft },
  { header: "Price /month", width: 12, value: (s) => s.prices.monthly },
  { header: "Price /year", width: 11, value: (s) => s.prices.yearly },
  { header: "Bills", width: 8, value: (s) => s.bills },
  { header: "Sales (₹)", width: 12, value: (s) => Math.round(s.sales * 100) / 100 },
  { header: "Last bill", width: 13, date: true, value: (s) => day(s.lastBillAt) },
  { header: "Joined", width: 13, date: true, value: (s) => day(s.createdAt) },
  { header: "Blocked reason", width: 22, value: (s) => s.blocked?.reason || "" },
];

const fileName = (ext) => `shopkeepers-${new Date().toISOString().slice(0, 10)}.${ext}`;

export async function downloadExcel(shops) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const header = COLUMNS.map((c) => ({ value: c.header, fontWeight: "bold" }));
  const rows = shops.map((s) =>
    COLUMNS.map((c) => {
      const v = c.value(s);
      if (c.date) return v ? { value: v, type: Date, format: "dd mmm yyyy" } : null;
      return v === "" ? null : v;
    })
  );
  await writeExcelFile([header, ...rows], { columns: COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1, sheet: "Shopkeepers" }).toFile(fileName("xlsx"));
}

export async function downloadPdf(shops, { title = "Shopkeepers" } = {}) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  // The built-in PDF fonts have no ₹ sign, so amounts say "Rs".
  const cols = COLUMNS.filter((c) => !["Plan", "Price /year", "Joined", "Blocked reason"].includes(c.header));
  doc.setFontSize(14);
  doc.text(title, 14, 14);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${shops.length} shop${shops.length === 1 ? "" : "s"} · downloaded ${new Date().toLocaleString("en-IN")}`, 14, 20);
  autoTable(doc, {
    startY: 25,
    head: [cols.map((c) => c.header.replace("₹", "Rs"))],
    body: shops.map((s) =>
      cols.map((c) => {
        const v = c.value(s);
        if (c.date) return fmt(v);
        if (c.header.startsWith("Price") || c.header.startsWith("Sales")) return "Rs " + Number(v).toLocaleString("en-IN");
        return String(v ?? "");
      })
    ),
    styles: { fontSize: 8, cellPadding: 1.8, overflow: "linebreak" },
    headStyles: { fillColor: [15, 118, 110] },
    alternateRowStyles: { fillColor: [245, 247, 248] },
    didParseCell: (d) => {
      if (d.section === "body" && d.column.index === cols.findIndex((c) => c.header === "Status")) {
        const v = d.cell.raw;
        d.cell.styles.textColor = v === "Paying" ? [22, 128, 61] : v === "Expired" || v === "Blocked" ? [190, 40, 40] : [15, 118, 110];
        d.cell.styles.fontStyle = "bold";
      }
    },
  });
  doc.save(fileName("pdf"));
}

// One shop's full data (from /admin/shops/:id/export) as a workbook, one sheet per kind.
export async function downloadShopData(d) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const dt = (v) => (v ? { value: new Date(v), type: Date, format: "dd mmm yyyy hh:mm" } : null);
  const b = (v) => ({ value: v, fontWeight: "bold" });
  const sheet = (name, header, rows) => ({ sheet: name, data: [header.map(b), ...rows], stickyRowsCount: 1, columns: header.map(() => ({ width: 18 })) });
  const s = d.shop;
  const owner = d.users[0] || {};
  const sheets = [
    sheet("Shop", ["Field", "Value"], [
      ["Shop name", s.name], ["Owner", owner.name || ""], ["Email", owner.email || ""], ["Phone", owner.phone || ""],
      ["Address", s.address || ""], ["GSTIN", s.gstin || ""], ["UPI ID", s.upiId || ""],
      ["Joined", dt(s.createdAt)], ["Trial ends", dt(s.trialEndsAt)], ["Plan ends", dt(s.subscription?.currentPeriodEnd)],
      ["Exported", dt(d.exportedAt)],
    ].map(([k, v]) => [k, v ?? ""])),
    sheet("Menu", ["Item", "Category", "Prices", "Active"], d.menu.map((m) => [m.name, m.category || "", m.variants.map((v) => `${v.label ? v.label + " " : ""}${v.price}`).join(" / "), m.active !== false ? "yes" : "no"])),
    sheet("Bills", ["Date", "Bill no", "Items", "Subtotal", "Discount", "GST", "Total", "Payment", "Status", "Customer"], d.bills.map((x) => [
      dt(x.createdAt), x.billNo, x.itemCount ?? x.items.length, x.subtotal, x.discount?.amount || 0, x.gst?.amount || 0, x.total, x.paymentMode, x.status, x.customer?.name || "",
    ])),
    sheet("Bill items", ["Date", "Bill no", "Item", "Variant", "Qty", "Rate", "Amount"], d.bills.flatMap((x) => x.items.map((i) => [dt(x.createdAt), x.billNo, i.name, i.variant || "", i.qty, i.rate, i.amount ?? i.qty * i.rate]))),
    sheet("Udhar customers", ["Name", "Phone", "Address", "Note"], d.customers.map((c) => [c.name, c.phone || "", c.address || "", c.note || ""])),
    sheet("Udhar payments", ["Date", "Customer", "Amount", "Mode", "Note"], d.customerPayments.map((p) => [dt(p.createdAt), d.customers.find((c) => c.clientId === p.customerClientId)?.name || "", p.amount, p.mode || "", p.note || ""])),
    sheet("Expenses", ["Date", "Category", "Amount", "Paid by", "Note"], d.expenses.map((e) => [e.date, e.category, e.amount, e.paymentMode || "", e.note || ""])),
    sheet("Plan payments", ["Date", "Plan", "Amount", "Method", "Reference", "Status"], d.payments.map((p) => [dt(p.createdAt), p.plan, p.amount, p.method, p.utr || p.razorpayPaymentId || "", p.status])),
    sheet("Help", ["Date", "Subject", "From", "Message"], d.help.flatMap((t) => t.messages.map((m) => [dt(m.at), t.subject, m.from, m.text]))),
  ].map((sh) => ({ ...sh, data: sh.data.map((row) => row.map((v) => (v === "" || v === undefined ? null : v))) }));
  const safe = String(s.name).replace(/[^\w-]+/g, "-").slice(0, 40);
  await writeExcelFile(sheets).toFile(`${safe}-data-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
