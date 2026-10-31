// Tiffin Dash: ride a delivery scooter up a three-lane road, dodge cars and the odd cow, grab
// samosas for points. Tap the left or right side (or swipe, or the arrow keys) to change lanes.
// Drawn on a canvas, no pictures to load.
import { useEffect, useRef, useState } from "react";

const LANES = 3;
const BEST_KEY = "coRaceBest";
const CAR_COLORS = ["#3b82f6", "#ef4444", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899"];

const readBest = () => {
  try {
    return Number(localStorage.getItem(BEST_KEY) || 0);
  } catch {
    return 0;
  }
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawScooter(ctx, x, y, s, tilt) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath();
  ctx.ellipse(0, s * 0.62, s * 0.34, s * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  roundRect(ctx, -s * 0.07, -s * 0.62, s * 0.14, s * 0.24, 4); // front wheel
  ctx.fill();
  roundRect(ctx, -s * 0.07, s * 0.36, s * 0.14, s * 0.24, 4); // back wheel
  ctx.fill();
  ctx.fillStyle = "#f97316";
  roundRect(ctx, -s * 0.18, -s * 0.48, s * 0.36, s * 0.92, s * 0.14);
  ctx.fill();
  ctx.fillStyle = "#c2410c"; // the tiffin box on the back
  roundRect(ctx, -s * 0.22, s * 0.18, s * 0.44, s * 0.3, 5);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.fillRect(-s * 0.22, s * 0.3, s * 0.44, s * 0.05);
  ctx.fillStyle = "#1f2937"; // handlebar
  ctx.fillRect(-s * 0.28, -s * 0.36, s * 0.56, s * 0.05);
  ctx.fillStyle = "#facc15"; // rider's helmet
  ctx.beginPath();
  ctx.arc(0, -s * 0.12, s * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(-s * 0.12, -s * 0.24, s * 0.24, s * 0.06);
  ctx.restore();
}

function drawCar(ctx, o, s) {
  const w = s * 0.62, h = s * 1.05;
  ctx.fillStyle = "rgba(0,0,0,.22)";
  roundRect(ctx, o.x - w / 2 + 3, o.y - h / 2 + 5, w, h, 10);
  ctx.fill();
  ctx.fillStyle = o.color;
  roundRect(ctx, o.x - w / 2, o.y - h / 2, w, h, 10);
  ctx.fill();
  ctx.fillStyle = "rgba(200,230,255,.85)";
  roundRect(ctx, o.x - w * 0.36, o.y + h * 0.12, w * 0.72, h * 0.2, 5); // rear window (it drives away from us)
  ctx.fill();
  roundRect(ctx, o.x - w * 0.36, o.y - h * 0.3, w * 0.72, h * 0.16, 5);
  ctx.fill();
  ctx.fillStyle = "#fecaca";
  ctx.fillRect(o.x - w * 0.42, o.y + h * 0.44, w * 0.18, h * 0.04);
  ctx.fillRect(o.x + w * 0.24, o.y + h * 0.44, w * 0.18, h * 0.04);
}

function drawCow(ctx, o, s, t) {
  const w = s * 0.78, h = s * 0.46;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(Math.sin(t * 3 + o.x) * 0.05);
  ctx.fillStyle = "#f8fafc";
  roundRect(ctx, -w / 2, -h / 2, w, h, h * 0.4);
  ctx.fill();
  ctx.fillStyle = "#1f2937";
  ctx.beginPath();
  ctx.ellipse(-w * 0.15, -h * 0.05, w * 0.12, h * 0.2, 0.4, 0, Math.PI * 2);
  ctx.ellipse(w * 0.18, h * 0.12, w * 0.09, h * 0.16, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f8fafc"; // head
  ctx.beginPath();
  ctx.arc(w * 0.55, -h * 0.05, h * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fda4af";
  ctx.beginPath();
  ctx.ellipse(w * 0.72, -h * 0.02, h * 0.14, h * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#a16207";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(w * 0.48, -h * 0.32);
  ctx.lineTo(w * 0.42, -h * 0.5);
  ctx.moveTo(w * 0.62, -h * 0.32);
  ctx.lineTo(w * 0.68, -h * 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawSamosa(ctx, o, s, t) {
  const r = s * 0.24;
  ctx.save();
  ctx.translate(o.x, o.y + Math.sin(t * 5 + o.y) * 3);
  ctx.fillStyle = "rgba(250,204,21,.25)";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d97706";
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r, r * 0.8);
  ctx.lineTo(-r, r * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.55);
  ctx.lineTo(r * 0.55, r * 0.55);
  ctx.lineTo(-r * 0.55, r * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export default function Racer() {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const game = useRef(null);
  const [phase, setPhase] = useState("ready"); // ready | play | over
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);

  const start = () => {
    game.current = { lane: 1, x: null, obstacles: [], dist: 0, speed: 1, spawn: 0, coins: 0, t: 0, over: false, shake: 0 };
    setScore(0);
    setPhase("play");
  };
  const steer = (d) => {
    const g = game.current;
    if (!g || g.over) return;
    g.lane = Math.max(0, Math.min(LANES - 1, g.lane + d));
  };

  // Keys, taps and swipes.
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
  const onPointerDown = (e) => {
    touch.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e) => {
    if (!touch.current || phase !== "play") return;
    const dx = e.clientX - touch.current.x;
    touch.current = null;
    if (Math.abs(dx) > 24) return steer(dx > 0 ? 1 : -1);
    const r = canvasRef.current.getBoundingClientRect();
    steer(e.clientX - r.left < r.width / 2 ? -1 : 1);
  };

  // The game loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, raf = 0, last = 0;
    const size = () => {
      const w = wrapRef.current.clientWidth;
      const h = Math.min(Math.round(w * 1.45), Math.round(window.innerHeight * 0.66));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      W = w;
      H = h;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrapRef.current);

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      const g = game.current;
      const verge = W * 0.1;
      const road = W - verge * 2;
      const laneW = road / LANES;
      const laneX = (l) => verge + laneW * (l + 0.5);
      const s = Math.min(laneW * 0.9, 70);
      const py = H - s * 1.1;

      // Update.
      if (g && !g.over && !document.hidden) {
        g.t += dt;
        g.speed = Math.min(3.2, 1 + g.t / 30);
        const v = H * 0.55 * g.speed; // px per second
        g.dist += v * dt;
        if (g.x == null) g.x = laneX(g.lane);
        g.x += (laneX(g.lane) - g.x) * Math.min(1, dt * 14);
        g.spawn -= dt;
        if (g.spawn <= 0) {
          // A new row: one or two lanes blocked, never all three; sometimes a samosa in a free lane.
          const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
          const blocked = Math.random() < Math.min(0.55, 0.15 + g.t / 90) ? 2 : 1;
          for (let i = 0; i < blocked; i++) {
            const kind = Math.random() < 0.18 ? "cow" : "car";
            g.obstacles.push({ kind, lane: lanes[i], x: laneX(lanes[i]), y: -s, color: CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0], own: kind === "car" ? 0.25 + Math.random() * 0.2 : 0 });
          }
          if (Math.random() < 0.6) g.obstacles.push({ kind: "samosa", lane: lanes[2], x: laneX(lanes[2]), y: -s * 2.2, own: 0 });
          g.spawn = Math.max(0.42, 1.1 - g.t / 70) / Math.sqrt(g.speed);
        }
        for (const o of g.obstacles) o.y += v * (1 - o.own) * dt; // cars drive too, a bit slower than us
        g.obstacles = g.obstacles.filter((o) => o.y < H + s * 2 && !o.taken);
        // Collisions (a forgiving box).
        for (const o of g.obstacles) {
          if (Math.abs(o.x - g.x) > laneW * 0.55) continue;
          const reach = o.kind === "samosa" ? s * 0.6 : o.kind === "cow" ? s * 0.55 : s * 0.8;
          if (Math.abs(o.y - py) < reach) {
            if (o.kind === "samosa") {
              o.taken = true;
              g.coins++;
              navigator.vibrate?.(15);
            } else {
              g.over = true;
              g.shake = 0.4;
              navigator.vibrate?.([60, 40, 120]);
              const final = Math.floor(g.dist / 40) + g.coins * 25;
              setScore(final);
              setBest((b) => {
                const nb = Math.max(b, final);
                try {
                  localStorage.setItem(BEST_KEY, String(nb));
                } catch {
                  /* private mode */
                }
                return nb;
              });
              setPhase("over");
            }
          }
        }
        if (!g.over && g.t - (g.shownAt || 0) > 0.2) {
          g.shownAt = g.t;
          setScore(Math.floor(g.dist / 40) + g.coins * 25);
        }
      }
      if (g?.shake > 0) g.shake -= dt;

      // Draw.
      ctx.save();
      if (g?.shake > 0) ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
      const scroll = g ? g.dist : now * 0.08;
      ctx.fillStyle = "#4d9a45";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#3f8a3a";
      for (let y = -60 + (scroll % 60); y < H; y += 60) {
        ctx.fillRect(0, y, verge, 30);
        ctx.fillRect(W - verge, y + 30, verge, 30);
      }
      ctx.fillStyle = "#2f7a33"; // trees
      for (let y = -140 + (scroll % 140); y < H + 40; y += 140) {
        ctx.beginPath();
        ctx.arc(verge * 0.5, y, verge * 0.38, 0, Math.PI * 2);
        ctx.arc(W - verge * 0.5, y + 70, verge * 0.38, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#3a3f47";
      ctx.fillRect(verge, 0, road, H);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(verge, 0, 3, H);
      ctx.fillRect(W - verge - 3, 0, 3, H);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      for (let l = 1; l < LANES; l++) {
        for (let y = -50 + (scroll % 50); y < H; y += 50) ctx.fillRect(verge + laneW * l - 2, y, 4, 26);
      }
      if (g) {
        for (const o of g.obstacles) {
          if (o.kind === "car") drawCar(ctx, o, s);
          else if (o.kind === "cow") drawCow(ctx, o, s, g.t);
          else drawSamosa(ctx, o, s, g.t);
        }
        drawScooter(ctx, g.x ?? laneX(1), py, s, g.over ? 0.5 : (laneX(g.lane) - (g.x ?? 0)) / laneW * 0.35);
      } else drawScooter(ctx, laneX(1), py, s, 0);
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="gm-race">
      <div className="gm-race-bar">
        <span>Score <b>{score}</b></span>
        <span>Best <b>{best}</b></span>
      </div>
      <div ref={wrapRef} className="gm-race-wrap" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <canvas ref={canvasRef} className="gm-canvas" aria-label="Tiffin Dash road" />
        {phase !== "play" && (
          <div className="gm-over">
            <b>{phase === "over" ? (score >= best && score > 0 ? "New best! 🏆" : "Oops! 💥") : "Tiffin Dash 🛵"}</b>
            {phase === "over" ? <span>You scored {score}</span> : <span>Tap left or right to switch lanes. Dodge cars and cows, grab samosas.</span>}
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
