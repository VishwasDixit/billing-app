// Light / Dark / Auto (follow the phone) theme, saved on this device.
import { useEffect, useState } from "react";

const KEY = "theme";
const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

export function readTheme() {
  try {
    return localStorage.getItem(KEY) || "light";
  } catch {
    return "light";
  }
}

const resolve = (pref) => (pref === "auto" ? (media()?.matches ? "dark" : "light") : pref);

export function applyTheme(pref = readTheme()) {
  const mode = resolve(pref);
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", mode === "dark" ? "#111418" : "#0f766e");
  return mode;
}

// Applies the saved theme now, and follows the phone's setting while on "auto".
export function startTheme() {
  applyTheme();
  media()?.addEventListener?.("change", () => readTheme() === "auto" && applyTheme("auto"));
}

export const isDark = () => document.documentElement.dataset.theme === "dark";

export function useTheme() {
  const [pref, setPref] = useState(readTheme);
  useEffect(() => {
    applyTheme(pref);
  }, [pref]);
  const set = (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode: still applies for this visit */
    }
    setPref(v);
  };
  return [pref, set];
}
