// Salary slip (PDF) and the month's attendance + salary sheet (Excel).
import { ATTENDANCE, daysInMonth } from "../../shared/salary.js";

const monthName = (m) => new Date(m + "-01T12:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export async function salarySlipPdf(shop, worker, s, records, adjustments = []) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a5" });
  doc.setFontSize(14);
  doc.text(shop.name, 12, 14);
  doc.setFontSize(10);
  doc.text(`Salary slip · ${monthName(s.month)}`, 12, 20);
  doc.setTextColor(100);
  doc.text(`${worker.name} · ${worker.role}${worker.phone ? ` · ${worker.phone}` : ""}`, 12, 26);
  doc.setTextColor(0);
  const rs = (n) => `Rs ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  autoTable(doc, {
    startY: 31,
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: [15, 118, 110] },
    head: [["", ""]],
    showHead: "never",
    body: [
      ["Wage", worker.wageType === "daily" ? `${rs(worker.wage)} per day` : `${rs(worker.wage)} per month`],
      ["Days present", `${s.count.present}`],
      ["Half days", `${s.count.half}`],
      ["Week offs / paid leave", `${s.count.weekoff} / ${s.count.paidleave}`],
      ["Absent / unpaid leave", `${s.count.absent} / ${s.count.leave}`],
      ["Paid days", `${s.paidDays} of ${s.daysInMonth}`],
      ["Earned", rs(s.earned)],
      ["Overtime", `${s.otHours} h · ${rs(s.overtime)}`],
      ...adjustments.map((a) => [a.amount > 0 ? `Bonus: ${a.note}` : `Deduction: ${a.note}`, `${a.amount > 0 ? "+" : "-"} ${rs(Math.abs(a.amount))}`]),
      ["Advances taken", `- ${rs(s.advance)}`],
      ["Already paid", `- ${rs(s.paid)}`],
      [{ content: "Payable", styles: { fontStyle: "bold" } }, { content: rs(s.payable), styles: { fontStyle: "bold" } }],
    ],
    columnStyles: { 1: { halign: "right" } },
    margin: { left: 12, right: 12 },
  });
  const y = doc.lastAutoTable.finalY + 6;
  const dim = daysInMonth(s.month);
  const byDate = new Map(records.map((r) => [Number(r.date.slice(8)), r.status]));
  doc.setFontSize(8);
  doc.text("Attendance: " + Array.from({ length: dim }, (_, i) => `${i + 1}:${ATTENDANCE[byDate.get(i + 1)]?.short || "-"}`).join("  "), 12, y, { maxWidth: 124 });
  doc.text("Signature: ____________________", 12, y + 22);
  doc.save(`${worker.name.replace(/\W+/g, "-")}-salary-${s.month}.pdf`);
}

export async function monthSheetExcel(shop, month, staff, records, salary, adjustments = []) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const dim = daysInMonth(month);
  const days = Array.from({ length: dim }, (_, i) => String(i + 1));
  const att = [
    ["Worker", ...days, "Paid days"].map((v) => ({ value: v, fontWeight: "bold" })),
    ...staff.map((w) => {
      const byDate = new Map(records.filter((r) => r.staffId === w.id).map((r) => [Number(r.date.slice(8)), r.status]));
      return [w.name, ...days.map((d) => ATTENDANCE[byDate.get(Number(d))]?.short || null), salary[w.id]?.paidDays ?? null];
    }),
  ];
  const pay = [
    ["Worker", "Role", "Wage", "Type", "Paid days", "Earned", "OT hours", "Overtime", "Bonus", "Deductions", "Advances", "Paid", "Payable"].map((v) => ({ value: v, fontWeight: "bold" })),
    ...staff.map((w) => {
      const s = salary[w.id];
      return [w.name, w.role, w.wage, w.wageType, s.paidDays, s.earned, s.otHours, s.overtime, s.bonus || 0, s.deduction || 0, s.advance, s.paid, s.payable];
    }),
  ];
  await writeExcelFile([
    { sheet: "Attendance", data: att, stickyRowsCount: 1, columns: [{ width: 16 }, ...days.map(() => ({ width: 4 })), { width: 10 }] },
    { sheet: "Salary", data: pay, stickyRowsCount: 1, columns: pay[0].map(() => ({ width: 12 })) },
    ...(adjustments.length
      ? [{
          sheet: "Bonus & deductions",
          data: [
            ["Worker", "Type", "Reason", "Amount"].map((v) => ({ value: v, fontWeight: "bold" })),
            ...adjustments.map((a) => [staff.find((w) => w.id === a.staffId)?.name || a.staffName, a.amount > 0 ? "Bonus" : "Deduction", a.note, a.amount]),
          ],
          columns: [{ width: 16 }, { width: 12 }, { width: 28 }, { width: 12 }],
        }]
      : []),
  ]).toFile(`${shop.name.replace(/\W+/g, "-")}-staff-${month}.xlsx`);
}
