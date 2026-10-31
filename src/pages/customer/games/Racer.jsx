// Tiffin Dash: ride a delivery scooter down a winding, hilly road (drawn in pseudo-3D, the way
// old arcade racers did it), dodge cars, autos and the odd cow, grab samosas. Tap the left or
// right side (or swipe, or the arrow keys) to change lanes. All drawn on a canvas, sounds made
// on the fly, no files to load.
import { useEffect, useRef, useState } from "react";
import { useGameLoop, lerp, roundRect, readBest, saveBest } from "./loop.js";
import { sfx, engine } from "./sound.js";

const BEST_KEY = "coRaceBest";
const SEG = 200; // length of one road segment
const DRAW = 150; // segments drawn ahead
const ROAD = 2000; // half the road's width
const LANES = [-ROAD * 0.64, 0, ROAD * 0.64];
const CAM_H = 2400; // camera height
const DEPTH = 1 / Math.tan((50 * Math.PI) / 180); // 100° field of view
const PLAYER_Z = 1824; // how far ahead of the camera the scooter rides (road fills ~90% of the width there)
const SP = DEPTH / PLAYER_Z; // projection scale at the scooter
const HORIZON = 0.4; // horizon line, as a share of the height
const CAR_COLORS = [["#2563eb", "#1e3a8a"], ["#dc2626", "#7f1d1d"], ["#7c3aed", "#4c1d95"], ["#059669", "#064e3b"], ["#f8fafc", "#94a3b8"], ["#111827", "#000"]];

// The road, made up as it goes: gentle bends and hills from a few sine waves.
const curveAt = (i) => (Math.sin(i * 0.011) + Math.sin(i * 0.0037 + 1.3) * 0.8) * 2.6;
const hillAt = (i) => (Math.sin(i * 0.019) * 0.6 + Math.sin(i * 0.0061 + 2) * 0.4) * 1300;
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const isNight = () => document.documentElement.dataset.theme === "dark";

