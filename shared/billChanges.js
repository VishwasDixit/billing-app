// Editing and deleting saved bills: shared by the server and the app so the wording matches.
export const BIN_DAYS = 30; // deleted bills leave the bin by themselves after this
export const FREE_CHANGE_DAYS = 7; // older bills need the owner PIN

// foodMade: the usual answer to "Was the food made?" (no → stock goes back on the shelf).
export const DELETE_REASONS = {
  cancelled: { label: "Customer cancelled / left", foodMade: false },
  wrong: { label: "Wrong order / wrong items", foodMade: false },
  duplicate: { label: "Duplicate bill", foodMade: false },
  nopay: { label: "Payment not received", foodMade: true },
  complaint: { label: "Food complaint / returned", foodMade: true },
  test: { label: "Test or training bill", foodMade: false },
  other: { label: "Other", foodMade: true },
};

export const EDIT_REASONS = {
  items: "Wrong item or quantity",
  price: "Price or discount",
  payment: "Payment mode",
  added: "Customer added items",
  other: "Other",
};

export const isOldBill = (bill, now = Date.now()) => now - new Date(bill.createdAt) > FREE_CHANGE_DAYS * 864e5;
