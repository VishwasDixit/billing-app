// Ludo rules (pure functions, no React). Usual public rules:
// - roll a 6 to bring a token out onto your start square; a 6 also gives another roll,
//   but three 6s in a row lose the turn
// - landing on an opponent's token (not on a safe square) sends it back home, and you roll again
// - tokens go once round the board, up their own colour's lane and need an exact roll to finish;
//   finishing a token gives another roll
// - the first to bring all four tokens home wins
//
// A token's progress: -1 at home base, 0..50 on the shared track (from its own start square),
// 51..55 in its colour's lane, 56 finished.

export const COLORS = ["red", "green", "yellow", "blue"];
export const FINISH = 56;
const TRACK = 52;
export const START = { red: 0, green: 13, yellow: 26, blue: 39 }; // where each colour comes out
// Start squares and the star squares 8 steps after each are safe.
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// The 52 shared squares as [row, col] on a 15×15 board, clockwise from red's start.
export const TRACK_CELLS = (() => {
  const cells = [];
  const run = (r, c, dr, dc, n) => {
    for (let i = 0; i < n; i++) cells.push([r + dr * i, c + dc * i]);
  };
  run(6, 1, 0, 1, 5);
  run(5, 6, -1, 0, 6);
  cells.push([0, 7]);
  run(0, 8, 1, 0, 6);
  run(6, 9, 0, 1, 6);
  cells.push([7, 14]);
  run(8, 14, 0, -1, 6);
  run(9, 8, 1, 0, 6);
  cells.push([14, 7]);
  run(14, 6, -1, 0, 6);
  run(8, 5, 0, -1, 6);
  cells.push([7, 0]);
  cells.push([6, 0]);
  return cells;
})();

// Each colour's own lane to the centre (5 squares).
export const LANE_CELLS = {
  red: [1, 2, 3, 4, 5].map((c) => [7, c]),
  green: [1, 2, 3, 4, 5].map((r) => [r, 7]),
  yellow: [13, 12, 11, 10, 9].map((c) => [7, c]),
  blue: [13, 12, 11, 10, 9].map((r) => [r, 7]),
};

export const trackIndex = (color, progress) => (progress >= 0 && progress <= 50 ? (START[color] + progress) % TRACK : -1);

export function cellOf(color, progress) {
  if (progress < 0 || progress >= FINISH) return null;
  if (progress <= 50) return TRACK_CELLS[trackIndex(color, progress)];
  return LANE_CELLS[color][progress - 51];
}

/** players: colours in turn order, the first is the person. */
export function newGame(players = ["blue", "green"]) {
  return {
    players,
    tokens: Object.fromEntries(players.map((c) => [c, [-1, -1, -1, -1]])),
    turn: 0, // index into players
    roll: null, // the dice value waiting to be used
    sixes: 0, // 6s rolled in a row this turn
    winner: null,
    last: null, // what just happened, for the message line
  };
}

export const current = (g) => g.players[g.turn];

// Which of the current player's tokens can move with this roll.
export function movable(g, roll = g.roll) {
  if (roll == null) return [];
  const color = current(g);
  return g.tokens[color].map((p, i) => ((p === -1 ? roll === 6 : p + roll <= FINISH) ? i : -1)).filter((i) => i >= 0);
}

function nextTurn(g) {
  return { ...g, turn: (g.turn + 1) % g.players.length, roll: null, sixes: 0 };
}

// Rolls the dice for the current player. With nothing to move, the turn passes on.
export function rollDice(g, value) {
  if (g.winner || g.roll != null) return g;
  const sixes = value === 6 ? g.sixes + 1 : 0;
  const who = current(g);
  if (sixes === 3) return { ...nextTurn(g), last: { color: who, roll: value, text: "three sixes" } };
  const rolled = { ...g, roll: value, sixes, last: { color: who, roll: value } };
  if (movable(rolled).length === 0) return { ...nextTurn(rolled), last: { color: who, roll: value, text: "no move" } };
  return rolled;
}

// Moves token i of the current player by the rolled value.
export function moveToken(g, i) {
  if (!movable(g).includes(i)) return g;
  const color = current(g);
  const roll = g.roll;
  const tokens = Object.fromEntries(Object.entries(g.tokens).map(([c, t]) => [c, t.slice()]));
  const from = tokens[color][i];
  const to = from === -1 ? 0 : from + roll;
  tokens[color][i] = to;
  // Capture: opponents on the same shared square go back home (not on safe squares).
  let captured = 0;
  const at = trackIndex(color, to);
  if (at >= 0 && !SAFE.has(at)) {
    for (const c of g.players) {
      if (c === color) continue;
      tokens[c] = tokens[c].map((p) => {
        if (trackIndex(c, p) === at) {
          captured++;
          return -1;
        }
        return p;
      });
    }
  }
  const finished = to === FINISH;
  const won = tokens[color].every((p) => p === FINISH);
  const g2 = { ...g, tokens, last: { color, roll, moved: i, from, to, captured, finished } };
  if (won) return { ...g2, roll: null, winner: color };
  // Another go after a 6, a capture or bringing a token home.
  if (roll === 6 || captured || finished) return { ...g2, roll: null };
  return nextTurn(g2);
}

// The squares a token passes through, one hop each (from home it pops onto its start square).
export function hopPath(from, to) {
  if (from === -1) return [0];
  const path = [];
  for (let p = from + 1; p <= to; p++) path.push(p);
  return path;
}

// Opponent tokens that could land on shared square `at` with one roll (1–6).
function danger(g, color, at) {
  if (at < 0 || SAFE.has(at)) return 0;
  let n = 0;
  for (const c of g.players) {
    if (c === color) continue;
    for (const p of g.tokens[c]) {
      const from = trackIndex(c, p);
      if (from < 0) continue;
      const gap = (at - from + TRACK) % TRACK;
      // It mustn't pass its own lane entry to get there.
      if (gap >= 1 && gap <= 6 && p + gap <= 50) n++;
    }
  }
  return n;
}

// The computer's choice: finish > capture > come out > reach safety > run from danger > go furthest.
export function computerChoice(g) {
  const options = movable(g);
  if (!options.length) return null;
  const color = current(g);
  let best = options[0], bestScore = -Infinity;
  for (const i of options) {
    const from = g.tokens[color][i];
    const after = moveToken(g, i);
    const to = after.tokens[color][i];
    const at = trackIndex(color, to);
    let score = to * 0.5;
    if (to === FINISH) score += 100;
    if (after.last.captured) score += 60;
    if (from === -1) score += 35;
    if (to > 50) score += 25; // safe in its own lane
    if (at >= 0 && SAFE.has(at)) score += 15;
    score += danger(g, color, trackIndex(color, from)) * 18;
    score -= danger(after, color, at) * 22;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