// ── Sprites, drawn from the back, bottom-centred at (x, y), w pixels wide ──
function shadow(ctx, x, y, w) {
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.beginPath();
  ctx.ellipse(x, y, w * 0.55, w * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawCar(ctx, x, y, w, [c1, c2], night) {
  const h = w * 0.62;
  shadow(ctx, x, y, w);
  ctx.fillStyle = "#111";
  roundRect(ctx, x - w * 0.46, y - h * 0.28, w * 0.18, h * 0.3, w * 0.03);
  ctx.fill();
  roundRect(ctx, x + w * 0.28, y - h * 0.28, w * 0.18, h * 0.3, w * 0.03);
  ctx.fill();
  const g = ctx.createLinearGradient(0, y - h, 0, y);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  roundRect(ctx, x - w * 0.5, y - h * 0.72, w, h * 0.6, w * 0.08); // body
  ctx.fill();
  roundRect(ctx, x - w * 0.38, y - h, w * 0.76, h * 0.36, w * 0.1); // roof
  ctx.fill();
  const glass = ctx.createLinearGradient(0, y - h, 0, y - h * 0.66);
  glass.addColorStop(0, "#93c5fd");
  glass.addColorStop(1, "#1e293b");
  ctx.fillStyle = glass;
  roundRect(ctx, x - w * 0.32, y - h * 0.95, w * 0.64, h * 0.27, w * 0.06);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.25)"; // shine
  ctx.fillRect(x - w * 0.46, y - h * 0.66, w * 0.92, h * 0.05);
  // tail lights (glow at night)
  ctx.save();
  if (night) {
    ctx.shadowColor = "#ff2a2a";
    ctx.shadowBlur = w * 0.25;
  }
  ctx.fillStyle = "#ff3b3b";
  roundRect(ctx, x - w * 0.46, y - h * 0.56, w * 0.2, h * 0.11, w * 0.03);
  ctx.fill();
  roundRect(ctx, x + w * 0.26, y - h * 0.56, w * 0.2, h * 0.11, w * 0.03);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#f5f5dc"; // number plate
  ctx.fillRect(x - w * 0.12, y - h * 0.4, w * 0.24, h * 0.09);
  ctx.fillStyle = "#333";
  ctx.fillRect(x - w * 0.5, y - h * 0.2, w, h * 0.06); // bumper
}

function drawAuto(ctx, x, y, w, night) {
  const h = w * 0.95;
  shadow(ctx, x, y, w);
  ctx.fillStyle = "#111";
  roundRect(ctx, x - w * 0.46, y - h * 0.24, w * 0.16, h * 0.25, w * 0.04);
  ctx.fill();
  roundRect(ctx, x + w * 0.3, y - h * 0.24, w * 0.16, h * 0.25, w * 0.04);
  ctx.fill();
  const body = ctx.createLinearGradient(0, y - h * 0.6, 0, y);
  body.addColorStop(0, "#16a34a");
  body.addColorStop(1, "#14532d");
  ctx.fillStyle = body;
  roundRect(ctx, x - w * 0.46, y - h * 0.55, w * 0.92, h * 0.42, w * 0.1);
  ctx.fill();
  const top = ctx.createLinearGradient(0, y - h, 0, y - h * 0.5);
  top.addColorStop(0, "#fde047");
  top.addColorStop(1, "#ca8a04");
  ctx.fillStyle = top; // yellow canopy
  ctx.beginPath();
  ctx.moveTo(x - w * 0.44, y - h * 0.52);
  ctx.quadraticCurveTo(x - w * 0.48, y - h, x, y - h);
  ctx.quadraticCurveTo(x + w * 0.48, y - h, x + w * 0.44, y - h * 0.52);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#111827";
  roundRect(ctx, x - w * 0.28, y - h * 0.86, w * 0.56, h * 0.26, w * 0.05);
  ctx.fill();
  ctx.save();
  if (night) {
    ctx.shadowColor = "#ff2a2a";
    ctx.shadowBlur = w * 0.2;
  }
  ctx.fillStyle = "#ff3b3b";
  ctx.fillRect(x - w * 0.4, y - h * 0.32, w * 0.12, h * 0.06);
  ctx.fillRect(x + w * 0.28, y - h * 0.32, w * 0.12, h * 0.06);
  ctx.restore();
}

function drawCow(ctx, x, y, w, t) {
  const h = w * 0.9;
  shadow(ctx, x, y, w * 0.8);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#3f3f46"; // legs
  for (const lx of [-0.3, -0.12, 0.12, 0.3]) ctx.fillRect(lx * w - w * 0.04, -h * 0.4, w * 0.08, h * 0.4);
  const g = ctx.createRadialGradient(-w * 0.1, -h * 0.75, w * 0.05, 0, -h * 0.6, w * 0.6);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#d4d4d8");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, -h * 0.6, w * 0.42, h * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#27272a";
  ctx.beginPath();
  ctx.ellipse(-w * 0.18, -h * 0.68, w * 0.12, h * 0.1, 0.4, 0, Math.PI * 2);
  ctx.ellipse(w * 0.2, -h * 0.52, w * 0.1, h * 0.08, -0.3, 0, Math.PI * 2);
  ctx.fill();
  // head peeking over, with horns, and a swishing tail
  ctx.fillStyle = "#e4e4e7";
  ctx.beginPath();
  ctx.arc(w * 0.05, -h * 0.95, w * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#a16207";
  ctx.lineWidth = Math.max(1, w * 0.035);
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, -h * 1.03);
  ctx.lineTo(-w * 0.14, -h * 1.15);
  ctx.moveTo(w * 0.15, -h * 1.03);
  ctx.lineTo(w * 0.24, -h * 1.15);
  ctx.stroke();
  ctx.strokeStyle = "#52525b";
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.4);
  ctx.quadraticCurveTo(Math.sin(t * 6) * w * 0.15, -h * 0.25, Math.sin(t * 6 + 1) * w * 0.12, -h * 0.12);
  ctx.stroke();
  ctx.restore();
}

