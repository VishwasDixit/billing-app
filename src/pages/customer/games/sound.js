// Little chiptune sound effects for the games, made on the fly with Web Audio (no sound files,
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
  if (master) master.gain.value = m ? 0 : 0.5;
  listeners.forEach((f) => f(m));
}
export const onMuteChange = (f) => (listeners.add(f), () => listeners.delete(f));

// The audio context starts on the first tap (phones only allow sound after one).
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
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

// One tone: type, start and end pitch (Hz), length (s), volume, delay (s).
function tone(type, f1, f2, len, vol = 0.3, delay = 0) {
  const a = ok();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  if (f2 !== f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + len);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + len + 0.02);
}

// A burst of noise (crashes, dice rattling), low-passed from f1 to f2.
function noise(len, vol = 0.3, f1 = 3000, f2 = 300, delay = 0) {
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
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

const notes = (list, type = "square", vol = 0.18) => list.forEach(([f, at, len]) => tone(type, f, f, len, vol, at));

export const sfx = {
  beep: () => tone("square", 880, 880, 0.08, 0.15),
  go: () => tone("square", 1320, 1320, 0.22, 0.18),
  blip: () => tone("square", 660, 990, 0.05, 0.12),
  tick: () => tone("triangle", 1200, 900, 0.03, 0.18),
  coin: () => notes([[988, 0, 0.07], [1319, 0.07, 0.18]]),
  eat: () => tone("square", 520, 1040, 0.06, 0.16),
  bonus: () => notes([[784, 0, 0.06], [988, 0.06, 0.06], [1319, 0.12, 0.14]]),
  crash: () => (noise(0.6, 0.45, 2500, 120), tone("sawtooth", 180, 40, 0.5, 0.2)),
  roll: () => [0, 0.06, 0.13, 0.21, 0.3].forEach((d, i) => noise(0.05, 0.25 - i * 0.03, 4000, 1500, d)),
  move: () => (noise(0.05, 0.35, 1800, 400), tone("sine", 220, 160, 0.06, 0.2)),
  capture: () => (noise(0.09, 0.45, 2400, 300), tone("square", 300, 90, 0.18, 0.18)),
  check: () => notes([[880, 0, 0.08], [660, 0.1, 0.12]], "triangle", 0.22),
  home: () => notes([[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.1], [1047, 0.3, 0.25]]),
  win: () => notes([[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.12], [784, 0.5, 0.1], [1047, 0.6, 0.4]]),
  lose: () => notes([[392, 0, 0.18], [370, 0.2, 0.18], [349, 0.4, 0.18], [330, 0.6, 0.5]], "triangle", 0.22),
  pok: () => tone("square", 440, 440, 0.04, 0.2),
  wall: () => tone("square", 220, 220, 0.04, 0.16),
  point: () => tone("square", 490, 245, 0.25, 0.16),
};

// A steady engine hum whose pitch follows the speed. Returns { set(speed), stop() }.
export function engine() {
  const a = ok();
  if (!a) return { set() {}, stop() {} };
  const o = a.createOscillator();
  const o2 = a.createOscillator();
  const f = a.createBiquadFilter();
  const g = a.createGain();
  o.type = "sawtooth";
  o2.type = "square";
  f.type = "lowpass";
  f.frequency.value = 500;
  g.gain.value = 0.0001;
  o.connect(f);
  o2.connect(f);
  f.connect(g).connect(master);
  o.start();
  o2.start();
  g.gain.exponentialRampToValueAtTime(0.06, a.currentTime + 0.3);
  return {
    set(speed) {
      const base = 55 + speed * 28;
      o.frequency.setTargetAtTime(base, a.currentTime, 0.1);
      o2.frequency.setTargetAtTime(base * 1.005 / 2, a.currentTime, 0.1);
      f.frequency.setTargetAtTime(380 + speed * 160, a.currentTime, 0.1);
    },
    stop() {
      g.gain.setTargetAtTime(0.0001, a.currentTime, 0.05);
      o.stop(a.currentTime + 0.3);
      o2.stop(a.currentTime + 0.3);
    },
  };
}
