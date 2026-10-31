// A smooth game loop for the canvas games: the game updates in small fixed steps (so speed is
// the same on 60 Hz and 120 Hz phones) and draws once per screen refresh, blending between steps.
// Pauses while the page is hidden; keeps the canvas sharp on high-density screens.
import { useEffect, useRef } from "react";

export const STEP = 1 / 120;

/**
 * game: { update(dt), draw(ctx, W, H, alpha, now), height(width) } — read fresh every frame,
 * so it can be a new object each render.
 */
export function useGameLoop(wrapRef, canvasRef, game) {
  const g = useRef(game);
  g.current = game;
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, raf = 0, last = 0, acc = 0;
    const size = () => {
      const w = wrap.clientWidth;
      const h = Math.round(g.current.height(w));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      W = w;
      H = h;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) {
        last = 0;
        return;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      acc += dt;
      let n = 0;
      while (acc >= STEP && n++ < 24) {
        g.current.update(STEP);
        acc -= STEP;
      }
      if (n >= 24) acc = 0; // fell far behind: don't try to catch up
      g.current.draw(ctx, W, H, acc / STEP, now / 1000);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [wrapRef, canvasRef]);
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function readBest(key) {
  try {
    return Number(localStorage.getItem(key) || 0);
  } catch {
    return 0;
  }
}
export function saveBest(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* private mode */
  }
}

// Swipe direction from a pointer down/up pair: "left" | "right" | "up" | "down" | null (a tap).
export function swipeDir(a, b, min = 22) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
}
