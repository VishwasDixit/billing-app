// Snake rules (pure functions, no React): the classic phone game. The snake moves one square per
// step, eating food makes it longer, running into itself ends the game. Walls wrap around by
// default (as on the old phones); with wrap off, hitting a wall ends it too.

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
export const BONUS_EVERY = 5; // a bonus snack after every 5 foods
export const BONUS_STEPS = 30; // how long it stays

const free = (s, rand) => {
  const taken = new Set(s.body.map((b) => `${b.x},${b.y}`));
  if (s.food) taken.add(`${s.food.x},${s.food.y}`);
  if (s.bonus) taken.add(`${s.bonus.x},${s.bonus.y}`);
  const cells = [];
  for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) if (!taken.has(`${x},${y}`)) cells.push({ x, y });
  return cells.length ? cells[Math.floor(rand() * cells.length)] : null;
};

export function newSnake(cols = 16, rows = 20, { wrap = true, rand = Math.random } = {}) {
  const y = Math.floor(rows / 2);
  const s = { cols, rows, wrap, body: [{ x: 5, y }, { x: 4, y }, { x: 3, y }], dir: "right", queue: [], food: null, bonus: null, eaten: 0, score: 0, over: false, events: [] };
  s.food = free(s, rand);
  return s;
}

// Remember a turn for the next steps (up to two, so quick double-swipes work). No reversing.
export function turn(s, dir) {
  if (!DIRS[dir] || s.over) return s;
  const lastDir = s.queue.at(-1) || s.dir;
  if (dir === lastDir || dir === OPPOSITE[lastDir] || s.queue.length >= 2) return s;
  return { ...s, queue: [...s.queue, dir] };
}

export function step(s, rand = Math.random) {
  if (s.over) return s;
  const [dir, ...queue] = s.queue.length ? s.queue : [s.dir];
  const [dx, dy] = DIRS[dir];
  let x = s.body[0].x + dx;
  let y = s.body[0].y + dy;
  const events = [];
  if (s.wrap) {
    x = (x + s.cols) % s.cols;
    y = (y + s.rows) % s.rows;
  } else if (x < 0 || y < 0 || x >= s.cols || y >= s.rows) {
    return { ...s, dir, queue, over: true, events: ["over"] };
  }
  const eats = s.food && s.food.x === x && s.food.y === y;
  const eatsBonus = s.bonus && s.bonus.x === x && s.bonus.y === y;
  // The tail moves out of the way this step unless the snake is growing.
  const body = eats ? s.body : s.body.slice(0, -1);
  if (body.some((b) => b.x === x && b.y === y)) return { ...s, dir, queue, over: true, events: ["over"] };
  let next = { ...s, dir, queue, body: [{ x, y }, ...body], events };
  if (eats) {
    const eaten = s.eaten + 1;
    next = { ...next, eaten, score: s.score + 10 };
    events.push("eat");
    next.food = free(next, rand);
    if (eaten % BONUS_EVERY === 0) next.bonus = { ...free(next, rand), left: BONUS_STEPS };
  }
  if (eatsBonus) {
    events.push("bonus");
    next = { ...next, score: next.score + 5 * (s.bonus.left + 10), bonus: null };
  } else if (next.bonus) {
    next.bonus = next.bonus.left > 1 ? { ...next.bonus, left: next.bonus.left - 1 } : null;
  }
  return next;
}

// Seconds per step: starts relaxed and speeds up as it eats.
export const stepTime = (s) => Math.max(0.065, 0.16 - s.eaten * 0.004);
