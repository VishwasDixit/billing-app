// The order link in a message, opening at the table this customer last ordered from.
export function withTable(text, tableId) {
  if (!tableId) return text;
  return text.replace(/(\/order\/[A-Za-z0-9_-]{16,40})(\?[^\s]*)?/g, (_, path, qs) => {
    const p = new URLSearchParams((qs || "").slice(1));
    p.set("t", tableId);
    return `${path}?${p.toString()}`;
  });
}
