// Bill arithmetic shared by the browser and the API, so stored totals always
// match what was printed.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param {Array<{rate:number, qty:number}>} items
 * @param {{type:'percent'|'flat', value:number}} discount
 * @param {number} gstPercent
 */
export function computeTotals(items, discount = { type: "percent", value: 0 }, gstPercent = 0) {
  const lines = items.map((it) => ({ ...it, amount: round2(it.rate * it.qty) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));

  const dVal = Math.max(0, Number(discount?.value) || 0);
  const dType = discount?.type === "flat" ? "flat" : "percent";
  let discountAmount = dType === "percent" ? (subtotal * Math.min(dVal, 100)) / 100 : dVal;
  discountAmount = round2(Math.min(discountAmount, subtotal));

  const taxable = round2(subtotal - discountAmount);
  const gstPct = Math.max(0, Number(gstPercent) || 0);
  const gst = round2((taxable * gstPct) / 100);
  const total = round2(taxable + gst);

  return {
    lines,
    subtotal,
    discount: { type: dType, value: dVal, amount: discountAmount },
    taxable,
    gst: { percent: gstPct, amount: gst },
    total,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
  };
}
