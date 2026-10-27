// Sounds made in code (no sound file). One shared audio context, unlocked by the first tap,
// because browsers block sound until the user has touched the page.
let audio = null;
function ctx() {
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  return audio;
}
export const audioContext = ctx;
export function unlockAudio() {
  try {
    ctx().resume();
  } catch {
    /* no audio */
  }
}
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
