// Chess rules and a small computer opponent (pure functions, no React).
// Board: 64 squares, index = row * 8 + col, row 0 is rank 8 (black's back row).
// Pieces: "PNBRQK" white, "pnbrqk" black, "" empty.

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function fromFen(fen = START) {
  const [rows, turn, castle, ep, half, full] = fen.split(" ");
  const board = [];
  for (const ch of rows.replace(/\//g, "")) {
    if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) board.push("");
    else board.push(ch);
  }
  return {
    board,
    turn,
    castle: castle === "-" ? "" : castle,
    ep: ep === "-" ? -1 : sq(ep),
    half: +half || 0,
    full: +full || 1,
    history: [],
  };
}

export const sq = (name) => (8 - +name[1]) * 8 + (name.charCodeAt(0) - 97);
export const sqName = (i) => String.fromCharCode(97 + (i % 8)) + (8 - Math.floor(i / 8));
export const isWhite = (p) => p !== "" && p === p.toUpperCase();
export const colorOf = (p) => (p === "" ? null : isWhite(p) ? "w" : "b");
const onBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ROOK = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

// Is square i attacked by side `by` ("w" or "b")?
export function attacked(board, i, by) {
  const r = Math.floor(i / 8), c = i % 8;
  const own = (p) => p !== "" && colorOf(p) === by;
  const is = (p, t) => own(p) && p.toLowerCase() === t;
  // pawns: a white pawn attacks upwards (row - 1), so it sits one row below
  const pr = by === "w" ? r + 1 : r - 1;
  for (const dc of [-1, 1]) if (onBoard(pr, c + dc) && is(board[pr * 8 + c + dc], "p")) return true;
  for (const [dr, dc] of KNIGHT) if (onBoard(r + dr, c + dc) && is(board[(r + dr) * 8 + c + dc], "n")) return true;
  for (const [dr, dc] of KING) if (onBoard(r + dr, c + dc) && is(board[(r + dr) * 8 + c + dc], "k")) return true;
  const slide = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (onBoard(rr, cc)) {
        const p = board[rr * 8 + cc];
        if (p !== "") {
          if (own(p) && types.includes(p.toLowerCase())) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
    return false;
  };
  return slide(ROOK, "rq") || slide(BISHOP, "bq");
}

const kingSq = (board, side) => board.indexOf(side === "w" ? "K" : "k");
export const inCheck = (s, side = s.turn) => attacked(s.board, kingSq(s.board, side), side === "w" ? "b" : "w");

// Moves that follow how pieces move, before checking the king is safe.
function pseudoMoves(s) {
  const { board, turn } = s;
  const moves = [];
  const enemy = turn === "w" ? "b" : "w";
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === "" || colorOf(p) !== turn) continue;
    const r = Math.floor(i / 8), c = i % 8;
    const t = p.toLowerCase();
    const add = (to, extra = {}) => moves.push({ from: i, to, piece: p, captured: board[to], ...extra });
    if (t === "p") {
      const dir = turn === "w" ? -1 : 1;
      const startRow = turn === "w" ? 6 : 1;
      const lastRow = turn === "w" ? 0 : 7;
      const push = (to, extra) => {
        if (Math.floor(to / 8) === lastRow) for (const promo of "qrbn") add(to, { ...extra, promo: turn === "w" ? promo.toUpperCase() : promo });
        else add(to, extra);
      };
      const one = (r + dir) * 8 + c;
      if (onBoard(r + dir, c) && board[one] === "") {
        push(one);
        const two = (r + 2 * dir) * 8 + c;
        if (r === startRow && board[two] === "") add(two, { double: true });
      }
      for (const dc of [-1, 1]) {
        if (!onBoard(r + dir, c + dc)) continue;
        const to = (r + dir) * 8 + c + dc;
        if (board[to] !== "" && colorOf(board[to]) === enemy) push(to);
        else if (to === s.ep) add(to, { enPassant: true, captured: turn === "w" ? "p" : "P" });
      }
    } else if (t === "n" || t === "k") {
      for (const [dr, dc] of t === "n" ? KNIGHT : KING) {
        if (!onBoard(r + dr, c + dc)) continue;
        const to = (r + dr) * 8 + c + dc;
        if (board[to] === "" || colorOf(board[to]) === enemy) add(to);
      }
      if (t === "k") {
        // Castling: rights kept, squares between empty, king not in, through or into check.
        const row = turn === "w" ? 7 : 0;
        const [kc, qc] = turn === "w" ? ["K", "Q"] : ["k", "q"];
        if (i === row * 8 + 4 && !attacked(board, i, enemy)) {
          if (s.castle.includes(kc) && board[row * 8 + 5] === "" && board[row * 8 + 6] === "" && !attacked(board, row * 8 + 5, enemy) && !attacked(board, row * 8 + 6, enemy))
            add(row * 8 + 6, { castle: "k" });
          if (s.castle.includes(qc) && board[row * 8 + 3] === "" && board[row * 8 + 2] === "" && board[row * 8 + 1] === "" && !attacked(board, row * 8 + 3, enemy) && !attacked(board, row * 8 + 2, enemy))
            add(row * 8 + 2, { castle: "q" });
        }
      }
    } else {
      const dirs = t === "r" ? ROOK : t === "b" ? BISHOP : [...ROOK, ...BISHOP];
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (onBoard(rr, cc)) {
          const to = rr * 8 + cc;
          if (board[to] === "") add(to);
          else {
            if (colorOf(board[to]) === enemy) add(to);
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
    }
  }
  return moves;
}

// Plays a move, returning a new state (the old one is left alone).
export function makeMove(s, m) {
  const board = s.board.slice();
  board[m.to] = m.promo || m.piece;
  board[m.from] = "";
  if (m.enPassant) board[m.to + (s.turn === "w" ? 8 : -8)] = "";
  if (m.castle) {
    const row = Math.floor(m.from / 8);
    const [rf, rt] = m.castle === "k" ? [row * 8 + 7, row * 8 + 5] : [row * 8, row * 8 + 3];
    board[rt] = board[rf];
    board[rf] = "";
  }
  let castle = s.castle;
  const drop = (chars) => (castle = castle.replace(new RegExp(`[${chars}]`, "g"), ""));
  if (m.piece === "K") drop("KQ");
  if (m.piece === "k") drop("kq");
  // A rook moving from, or captured on, its corner loses that side's castling.
  for (const at of [m.from, m.to]) {
    if (at === 63) drop("K");
    if (at === 56) drop("Q");
    if (at === 7) drop("k");
    if (at === 0) drop("q");
  }
  return {
    board,
    turn: s.turn === "w" ? "b" : "w",
    castle,
    ep: m.double ? (m.from + m.to) / 2 : -1,
    half: m.piece.toLowerCase() === "p" || m.captured ? 0 : s.half + 1,
    full: s.full + (s.turn === "b" ? 1 : 0),
    history: [...s.history, posKey(s)],
  };
}

export function legalMoves(s) {
  return pseudoMoves(s).filter((m) => !inCheck(makeMove(s, m), s.turn));
}

// Same position for repetition: pieces, side to move, castling and en passant.
const posKey = (s) => `${s.board.map((p) => p || ".").join("")}${s.turn}${s.castle}${s.ep}`;

function insufficient(board) {
  const rest = board.filter((p) => p !== "" && p.toLowerCase() !== "k");
  if (rest.length === 0) return true;
  return rest.length === 1 && "nNbB".includes(rest[0]);
}

// { over: false } or { over: true, result: "1-0" | "0-1" | "draw", reason }
export function gameState(s, moves = legalMoves(s)) {
  if (moves.length === 0) {
    if (inCheck(s)) return { over: true, result: s.turn === "w" ? "0-1" : "1-0", reason: "Checkmate" };
    return { over: true, result: "draw", reason: "Stalemate" };
  }
  if (insufficient(s.board)) return { over: true, result: "draw", reason: "Not enough pieces to checkmate" };
  if (s.half >= 100) return { over: true, result: "draw", reason: "50 moves without a capture or pawn move" };
  const key = posKey(s);
  if (s.history.filter((k) => k === key).length >= 2) return { over: true, result: "draw", reason: "Same position three times" };
  return { over: false };
}

// Counts positions n moves deep (used by the tests to check the rules).
export function perft(s, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(s)) n += perft(makeMove(s, m), depth - 1);
  return n;
}

