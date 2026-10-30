// Settings search: a row matches when every word typed is found in its name, description or keywords.
export function matchSetting(section, query) {
  const words = String(query || "").toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return true;
  const text = [section.title, section.desc, ...(section.keywords || [])].join(" ").toLowerCase();
  const squashed = text.replace(/\s+/g, "");
  return words.every((w) => text.includes(w) || squashed.includes(w));
}
