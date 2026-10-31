// Ping Pong against the computer: drag anywhere on the table to move your bat (bottom). Where the
// ball meets the bat sets its angle, a moving bat adds spin, every return is a bit faster.
// First to 7, two clear. Physics in pongRules.js.
import { useRef, useState } from "react";
import { useGameLoop, clamp, lerp, roundRect } from "./loop.js";
import { bounceOff, sideWalls, pointTo, winner } from "./pongRules.js";
import { sfx } from "./sound.js";

const PW = 0.24; // bat width (share of the table's width)
const ME_Y = 0.93, CPU_Y = 0.07;
const R = 0.022; // ball radius
const LEVEL = { easy: { speed: 0.9, miss: 0.12, label: "Easy" }, normal: { speed: 1.4, miss: 0.05, label: "Normal" } };

export default function PingPong() {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [level, setLevel] = useState(null);
  const [score, setScore] = useState([0, 0]); // [me, cpu]
  const [won, setWon] = useState(null);
  const g = useRef(null);

  const fresh = (lv) => ({
    lv,
    me: 0.5, meTarget: 0.5, meVx: 0,
    cpu: 0.5, cpuErr: 0,
    ball: { x: 0.5, y: 0.5, vx: 0, vy: 0, speed: 0.8 },
    prev: { x: 0.5, y: 0.5 },
    trail: [],
    serve: 1, serveTo: 1, // seconds until the serve; +1 = towards you
    hitY: 0.5, bounced: false,
    pts: [0, 0], over: false, aspect: 1.5, flash: 0,
  });
  const start = (lv) => {
    g.current = fresh(lv);
    setLevel(lv);
    setScore([0, 0]);
    setWon(null);
    sfx.go();
  };
  const onPointer = (e) => {
    if (!g.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    g.current.meTarget = clamp((e.clientX - r.left) / r.width, PW / 2, 1 - PW / 2);
  };

  useGameLoop(wrapRef, canvasRef, {
    height: (w) => Math.min(w * 1.5, window.innerHeight * 0.62),
    update(dt) {
      const s = g.current;
      if (!s || s.over) return;
      if (s.flash > 0) s.flash -= dt;
      // Your bat follows your finger (quick but not instant), the computer's chases the ball.
      const before = s.me;
      s.me = lerp(s.me, s.meTarget, Math.min(1, dt * 22));
      s.meVx = (s.me - before) / dt;
      const b = s.ball;
      const L = LEVEL[s.lv];
      let aim = 0.5;
      if (b.vy < 0) {
        // where the ball will cross the computer's end, bouncing off the sides
        let x = b.x + (b.vx * (CPU_Y - b.y) * s.aspect) / b.vy;
        const span = 1 - 2 * R;
        x = ((((x - R) % (2 * span)) + 2 * span) % (2 * span));
        aim = (x > span ? 2 * span - x : x) + R + s.cpuErr;
      }
      s.cpu += clamp(aim - s.cpu, -L.speed * dt, L.speed * dt);
      s.cpu = clamp(s.cpu, PW / 2, 1 - PW / 2);

      if (s.serve > 0) {
        s.serve -= dt;
        b.x = 0.5;
        b.y = 0.5;
        if (s.serve <= 0) {
          const a = ((Math.random() - 0.5) * 50 * Math.PI) / 180;
          b.speed = 1.0;
          b.vx = Math.sin(a) * b.speed;
          b.vy = Math.cos(a) * b.speed * s.serveTo;
          s.hitY = 0.5;
          s.bounced = false;
          sfx.pok();
        }
        s.prev = { x: b.x, y: b.y };
        return;
      }
      s.prev = { x: b.x, y: b.y };
      b.x += b.vx * dt;
      b.y += (b.vy * dt) / s.aspect; // the table is longer than it is wide
      const w = sideWalls(b.x, b.vx, R);
      b.x = w.x;
      b.vx = w.vx;
      if (w.hit) sfx.wall();
      // The ball touches the table once on the far side (a little "tik").
      const travel = Math.abs(b.y - s.hitY);
      if (!s.bounced && travel > 0.62) {
        s.bounced = true;
        sfx.tick();
      }
      // Bats.
      const ry = R / s.aspect;
      if (b.vy > 0 && s.prev.y + ry <= ME_Y && b.y + ry >= ME_Y && Math.abs(b.x - s.me) <= PW / 2 + R) {
        Object.assign(b, bounceOff(b, (b.x - s.me) / (PW / 2), true, s.meVx));
        b.y = ME_Y - ry;
        s.hitY = b.y;
        s.bounced = false;
        sfx.pok();
        navigator.vibrate?.(10);
        s.cpuErr = (Math.random() - 0.5) * 2 * L.miss;
      } else if (b.vy < 0 && s.prev.y - ry >= CPU_Y && b.y - ry <= CPU_Y && Math.abs(b.x - s.cpu) <= PW / 2 + R) {
        Object.assign(b, bounceOff(b, (b.x - s.cpu) / (PW / 2) + (Math.random() - 0.5) * 0.4, false));
        b.y = CPU_Y + ry;
        s.hitY = b.y;
        s.bounced = false;
        sfx.pok();
      }
      s.trail.push({ x: b.x, y: b.y });
      if (s.trail.length > 10) s.trail.shift();
      // A point.
      const who = pointTo(b.y);
      if (who) {
        s.pts = who === "me" ? [s.pts[0] + 1, s.pts[1]] : [s.pts[0], s.pts[1] + 1];
        setScore(s.pts);
        s.trail = [];
        s.flash = 0.5;
        s.serve = 1.1;
        s.serveTo = who === "me" ? -1 : 1; // the loser of the point gets served to
        const end = winner(...s.pts);
        if (end) {
          s.over = true;
          setWon(end);
          (end === "me" ? sfx.win : sfx.lose)();
        } else sfx.point();
      }
    },
    draw(ctx, W, H, a) {
      const s = g.current;
      if (s) s.aspect = H / W;
      // floor and table
      ctx.fillStyle = "#3b2f2a";
      ctx.fillRect(0, 0, W, H);
      const m = 8;
      const tg = ctx.createLinearGradient(0, 0, 0, H);
      tg.addColorStop(0, "#1d4f91");
      tg.addColorStop(0.5, "#2563b8");
      tg.addColorStop(1, "#1d4f91");
      ctx.fillStyle = tg;
      roundRect(ctx, m, m, W - m * 2, H - m * 2, 6);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.lineWidth = 3;
      roundRect(ctx, m + 4, m + 4, W - m * 2 - 8, H - m * 2 - 8, 3);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(W / 2, m + 4);
      ctx.lineTo(W / 2, H - m - 4);
      ctx.stroke();
      // scores, big and faint in each half
      const pts = s ? s.pts : [0, 0];
      ctx.fillStyle = "rgba(255,255,255,.13)";
      ctx.font = `800 ${Math.round(H * 0.16)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(pts[1]), W / 2, H * 0.25);
      ctx.fillText(String(pts[0]), W / 2, H * 0.75);
      // net
      ctx.fillStyle = "rgba(0,0,0,.25)";
      ctx.fillRect(0, H / 2 + 2, W, 6);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(0, H / 2 - 3, W, 5);
      ctx.fillStyle = "rgba(30,30,30,.55)";
      for (let x = 0; x < W; x += 6) ctx.fillRect(x, H / 2 - 3, 1, 5);
      if (!s) return;

      const bat = (x, y, face, top) => {
        const bw = PW * W;
        const px = x * W, py = y * H;
        ctx.fillStyle = "rgba(0,0,0,.3)";
        ctx.beginPath();
        ctx.ellipse(px + 4, py + 6, bw / 2, bw * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c08a4d"; // handle
        roundRect(ctx, px - bw * 0.07, top ? py - bw * 0.42 : py + bw * 0.12, bw * 0.14, bw * 0.3, 4);
        ctx.fill();
        const fg = ctx.createRadialGradient(px - bw * 0.15, py - bw * 0.05, 2, px, py, bw * 0.55);
        fg.addColorStop(0, face[0]);
        fg.addColorStop(1, face[1]);
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.ellipse(px, py, bw / 2, bw * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#c08a4d";
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      bat(s.cpu, CPU_Y, ["#4b5563", "#111827"], true);
      bat(s.me, ME_Y, ["#f87171", "#b91c1c"], false);

      // ball: trail, shadow, and a little hop (it looks higher mid-flight)
      const b = s.ball;
      const bx = lerp(s.prev.x, b.x, a) * W, byRaw = lerp(s.prev.y, b.y, a);
      const by = byRaw * H;
      const travel = Math.abs(byRaw - s.hitY);
      const hop = s.serve > 0 ? 0 : !s.bounced ? Math.sin(Math.min(1, travel / 0.62) * Math.PI) : Math.sin(Math.min(1, (travel - 0.62) / 0.5) * Math.PI) * 0.5;
      const rpx = R * W;
      s.trail.forEach((t, i) => {
        ctx.fillStyle = `rgba(255,255,255,${(i / s.trail.length) * 0.25})`;
        ctx.beginPath();
        ctx.arc(t.x * W, t.y * H, rpx * (0.4 + (i / s.trail.length) * 0.6), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "rgba(0,0,0,.3)";
      ctx.beginPath();
      ctx.ellipse(bx + hop * 10, by + hop * 14, rpx * (1 - hop * 0.3), rpx * 0.7 * (1 - hop * 0.3), 0, 0, Math.PI * 2);
      ctx.fill();
      const bg = ctx.createRadialGradient(bx - rpx * 0.3, by - rpx * 0.3 - hop * 4, 1, bx, by - hop * 4, rpx * (1 + hop * 0.35));
      bg.addColorStop(0, "#ffffff");
      bg.addColorStop(1, "#f59e0b");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(bx, by - hop * 4, rpx * (1 + hop * 0.35), 0, Math.PI * 2);
      ctx.fill();
      if (s.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${s.flash * 0.3})`;
        ctx.fillRect(0, 0, W, H);
      }
    },
  });

  return (
    <div className="gm-pong">
      <div className="gm-race-bar">
        <span>You <b>{score[0]}</b></span>
        <span>{level ? LEVEL[level].label : ""} computer <b>{score[1]}</b></span>
      </div>
      <div ref={wrapRef} className="gm-race-wrap pp-table" onPointerDown={onPointer} onPointerMove={onPointer}>
        <canvas ref={canvasRef} className="gm-canvas" aria-label="Ping pong table" />
        {(!level || won) && (
          <div className="gm-over">
            <b>{won ? (won === "me" ? "You win! 🏆" : "Computer wins 🤖") : "Ping Pong 🏓"}</b>
            <span>{won ? `${score[0]} – ${score[1]}` : "Drag anywhere to move your bat. Hit the ball with the bat's edge to angle it."}</span>
            <div className="pp-levels">
              <button className="btn btn-primary btn-lg" onClick={() => start("easy")}>Easy</button>
              <button className="btn btn-lg" onClick={() => start("normal")}>Normal</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
