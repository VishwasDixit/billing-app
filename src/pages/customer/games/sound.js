// Soft little sound effects for the games, made on the fly with Web Audio (no sound files,
// so they work offline). Off when muted (saved on this phone) or when the page is hidden.
const KEY = "coGameSound";
let ctx = null;
let master = null;
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
})();
const listeners = new Set();

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem(KEY, m ? "off" : "on");
  } catch {
    /* private mode */
  }
  if (master) master.gain.value = m ? 0 : VOLUME;
  listeners.forEach((f) => f(m));
}
export const onMuteChange = (f) => (listeners.add(f), () => listeners.delete(f));

// The audio context starts on the first tap (phones only allow sound after one). Everything goes
// through a gentle low-pass and a compressor, so no sound is sharp or suddenly loud.
const VOLUME = 0.32;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    const soften = ctx.createBiquadFilter();
    soften.type = "lowpass";
    soften.frequency.value = 2800;
    soften.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    master.connect(soften).connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
if (typeof window !== "undefined") {
  const unlock = () => audio();
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });
}

const ok = () => !muted && !(typeof document !== "undefined" && document.hidden) && audio();

// A soft, rounded note: a sine with a quiet overtone, a short fade-in (no click) and a smooth
// fade-out, like a marimba or a wood block. Pitch can glide from f1 to f2.
function tone(f1, f2, len, vol = 0.2, delay = 0, type = "sine") {
  const a = ok();
  if (!a) return;
  const t = a.currentTime + delay;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + Math.min(0.012, len / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  g.connect(master);
  for (const [mult, share] of [[1, 1], [2, 0.18]]) {
    const o = a.createOscillator();
    const og = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1 * mult, t);
    if (f2 !== f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2 * mult), t + len);
    og.gain.value = share;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + len + 0.03);
  }
}

// A soft puff of noise (dice, bumps), filtered low so it sounds like a thud, not a hiss.
function noise(len, vol = 0.15, f1 = 1200, f2 = 200, delay = 0) {
  const a = ok();
  if (!a) return;
  const t = a.currentTime + delay;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(f1, t);
  f.frequency.exponentialRampToValueAtTime(f2, t + len);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

// A little tune: [pitch, start, length] notes, each one ringing out softly.
const notes = (list, vol = 0.16, type = "sine") => list.forEach(([f, at, len]) => tone(f, f, len, vol, at, type));

// Pitches (a calm major-pentatonic, so tunes never sound sour).
const C5 = 523, D5 = 587, E5 = 659, G5 = 784, A5 = 880, C6 = 1047;
const G4 = 392, E4 = 330, D4 = 294, C4 = 262;

export const sfx = {
  beep: () => tone(A5 / 2, A5 / 2, 0.18, 0.14),
  go: () => notes([[C5, 0, 0.35], [G5, 0, 0.35]], 0.12),
  blip: () => tone(E5, E5, 0.12, 0.08),
  tick: () => tone(G4, G4, 0.07, 0.07, 0, "triangle"),
  coin: () => notes([[E5, 0, 0.18], [A5, 0.07, 0.3]], 0.11),
  eat: () => tone(C5, E5, 0.12, 0.11),
  bonus: () => notes([[C5, 0, 0.2], [E5, 0.08, 0.2], [G5, 0.16, 0.35]], 0.11),
  crash: () => (noise(0.45, 0.2, 700, 90), tone(150, 70, 0.4, 0.14)),
  roll: () => [0, 0.07, 0.15, 0.24, 0.34].forEach((d, i) => (noise(0.05, 0.12 - i * 0.015, 1600, 500, d), tone(320 + i * 40, 280, 0.05, 0.04, d, "triangle"))),
  move: () => (noise(0.06, 0.12, 900, 250), tone(D4, C4 * 0.9, 0.1, 0.12)),
  capture: () => (noise(0.1, 0.16, 1000, 200), tone(G4, D4, 0.22, 0.13)),
  check: () => notes([[E5, 0, 0.22], [C5, 0.12, 0.3]], 0.11),
  home: () => notes([[C5, 0, 0.25], [E5, 0.12, 0.25], [G5, 0.24, 0.25], [C6, 0.36, 0.5]], 0.1),
  win: () => notes([[C5, 0, 0.3], [E5, 0.14, 0.3], [G5, 0.28, 0.3], [A5, 0.42, 0.3], [G5, 0.58, 0.25], [C6, 0.72, 0.8]], 0.1),
  lose: () => notes([[G4, 0, 0.35], [E4, 0.22, 0.35], [D4, 0.44, 0.35], [C4, 0.66, 0.8]], 0.11),
  pok: () => tone(D5, D5 * 0.92, 0.08, 0.12),
  wall: () => tone(G4, G4, 0.06, 0.07, 0, "triangle"),
  point: () => notes([[G5, 0, 0.25], [E5, 0.12, 0.4]], 0.09),
};

// A steady engine hum whose pitch follows the speed. Returns { set(speed), stop() }.
export function engine() {
  // A low, quiet purr in the background rather than a buzz: two soft waves, filtered low.
  const a = ok();
  if (!a) return { set() {}, stop() {} };
  const o = a.createOscillator();
  const o2 = a.createOscillator();
  const f = a.createBiquadFilter();
  const g = a.createGain();
  o.type = "triangle";
  o2.type = "sine";
  f.type = "lowpass";
  f.frequency.value = 260;
  g.gain.value = 0.0001;
  o.connect(f);
  o2.connect(f);
  f.connect(g).connect(master);
  o.start();
  o2.start();
  g.gain.exponentialRampToValueAtTime(0.035, a.currentTime + 0.6);
  return {
    set(speed) {
      const base = 48 + speed * 16;
      o.frequency.setTargetAtTime(base, a.currentTime, 0.25);
      o2.frequency.setTargetAtTime(base * 1.01, a.currentTime, 0.25);
      f.frequency.setTargetAtTime(220 + speed * 60, a.currentTime, 0.25);
    },
    stop() {
      g.gain.setTargetAtTime(0.0001, a.currentTime, 0.08);
      o.stop(a.currentTime + 0.5);
      o2.stop(a.currentTime + 0.5);
    },
  };
}