// ── Computer opponent: material + a little positional sense, alpha-beta search. ──
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// Bonus for being near the centre / pushing pawns on (from white's side; mirrored for black).
const CENTER = [0, 1, 2, 3, 3, 2, 1, 0];
function evaluate(board) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p === "") continue;
    const t = p.toLowerCase();
    const r = Math.floor(i / 8), c = i % 8;
    let v = VALUE[t];
    if (t === "n" || t === "b") v += (CENTER[r] + CENTER[c]) * 4;
    if (t === "p") v += (isWhite(p) ? 6 - r : r - 1) * (c >= 2 && c <= 5 ? 9 : 3);
    if (t === "q") v += (CENTER[r] + CENTER[c]) * 1;
    score += isWhite(p) ? v : -v;
  }
  return score;
}

// Captures first (biggest prize, smallest attacker): alpha-beta cuts more.
const order = (moves) => moves.sort((a, b) => (b.captured ? VALUE[b.captured.toLowerCase()] * 10 - VALUE[b.piece.toLowerCase()] : 0) - (a.captured ? VALUE[a.captured.toLowerCase()] * 10 - VALUE[a.piece.toLowerCase()] : 0) + ((b.promo ? 800 : 0) - (a.promo ? 800 : 0)));

function search(s, depth, alpha, beta) {
  const moves = legalMoves(s);
  if (moves.length === 0) return inCheck(s) ? -100000 - depth : 0;
  if (depth === 0) return (s.turn === "w" ? 1 : -1) * evaluate(s.board);
  let best = -Infinity;
  for (const m of order(moves)) {
    const v = -search(makeMove(s, m), depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * The computer's move. level 1 = easy (one move ahead, some randomness), 2 = normal, 3 = harder.
 * `random` is injectable for tests.
 */
export function bestMove(s, level = 2, random = Math.random) {
  const moves = order(legalMoves(s));
  if (!moves.length) return null;
  const depth = level >= 3 ? 3 : level === 2 ? 2 : 1;
  const scored = moves.map((m) => ({ m, v: -search(makeMove(s, m), depth - 1, -Infinity, Infinity) + random() * (level === 1 ? 120 : 12) }));
  scored.sort((a, b) => b.v - a.v);
  return scored[0].m;
}
