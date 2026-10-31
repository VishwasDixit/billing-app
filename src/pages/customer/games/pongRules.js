// Ping Pong physics (pure functions). The table is 1 wide and 1 long; you're at the bottom
// (y = 1), the computer at the top (y = 0). Speeds are in table-lengths per second.

export const MAX_ANGLE = (60 * Math.PI) / 180;
export const SPEED_UP = 1.06; // each return is a little faster
export const MAX_SPEED = 2.4;
export const WIN_AT = 7;

/**
 * The ball comes off a paddle: where it hit (offset -1 left edge … 1 right edge) sets the angle,
 * a moving paddle adds a little spin. `up` is true for your paddle (the ball goes up the table).
 */
export function bounceOff({ speed }, offset, up, paddleVx = 0) {
  const o = Math.max(-1, Math.min(1, offset));
  const s = Math.min(MAX_SPEED, speed * SPEED_UP);
  const angle = o * MAX_ANGLE;
  const vx = Math.sin(angle) * s + paddleVx * 0.25;
  const vy = Math.cos(angle) * s * (up ? -1 : 1);
  return { vx, vy, speed: s };
}

// Bounce off the side walls: { x, vx } back inside the table (r = ball radius).
export function sideWalls(x, vx, r) {
  if (x < r) return { x: r + (r - x), vx: Math.abs(vx), hit: true };
  if (x > 1 - r) return { x: 1 - r - (x - (1 - r)), vx: -Math.abs(vx), hit: true };
  return { x, vx, hit: false };
}

// Who won the point once the ball is past an end ("me" | "cpu" | null).
export const pointTo = (y) => (y < -0.04 ? "me" : y > 1.04 ? "cpu" : null);

// Game over: first to 7, two clear points ahead.
export function winner(me, cpu) {
  if ((me >= WIN_AT || cpu >= WIN_AT) && Math.abs(me - cpu) >= 2) return me > cpu ? "me" : "cpu";
  return null;
}
