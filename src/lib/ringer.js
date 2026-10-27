// The order bell: a struck bell made in code that keeps ringing until staff stop it (or rings
// once, by device choice), the flashing tab title, and when the next reminder is due.
import { useSyncExternalStore } from "react";
import { audioContext, soundOn } from "./sound.js";

const pref = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
// Device choices (Alerts panel): ring until stopped or once, and remind every N minutes (0 = off).
export const bellLoops = () => pref("bellMode", "loop") !== "once";
export const remindMinutes = () => Number(pref("remindMin", 5)) || 0;

// When the next reminder rings: N minutes after the last ring or stop, while something waits.
export function nextReminderAt({ lastAlertAt, intervalMin, attention }) {
  if (!attention || !intervalMin || !lastAlertAt) return null;
  return lastAlertAt + intervalMin * 60e3;
}

// One "ding-ding-ding": each strike is a few inharmonic partials with a quick attack and a long
// fade, like a counter bell. Vibrates phones too.
export function bell({ force = false } = {}) {
  if (!force && !soundOn()) return;
  try {
    const c = audioContext();
    const out = c.createGain();
    out.gain.value = 0.9;
    out.connect(c.destination);
    for (let s = 0; s < 3; s++) {
      const at = c.currentTime + s * 0.38;
      for (const [ratio, vol, len] of [[1, 0.5, 1.3], [2.76, 0.22, 0.8], [5.4, 0.1, 0.45], [8.93, 0.04, 0.25]]) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = "sine";
        o.frequency.value = 1320 * ratio;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(vol, at + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, at + len);
        o.connect(g);
        g.connect(out);
        o.start(at);
        o.stop(at + len + 0.05);
      }
    }
  } catch {
    /* no audio on this device */
  }
  try {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
  } catch {
    /* no vibration */
  }
}

// ---- Ringing state (shared by the app shell, the alert bar and the Orders screen) ----
let state = { ringing: false, lastAlertAt: 0 };
const listeners = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
let loop = null;
let safety = null;
let flash = null;
const SAFETY_MS = 2 * 60e3;

function flashTitle(on) {
  clearInterval(flash);
  flash = null;
  if (typeof document === "undefined") return;
  const base = document.title.replace(/^🔔 New order! · /, "");
  document.title = base;
  if (!on) return;
  let alt = false;
  flash = setInterval(() => {
    alt = !alt;
    document.title = alt ? `🔔 New order! · ${base}` : base;
  }, 1000);
}

// Rings now: until stopped (with a 2-minute safety stop) or just once, as this device chose.
export function startRinging() {
  bell();
  const now = Date.now();
  if (!bellLoops()) return set({ lastAlertAt: now });
  clearInterval(loop);
  clearTimeout(safety);
  loop = setInterval(bell, 3000);
  safety = setTimeout(() => stopRinging(), SAFETY_MS);
  flashTitle(true);
  set({ ringing: true, lastAlertAt: now });
}

// Someone saw it: quiet now; the next reminder counts from here.
export function stopRinging() {
  clearInterval(loop);
  clearTimeout(safety);
  loop = safety = null;
  flashTitle(false);
  set({ ringing: false, lastAlertAt: state.ringing || state.lastAlertAt ? Date.now() : 0 });
}

// Nothing waits any more: quiet, and no reminder pending.
export function clearRinging() {
  stopRinging();
  set({ lastAlertAt: 0 });
}

export const ringerState = () => state;
export function useRinger() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state
  );
}
