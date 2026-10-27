// Sounds made in code (no sound file). One shared audio context, unlocked by the first tap,
// because browsers block sound until the user has touched the page.
let audio = null;
const audioListeners = new Set();
function ctx() {
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    audio.onstatechange = () => audioListeners.forEach((l) => l());
  }
  return audio;
}
export const audioContext = ctx;
export function unlockAudio() {
  try {
    return ctx().resume();
  } catch {
    /* no audio */
  }
}
// False while the browser still blocks sound (after a reload, before any tap). A device with no
// audio at all counts as ready: there's nothing to unlock.
export function audioReady() {
  try {
    return ctx().state === "running";
  } catch {
    return true;
  }
}
export const onAudioChange = (l) => (audioListeners.add(l), () => audioListeners.delete(l));
export const soundOn = () => {
  try {
    return JSON.parse(localStorage.getItem("alertSound") ?? "true") !== false;
  } catch {
    return true;
  }
};
function tones(list, vol) {
  if (!soundOn()) return;
  try {
    const c = ctx();
    for (const [f, t] of list) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(c.destination);
      g.gain.setValueAtTime(vol, c.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + t + 0.25);
      o.start(c.currentTime + t);
      o.stop(c.currentTime + t + 0.26);
    }
  } catch {
    /* no audio */
  }
}
// Short beep for a new order or table request.
export const beep = () => tones([[880, 0], [1175, 0.18]], 0.25);
// Softer chime for a kitchen alert.
export const chime = () => tones([[660, 0], [523, 0.22]], 0.18);