function drawSamosa(ctx, x, y, w, t) {
  const r = w * 0.45;
  const cy = y - w * 0.7 + Math.sin(t * 5) * w * 0.08;
  ctx.save();
  const glow = ctx.createRadialGradient(x, cy, 0, x, cy, r * 1.8);
  glow.addColorStop(0, "rgba(253,224,71,.6)");
  glow.addColorStop(1, "rgba(253,224,71,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, cy, r * 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(x, cy);
  ctx.scale(Math.cos(t * 3), 1); // spins
  const g = ctx.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#fbbf24");
  g.addColorStop(1, "#b45309");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r, r * 0.75);
  ctx.lineTo(-r, r * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(120,53,15,.6)";
  ctx.lineWidth = Math.max(1, w * 0.03);
  ctx.stroke();
  ctx.restore();
}

function drawTree(ctx, x, y, w, kind) {
  ctx.fillStyle = "#5b3a1e";
  ctx.fillRect(x - w * 0.06, y - w * 0.7, w * 0.12, w * 0.7);
  const g = ctx.createRadialGradient(x - w * 0.15, y - w * 1.25, w * 0.05, x, y - w * 1.05, w * 0.6);
  g.addColorStop(0, kind ? "#4ade80" : "#86efac");
  g.addColorStop(1, kind ? "#14532d" : "#166534");
  ctx.fillStyle = g;
  ctx.beginPath();
  if (kind) {
    // palm-ish: three blobs
    ctx.arc(x - w * 0.22, y - w * 1.0, w * 0.32, 0, Math.PI * 2);
    ctx.arc(x + w * 0.22, y - w * 1.0, w * 0.32, 0, Math.PI * 2);
    ctx.arc(x, y - w * 1.28, w * 0.36, 0, Math.PI * 2);
  } else ctx.arc(x, y - w * 1.1, w * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawLamp(ctx, x, y, w, side, night) {
  ctx.fillStyle = "#64748b";
  ctx.fillRect(x - w * 0.03, y - w * 1.9, w * 0.06, w * 1.9);
  ctx.fillRect(x - (side < 0 ? 0 : w * 0.4), y - w * 1.9, w * 0.4, w * 0.05);
  const lx = x + (side < 0 ? w * 0.38 : -w * 0.38);
  ctx.save();
  if (night) {
    ctx.shadowColor = "#fde68a";
    ctx.shadowBlur = w * 0.6;
  }
  ctx.fillStyle = night ? "#fef3c7" : "#cbd5e1";
  ctx.beginPath();
  ctx.ellipse(lx, y - w * 1.84, w * 0.1, w * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawScooter(ctx, x, y, w, lean, t, night, crashed) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean);
  shadow(ctx, 0, 0, w * 0.7);
  const bob = crashed ? 0 : Math.sin(t * 22) * w * 0.006;
  ctx.translate(0, bob);
  ctx.fillStyle = "#111"; // rear wheel
  roundRect(ctx, -w * 0.08, -w * 0.3, w * 0.16, w * 0.3, w * 0.06);
  ctx.fill();
  const body = ctx.createLinearGradient(-w * 0.2, 0, w * 0.2, 0);
  body.addColorStop(0, "#c2410c");
  body.addColorStop(0.5, "#fb923c");
  body.addColorStop(1, "#c2410c");
  ctx.fillStyle = body;
  roundRect(ctx, -w * 0.2, -w * 0.5, w * 0.4, w * 0.3, w * 0.1);
  ctx.fill();
  ctx.save();
  if (night) {
    ctx.shadowColor = "#ff2a2a";
    ctx.shadowBlur = w * 0.15;
  }
  ctx.fillStyle = "#ef4444"; // tail light
  roundRect(ctx, -w * 0.07, -w * 0.33, w * 0.14, w * 0.05, w * 0.02);
  ctx.fill();
  ctx.restore();
  // the tiffin box on the carrier
  const box = ctx.createLinearGradient(0, -w * 0.82, 0, -w * 0.5);
  box.addColorStop(0, "#ef4444");
  box.addColorStop(1, "#991b1b");
  ctx.fillStyle = box;
  roundRect(ctx, -w * 0.22, -w * 0.84, w * 0.44, w * 0.34, w * 0.05);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.font = `800 ${Math.round(w * 0.1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("TIFFIN", 0, -w * 0.63);
  // rider: shoulders, arms to the handlebar, helmet
  ctx.fillStyle = "#1d4ed8";
  roundRect(ctx, -w * 0.25, -w * 1.12, w * 0.5, w * 0.32, w * 0.14);
  ctx.fill();
  ctx.strokeStyle = "#1e3a8a";
  ctx.lineWidth = w * 0.07;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-w * 0.22, -w * 1.0);
  ctx.lineTo(-w * 0.36, -w * 0.86);
  ctx.moveTo(w * 0.22, -w * 1.0);
  ctx.lineTo(w * 0.36, -w * 0.86);
  ctx.stroke();
  ctx.fillStyle = "#1f2937"; // mirrors / handlebar ends
  ctx.fillRect(-w * 0.42, -w * 0.9, w * 0.1, w * 0.04);
  ctx.fillRect(w * 0.32, -w * 0.9, w * 0.1, w * 0.04);
  const helm = ctx.createRadialGradient(-w * 0.05, -w * 1.3, w * 0.02, 0, -w * 1.22, w * 0.18);
  helm.addColorStop(0, "#fef08a");
  helm.addColorStop(1, "#ca8a04");
  ctx.fillStyle = helm;
  ctx.beginPath();
  ctx.arc(0, -w * 1.22, w * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export default function Racer() {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const game = useRef(null);
  const motor = useRef(null);
  const [phase, setPhase] = useState("ready"); // ready | count | play | over
  const [count, setCount] = useState(0);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBest(BEST_KEY));

  const fresh = () => ({ pos: 0, prevPos: 0, speed: 0, lane: 1, px: 0, prevPx: 0, t: 0, obstacles: [], nextRow: SEG * 40, coins: 0, over: false, playing: false, shake: 0, sparks: [], shownAt: 0 });
  if (!game.current) game.current = fresh();

  const start = () => {
    game.current = fresh();
    setScore(0);
    setPhase("count");
    setCount(3);
  };
  // 3-2-1-Go!
  useEffect(() => {
    if (phase !== "count") return;
    if (count === 0) {
      sfx.go();
      game.current.playing = true;
      motor.current = engine();
      setPhase("play");
      return;
    }
    sfx.beep();
    const t = setTimeout(() => setCount((c) => c - 1), 650);
    return () => clearTimeout(t);
  }, [phase, count]);
  useEffect(() => () => motor.current?.stop(), []);

  const steer = (d) => {
    const g = game.current;
    if (!g.playing || g.over) return;
    const lane = Math.max(0, Math.min(2, g.lane + d));
    if (lane !== g.lane) sfx.blip();
    g.lane = lane;
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowLeft") steer(-1);
      else if (e.key === "ArrowRight") steer(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const touch = useRef(null);
  const onPointerDown = (e) => (touch.current = { x: e.clientX });
  const onPointerUp = (e) => {
    if (!touch.current) return;
    const dx = e.clientX - touch.current.x;
    touch.current = null;
    if (Math.abs(dx) > 24) return steer(dx > 0 ? 1 : -1);
    const r = canvasRef.current.getBoundingClientRect();
    steer(e.clientX - r.left < r.width / 2 ? -1 : 1);
  };

  const crash = (g) => {
    g.over = true;
    g.playing = false;
    g.shake = 0.5;
    motor.current?.stop();
    motor.current = null;
    sfx.crash();
    navigator.vibrate?.([60, 40, 140]);
    for (let i = 0; i < 26; i++) g.sparks.push({ x: 0, y: 0, vx: (Math.random() - 0.5) * 420, vy: -Math.random() * 380 - 60, life: 0.6 + Math.random() * 0.5 });
    const final = Math.floor(g.pos / (SEG * 4)) + g.coins * 25;
    setScore(final);
    setBest((b) => {
      const nb = Math.max(b, final);
      saveBest(BEST_KEY, nb);
      return nb;
    });
    setTimeout(() => setPhase("over"), 700);
  };

  useGameLoop(wrapRef, canvasRef, {
    height: (w) => Math.min(w * 1.4, window.innerHeight * 0.62),
    update(dt) {
      const g = game.current;
      g.prevPos = g.pos;
      g.prevPx = g.px;
      g.t += dt;
      if (g.shake > 0) g.shake -= dt;
      for (const s of g.sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 900 * dt;
        s.life -= dt;
      }
      g.sparks = g.sparks.filter((s) => s.life > 0);
      // Idle on the start screen: roll gently so the scene is alive.
      const target = g.over ? 0 : g.playing ? Math.min(SEG * 62, SEG * 26 + g.t * SEG * 0.9) : SEG * 6;
      g.speed += (target - g.speed) * Math.min(1, dt * (g.over ? 3 : 1.5));
      g.pos += g.speed * dt;
      g.px += (LANES[g.lane] - g.px) * Math.min(1, dt * 11);
      if (!g.playing) return;
      motor.current?.set(g.speed / (SEG * 20));

      // New rows of traffic ahead: one or two lanes blocked, never all three.
      while (g.nextRow < g.pos + DRAW * SEG) {
        const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
        const blocked = Math.random() < Math.min(0.6, 0.18 + g.t / 80) ? 2 : 1;
        for (let i = 0; i < blocked; i++) {
          const r = Math.random();
          const kind = r < 0.15 ? "cow" : r < 0.4 ? "auto" : "car";
          g.obstacles.push({ kind, lane: lanes[i], z: g.nextRow + Math.random() * SEG * 2, v: kind === "cow" ? 0 : SEG * (8 + Math.random() * 8), color: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0] });
        }
        if (Math.random() < 0.65) g.obstacles.push({ kind: "samosa", lane: lanes[2], z: g.nextRow + SEG * 3, v: 0 });
        g.nextRow += SEG * Math.max(14, 30 - g.t / 3);
      }
      for (const o of g.obstacles) o.z += o.v * dt;
      g.obstacles = g.obstacles.filter((o) => o.z > g.pos + SEG && !o.taken);
      for (const o of g.obstacles) {
        const rel = o.z - (g.pos + PLAYER_Z);
        if (Math.abs(rel) > (o.kind === "samosa" ? 140 : 190) || Math.abs(LANES[o.lane] - g.px) > ROAD * 0.4) continue;
        if (o.kind === "samosa") {
          o.taken = true;
          g.coins++;
          sfx.coin();
          navigator.vibrate?.(15);
        } else return crash(g);
      }
      if (g.t - g.shownAt > 0.2) {
        g.shownAt = g.t;
        setScore(Math.floor(g.pos / (SEG * 4)) + g.coins * 25);
      }
    },
    draw(ctx, W, H, a, now) {
      const g = game.current;
      const night = isNight();
      const pos = lerp(g.prevPos, g.pos, a);
      const px = lerp(g.prevPx, g.px, a);
      const hy = H * HORIZON;
      ctx.save();
      if (g.shake > 0) ctx.translate((Math.random() - 0.5) * 12 * g.shake, (Math.random() - 0.5) * 12 * g.shake);

      const base = Math.floor(pos / SEG);
      const frac = (pos % SEG) / SEG;
      // Bend so far, for the skyline's sideways drift.
      const drift = (Math.sin(base * 0.011) * 90 + Math.sin(base * 0.0037 + 1.3) * 200) % W;

      // Sky, sun or moon, hills and a far skyline.
      const sky = ctx.createLinearGradient(0, 0, 0, hy);
      if (night) {
        sky.addColorStop(0, "#020617");
        sky.addColorStop(1, "#1e293b");
      } else {
        sky.addColorStop(0, "#38bdf8");
        sky.addColorStop(1, "#e0f2fe");
      }
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, hy + 2);
      if (night) {
        ctx.fillStyle = "rgba(255,255,255,.8)";
        for (let i = 0; i < 40; i++) ctx.fillRect((hash(i) * W * 2 - drift * 0.2 + W * 2) % W, hash(i + 99) * hy * 0.8, 1.5, 1.5);
        ctx.fillStyle = "#f8fafc";
        ctx.beginPath();
        ctx.arc(W * 0.78, hy * 0.28, W * 0.05, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(255,237,160,.9)";
        ctx.beginPath();
        ctx.arc(W * 0.78, hy * 0.3, W * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      const layer = (color, amp, freq, off, shift) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, hy + 2);
        for (let x = 0; x <= W; x += 6) ctx.lineTo(x, hy - amp * (0.6 + 0.4 * Math.sin((x + shift) * freq + off)) - amp * 0.3 * Math.sin((x + shift) * freq * 2.7));
        ctx.lineTo(W, hy + 2);
        ctx.fill();
      };
      layer(night ? "#1e1b4b" : "#93c5fd", H * 0.09, 0.012, 1, -drift * 0.3);
      // skyline blocks
      ctx.fillStyle = night ? "#0f172a" : "#64748b";
      for (let i = 0; i < 18; i++) {
        const bw = W * (0.04 + hash(i) * 0.05);
        const bx = ((i * W) / 12 - drift * 0.6 + W * 3) % (W * 1.5) - W * 0.2;
        const bh = H * (0.04 + hash(i + 7) * 0.08);
        ctx.fillRect(bx, hy - bh, bw, bh);
        if (night) {
          ctx.fillStyle = "rgba(253,230,138,.7)";
          for (let k = 0; k < 4; k++) if (hash(i * 9 + k) > 0.5) ctx.fillRect(bx + bw * 0.2 + (k % 2) * bw * 0.4, hy - bh + bh * 0.2 + Math.floor(k / 2) * bh * 0.3, 2, 2);
          ctx.fillStyle = "#0f172a";
        }
      }
      layer(night ? "#14532d" : "#4d7c0f", H * 0.05, 0.02, 3, -drift);
      ctx.fillStyle = night ? "#183f24" : "#4f9634"; // ground below the horizon
      ctx.fillRect(0, hy, W, H - hy);

      // The road, near to far, each segment clipped above the last (hills hide what's behind).
      // The bend is measured from the scooter's spot, so the road under it stays put.
      const atPlayer = pos + PLAYER_Z;
      const pi = Math.floor(atPlayer / SEG);
      const camY = CAM_H + lerp(hillAt(pi), hillAt(pi + 1), (atPlayer % SEG) / SEG);
      const camX = px * 0.6;
      const xs = [];
      let x = 0;
      let dx = -curveAt(base) * frac;
      for (let n = 0; n < DRAW; n++) {
        xs.push(x);
        x += dx;
        dx += curveAt(base + n);
      }
      const np = PLAYER_Z / SEG + frac;
      const x0 = lerp(xs[Math.floor(np)], xs[Math.floor(np) + 1], np % 1);
      let maxY = H;
      const proj = [];
      let prev = null;
      for (let n = 0; n < DRAW; n++) {
        const i = base + n;
        const cz = n * SEG - frac * SEG;
        if (cz < 120) {
          proj.push(null);
          continue;
        }
        const sc = DEPTH / cz;
        const p = { i, clip: maxY, scale: sc };
        p.x = W / 2 + sc * (xs[n] - x0 - camX) * (W / 2);
        p.y = hy - sc * (hillAt(i) - camY) * (H / 2);
        p.w = sc * ROAD * (W / 2);
        proj.push(p);
        if (prev && p.y < prev.y && p.y < maxY) {
          const stripe = Math.floor(i / 3) % 2;
          const grass = night ? (stripe ? "#14361f" : "#183f24") : stripe ? "#5aa63d" : "#4f9634";
          ctx.fillStyle = grass;
          ctx.fillRect(0, p.y, W, Math.min(prev.y, maxY) - p.y + 1);
          const quad = (x1, w1, x2, w2, color) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(prev.x + x1 * prev.w - w1 * prev.w, prev.y + 0.5);
            ctx.lineTo(prev.x + x1 * prev.w + w1 * prev.w, prev.y + 0.5);
            ctx.lineTo(p.x + x2 * p.w + w2 * p.w, p.y);
            ctx.lineTo(p.x + x2 * p.w - w2 * p.w, p.y);
            ctx.fill();
          };
          quad(0, 1.12, 0, 1.12, stripe ? "#e5e7eb" : "#dc2626"); // kerb
          const fog = Math.min(1, n / DRAW);
          const shade = night ? 34 + (stripe ? 4 : 0) : 78 + (stripe ? 6 : 0);
          quad(0, 1, 0, 1, `rgb(${shade + fog * 30},${shade + 2 + fog * 30},${shade + 8 + fog * 30})`);
          if (stripe) {
            const lw = 0.025;
            quad(-0.32, lw, -0.32, lw, night ? "#fef3c7" : "#f8fafc");
            quad(0.32, lw, 0.32, lw, night ? "#fef3c7" : "#f8fafc");
          }
          maxY = p.y;
        }
        prev = p;
      }
      // Distance haze over the far road.
      const haze = ctx.createLinearGradient(0, hy - 2, 0, hy + H * 0.12);
      haze.addColorStop(0, night ? "rgba(30,41,59,.45)" : "rgba(224,242,254,.4)");
      haze.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, hy - 2, W, H * 0.12);

      // Things along and on the road, far to near.
      const items = [];
      for (let n = DRAW - 1; n > 0; n--) {
        const p = proj[n];
        if (!p) continue;
        const i = p.i;
        if (i % 6 === 0) items.push({ p, side: hash(i) < 0.5 ? -1 : 1, kind: hash(i + 3) < 0.3 ? "lamp" : "tree", v: hash(i + 5) < 0.5 ? 1 : 0 });
        if (i % 6 === 3 && hash(i + 1) < 0.6) items.push({ p, side: hash(i + 2) < 0.5 ? -1 : 1, kind: "tree", v: 1 });
      }
      const sprite = (p, wx, ww, fn) => {
        const sx = p.x + p.scale * wx * (W / 2);
        const sw = p.scale * ww * (W / 2);
        if (sw < 1.2 || p.y > H + 50) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, p.clip);
        ctx.clip();
        fn(sx, p.y, sw);
        ctx.restore();
      };
      const onRoad = g.obstacles.map((o) => ({ o, n: Math.floor(o.z / SEG) - base }));
      for (let n = DRAW - 1; n > 0; n--) {
        const p = proj[n];
        if (!p) continue;
        for (const it of items) if (it.p === p) {
          const wx = it.side * ROAD * (1.35 + hash(p.i + 11) * 0.5);
          if (it.kind === "lamp") sprite(p, it.side * ROAD * 1.2, 700, (sx, sy, sw) => drawLamp(ctx, sx, sy, sw, it.side, night));
          else sprite(p, wx, 1500, (sx, sy, sw) => drawTree(ctx, sx, sy, sw, it.v));
        }
        for (const { o, n: on } of onRoad) {
          if (on !== n) continue;
          const wx = LANES[o.lane];
          if (o.kind === "car") sprite(p, wx, 880, (sx, sy, sw) => drawCar(ctx, sx, sy, sw, o.color, night));
          else if (o.kind === "auto") sprite(p, wx, 760, (sx, sy, sw) => drawAuto(ctx, sx, sy, sw, night));
          else if (o.kind === "cow") sprite(p, wx, 760, (sx, sy, sw) => drawCow(ctx, sx, sy, sw, now));
          else sprite(p, wx, 420, (sx, sy, sw) => drawSamosa(ctx, sx, sy, sw, now));
        }
      }

      // Speed lines once you're flying.
      const fast = (g.speed - SEG * 34) / (SEG * 28);
      if (fast > 0 && !g.over) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.35, fast * 0.5)})`;
        ctx.lineWidth = 2;
        for (let k = 0; k < 10; k++) {
          const side = k % 2 ? 1 : -1;
          const yy = hy + ((hash(k) * H + now * 900 * (1 + hash(k + 4))) % (H - hy));
          const xx = W / 2 + side * (W * 0.38 + hash(k + 8) * W * 0.12) * ((yy - hy) / (H - hy) + 0.3);
          ctx.beginPath();
          ctx.moveTo(xx, yy);
          ctx.lineTo(xx + side * 14, yy + 34);
          ctx.stroke();
        }
      }

      // The scooter (you), leaning into lane changes.
      const sw = Math.min(W * 0.24, 110);
      const sx = W / 2 + SP * (px - camX) * (W / 2);
      const sy = Math.min(H - 6, hy + SP * CAM_H * (H / 2));
      const lean = g.over ? 0.55 : ((LANES[g.lane] - px) / ROAD) * -0.5;
      drawScooter(ctx, sx, sy, sw, lean, now, night, g.over);
      // Crash sparks.
      for (const s of g.sparks) {
        ctx.fillStyle = `rgba(255,${150 + Math.random() * 100},40,${Math.min(1, s.life * 2)})`;
        ctx.fillRect(sx + s.x, sy - sw * 0.5 + s.y, 3, 3);
      }
      ctx.restore();
    },
  });

  return (
    <div className="gm-race">
      <div className="gm-race-bar">
        <span>Score <b>{score}</b></span>
        <span>Best <b>{best}</b></span>
      </div>
      <div ref={wrapRef} className="gm-race-wrap" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <canvas ref={canvasRef} className="gm-canvas" aria-label="Tiffin Dash road" />
        {phase === "count" && <div className="gm-count" key={count}>{count || "GO!"}</div>}
        {(phase === "ready" || phase === "over") && (
          <div className="gm-over">
            <b>{phase === "over" ? (score >= best && score > 0 ? "New best! 🏆" : "Oops! 💥") : "Tiffin Dash 🛵"}</b>
            {phase === "over" ? <span>You scored {score}</span> : <span>Tap left or right to switch lanes. Dodge cars, autos and cows. Grab samosas.</span>}
            <button className="btn btn-primary btn-lg" onClick={start}>{phase === "over" ? "Ride again" : "Start"}</button>
          </div>
        )}
      </div>
      <div className="gm-race-pads">
        <button className="btn btn-lg" onClick={() => steer(-1)} aria-label="Left">◀</button>
        <button className="btn btn-lg" onClick={() => steer(1)} aria-label="Right">▶</button>
      </div>
    </div>
  );
}
