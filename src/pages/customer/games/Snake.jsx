// Snake, the old-phone way: a greenish LCD screen with dark pixel blocks. Swipe on the screen,
// use the keypad or the arrow keys. Rules in snakeRules.js.
import { useEffect, useRef, useState } from "react";
import { useGameLoop, readBest, saveBest, swipeDir, roundRect } from "./loop.js";
import { newSnake, turn, step, stepTime } from "./snakeRules.js";
import { sfx } from "./sound.js";

const COLS = 16, ROWS = 20;
const BEST_KEY = "coSnakeBest";
const LCD = "#b7c97a", INK = "#1e2a12", GHOST = "rgba(30,42,18,.07)";

export default function Snake() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const st = useRef({ s: newSnake(COLS, ROWS), prev: null, acc: 0, run: false, flash: 0 });
  const [phase, setPhase] = useState("ready"); // ready | play | paused | over
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBest(BEST_KEY));
  const [wrap, setWrap] = useState(true);

  const start = () => {
    st.current = { s: newSnake(COLS, ROWS, { wrap }), prev: null, acc: 0, run: true, flash: 0 };
    setScore(0);
    setPhase("play");
    sfx.go();
  };
  const go = (dir) => {
    const g = st.current;
    if (!g.run) return;
    const before = g.s;
    g.s = turn(g.s, dir);
    if (g.s !== before) sfx.tick();
  };
  const pause = () => {
    const g = st.current;
    if (phase === "play") {
      g.run = false;
      setPhase("paused");
    } else if (phase === "paused") {
      g.run = true;
      setPhase("play");
    }
  };
  // The phone left the page: pause.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && st.current.run) {
        st.current.run = false;
        setPhase("paused");
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  useEffect(() => {
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const onKey = (e) => {
      if (map[e.key]) {
        go(map[e.key]);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const touch = useRef(null);

  useGameLoop(wrapRef, canvasRef, {
    height: (w) => (w * ROWS) / COLS,
    update(dt) {
      const g = st.current;
      if (g.flash > 0) g.flash -= dt;
      if (!g.run) return;
      g.acc += dt;
      const t = stepTime(g.s);
      if (g.acc < t) return;
      g.acc -= t;
      g.prev = g.s.body;
      g.s = step(g.s);
      for (const e of g.s.events) {
        if (e === "eat") sfx.eat();
        if (e === "bonus") (sfx.bonus(), (g.flash = 0.4));
        if (e === "over") {
          g.run = false;
          sfx.lose();
          navigator.vibrate?.([80, 50, 80]);
          const final = g.s.score;
          setBest((b) => {
            const nb = Math.max(b, final);
            saveBest(BEST_KEY, nb);
            return nb;
          });
          setTimeout(() => setPhase("over"), 600);
        }
      }
      if (g.s.events.length) setScore(g.s.score);
    },
    draw(ctx, W, H, _a, now) {
      const g = st.current;
      const s = g.s;
      const c = W / COLS;
      const t = g.run ? Math.min(1, g.acc / stepTime(s)) : 1;
      ctx.fillStyle = LCD;
      ctx.fillRect(0, 0, W, H);
      // faint pixel grid, like an LCD
      ctx.fillStyle = GHOST;
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
      const block = (x, y, inset = 1.5, r = 2) => {
        roundRect(ctx, x * c + inset, y * c + inset, c - inset * 2, c - inset * 2, r);
        ctx.fill();
      };
      ctx.fillStyle = INK;
      // food: a small diamond; bonus: a blinking bug
      if (s.food) {
        const fx = (s.food.x + 0.5) * c, fy = (s.food.y + 0.5) * c, r = c * 0.32;
        ctx.beginPath();
        ctx.moveTo(fx, fy - r);
        ctx.lineTo(fx + r, fy);
        ctx.lineTo(fx, fy + r);
        ctx.lineTo(fx - r, fy);
        ctx.fill();
      }
      if (s.bonus && (s.bonus.left > 8 || Math.floor(now * 6) % 2)) {
        const bx = s.bonus.x * c, by = s.bonus.y * c;
        ctx.fillRect(bx + c * 0.25, by + c * 0.3, c * 0.5, c * 0.45);
        ctx.fillRect(bx + c * 0.1, by + c * 0.2, c * 0.12, c * 0.12);
        ctx.fillRect(bx + c * 0.78, by + c * 0.2, c * 0.12, c * 0.12);
        ctx.fillRect(bx + c * 0.1, by + c * 0.7, c * 0.12, c * 0.12);
        ctx.fillRect(bx + c * 0.78, by + c * 0.7, c * 0.12, c * 0.12);
      }
      // The snake: the head glides into its next square, the tail glides out.
      const body = s.body;
      const prev = g.prev || body;
      const blink = s.over && Math.floor(now * 5) % 2;
      if (!blink) {
        body.forEach((b, k) => {
          let x = b.x, y = b.y;
          if (k === 0 && g.run) {
            const p = prev[0];
            if (p && Math.abs(p.x - b.x) + Math.abs(p.y - b.y) === 1) {
              x = p.x + (b.x - p.x) * t;
              y = p.y + (b.y - p.y) * t;
              block(p.x, p.y); // fill behind the gliding head
            }
          }
          block(x, y, k === 0 ? 0.8 : 1.5, k === 0 ? 4 : 2);
        });
        // the old tail fades out as it leaves
        const oldTail = prev.at(-1);
        if (g.run && oldTail && prev.length === body.length && !body.some((b) => b.x === oldTail.x && b.y === oldTail.y)) {
          ctx.globalAlpha = 1 - t;
          block(oldTail.x, oldTail.y);
          ctx.globalAlpha = 1;
        }
        // eyes on the head
        const h = body[0];
        ctx.fillStyle = LCD;
        const [ex, ey] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[s.dir];
        const hx = (g.run && prev[0] && Math.abs(prev[0].x - h.x) + Math.abs(prev[0].y - h.y) === 1 ? prev[0].x + (h.x - prev[0].x) * t : h.x) * c + c / 2;
        const hy = (g.run && prev[0] && Math.abs(prev[0].x - h.x) + Math.abs(prev[0].y - h.y) === 1 ? prev[0].y + (h.y - prev[0].y) * t : h.y) * c + c / 2;
        for (const side of [-1, 1]) ctx.fillRect(hx + ex * c * 0.18 + ey * side * c * 0.18 - 1.5, hy + ey * c * 0.18 + ex * side * c * 0.18 - 1.5, 3, 3);
      }
      if (g.flash > 0) {
        ctx.fillStyle = `rgba(30,42,18,${g.flash * 0.4})`;
        ctx.fillRect(0, 0, W, H);
      }
      // screen glare
      const glare = ctx.createLinearGradient(0, 0, W, H);
      glare.addColorStop(0, "rgba(255,255,255,.14)");
      glare.addColorStop(0.4, "rgba(255,255,255,0)");
      ctx.fillStyle = glare;
      ctx.fillRect(0, 0, W, H);
    },
  });

  return (
    <div className="gm-snake">
      <div className="sn-phone">
        <div className="sn-top">
          <span>{String(score).padStart(4, "0")}</span>
          <span>HI {String(best).padStart(4, "0")}</span>
        </div>
        <div
          ref={wrapRef}
          className="sn-screen"
          onPointerDown={(e) => (touch.current = { x: e.clientX, y: e.clientY })}
          onPointerUp={(e) => {
            if (!touch.current) return;
            const d = swipeDir(touch.current, { x: e.clientX, y: e.clientY });
            touch.current = null;
            if (d) go(d);
          }}
        >
          <canvas ref={canvasRef} className="gm-canvas" aria-label="Snake screen" />
          {phase !== "play" && (
            <div className="sn-over">
              <b>{phase === "over" ? "GAME OVER" : phase === "paused" ? "PAUSED" : "SNAKE"}</b>
              {phase === "over" && <span>Score {score}{score >= best && score > 0 ? " · new high!" : ""}</span>}
              {phase === "ready" && <span>Swipe or use the keys. Eat, grow, don't bite your tail.</span>}
              {phase === "paused" ? <button className="sn-btn" onClick={pause}>Continue</button> : <button className="sn-btn" onClick={start}>{phase === "over" ? "Play again" : "Start"}</button>}
              {phase !== "paused" && (
                <label className="sn-wrap">
                  <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Walls wrap around
                </label>
              )}
            </div>
          )}
        </div>
        <div className="sn-pad">
          <button className="sn-key up" onPointerDown={(e) => (e.preventDefault(), go("up"))} aria-label="Up">▲</button>
          <button className="sn-key left" onPointerDown={(e) => (e.preventDefault(), go("left"))} aria-label="Left">◀</button>
          <button className="sn-key mid" onClick={pause} aria-label="Pause">{phase === "paused" ? "▶" : "❚❚"}</button>
          <button className="sn-key right" onPointerDown={(e) => (e.preventDefault(), go("right"))} aria-label="Right">▶</button>
          <button className="sn-key down" onPointerDown={(e) => (e.preventDefault(), go("down"))} aria-label="Down">▼</button>
        </div>
      </div>
    </div>
  );
}
