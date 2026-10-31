import { describe, it, expect } from "vitest";
import { fromFen, perft, legalMoves, makeMove, gameState, bestMove, sq } from "../src/pages/customer/games/chessEngine.js";
import { newGame, rollDice, moveToken, movable, computerChoice, TRACK_CELLS, LANE_CELLS, cellOf, FINISH } from "../src/pages/customer/games/ludoRules.js";

const play = (s, from, to, promo) => makeMove(s, legalMoves(s).find((m) => m.from === sq(from) && m.to === sq(to) && (!promo || m.promo === promo)));

describe("chess rules (games while waiting)", () => {
  it("counts the standard perft numbers: castling, en passant and promotion are right", () => {
    expect(perft(fromFen(), 3)).toBe(8902);
    expect(perft(fromFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"), 2)).toBe(2039);
    expect(perft(fromFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"), 3)).toBe(2812);
    expect(perft(fromFen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"), 2)).toBe(264);
  });

  it("knows checkmate, stalemate and draws", () => {
    let s = fromFen();
    for (const [a, b] of [["f2", "f3"], ["e7", "e5"], ["g2", "g4"], ["d8", "h4"]]) s = play(s, a, b);
    expect(gameState(s)).toMatchObject({ over: true, result: "0-1", reason: "Checkmate" });
    expect(gameState(fromFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"))).toMatchObject({ over: true, result: "draw", reason: "Stalemate" });
    expect(gameState(fromFen("8/8/4k3/8/8/3NK3/8/8 w - - 0 1"))).toMatchObject({ over: true, result: "draw" });
    // Knights out and back twice: the same position a third time.
    s = fromFen();
    for (let i = 0; i < 2; i++) for (const [a, b] of [["g1", "f3"], ["g8", "f6"], ["f3", "g1"], ["f6", "g8"]]) s = play(s, a, b);
    expect(gameState(s)).toMatchObject({ over: true, reason: "Same position three times" });
  });

  it("lets a pawn become any piece", () => {
    const s = fromFen("8/P6k/8/8/8/8/8/K7 w - - 0 1");
    expect(legalMoves(s).filter((m) => m.promo).map((m) => m.promo).sort()).toEqual(["B", "N", "Q", "R"]);
    expect(play(s, "a7", "a8", "N").board[sq("a8")]).toBe("N");
  });

  it("the computer takes a free queen and finds mate in one", () => {
    const free = bestMove(fromFen("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1"), 2, () => 0);
    expect([free.from, free.to]).toEqual([sq("e4"), sq("d5")]);
    const mate = bestMove(fromFen("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"), 2, () => 0);
    expect(mate.to).toBe(sq("a8"));
  });
});

describe("Ludo rules (games while waiting)", () => {
  it("has a 52-square track and lanes that meet each colour's last square", () => {
    expect(TRACK_CELLS).toHaveLength(52);
    expect(new Set(TRACK_CELLS.map(String)).size).toBe(52);
    for (const c of ["red", "green", "yellow", "blue"]) {
      const [r1, c1] = cellOf(c, 50);
      const [r2, c2] = LANE_CELLS[c][0];
      expect(Math.abs(r1 - r2) + Math.abs(c1 - c2)).toBe(1); // next to each other
    }
  });

  it("needs a 6 to come out, gives another roll for a 6, and passes the turn otherwise", () => {
    let g = newGame(["blue", "green"]);
    g = rollDice(g, 3);
    expect(g.turn).toBe(1); // nothing could move
    g = { ...g, turn: 0 };
    g = rollDice(g, 6);
    expect(movable(g)).toEqual([0, 1, 2, 3]);
    g = moveToken(g, 0);
    expect(g.tokens.blue[0]).toBe(0);
    expect(g.turn).toBe(0); // rolls again
    g = moveToken(rollDice(g, 4), 0);
    expect(g.tokens.blue[0]).toBe(4);
    expect(g.turn).toBe(1);
  });

  it("three 6s lose the turn", () => {
    let g = newGame(["blue", "green"]);
    g = { ...g, tokens: { ...g.tokens, blue: [10, -1, -1, -1] } };
    g = moveToken(rollDice(g, 6), 0);
    g = moveToken(rollDice(g, 6), 0);
    g = rollDice(g, 6);
    expect(g.turn).toBe(1);
    expect(g.tokens.blue[0]).toBe(22);
  });

  it("captures off safe squares only, with another roll; needs an exact roll to finish", () => {
    let g = newGame(["blue", "green"]);
    // Blue at its progress 10 is track square 49; green there is progress 36.
    g = { ...g, tokens: { blue: [8, -1, -1, -1], green: [36, -1, -1, -1] } };
    g = moveToken(rollDice(g, 2), 0);
    expect(g.tokens.green[0]).toBe(-1);
    expect(g.last.captured).toBe(1);
    expect(g.turn).toBe(0);
    // On a star square (blue progress 8 = square 47) nobody is captured.
    g = { ...newGame(["blue", "green"]), tokens: { blue: [5, -1, -1, -1], green: [34, -1, -1, -1] } };
    g = moveToken(rollDice(g, 3), 0);
    expect(g.tokens.green[0]).toBe(34);
    // Exact roll home.
    g = { ...newGame(["blue", "green"]), tokens: { blue: [53, FINISH, FINISH, FINISH], green: [-1, -1, -1, -1] } };
    expect(movable(rollDice(g, 5))).toEqual([]);
    g = moveToken(rollDice(g, 3), 0);
    expect(g.winner).toBe("blue");
  });

  it("the computer prefers a capture", () => {
    let g = newGame(["green", "blue"]);
    // Green token 0 can hit blue (green progress 36 = square 49 = blue progress 10); token 1 just walks.
    g = { ...g, tokens: { green: [33, 2, -1, -1], blue: [10, -1, -1, -1] } };
    g = rollDice(g, 3);
    expect(computerChoice(g)).toBe(0);
  });
});

import { san } from "../src/pages/customer/games/chessEngine.js";
import { hopPath } from "../src/pages/customer/games/ludoRules.js";
import { newSnake, turn, step } from "../src/pages/customer/games/snakeRules.js";
import { bounceOff, sideWalls, pointTo, winner, MAX_SPEED } from "../src/pages/customer/games/pongRules.js";

describe("chess move list (SAN)", () => {
  const sanOf = (fen, from, to, promo) => {
    const s = fromFen(fen);
    return san(s, legalMoves(s).find((m) => m.from === sq(from) && m.to === sq(to) && (!promo || m.promo === promo)));
  };
  it("writes moves the usual way", () => {
    expect(sanOf(undefined, "e2", "e4")).toBe("e4");
    expect(sanOf(undefined, "g1", "f3")).toBe("Nf3");
    expect(sanOf("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1", "g1")).toBe("O-O");
    expect(sanOf("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1", "c1")).toBe("O-O-O");
    expect(sanOf("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4", "d5")).toBe("exd5");
    expect(sanOf("7k/P7/8/8/8/8/8/K7 w - - 0 1", "a7", "a8", "Q")).toBe("a8=Q+");
    expect(sanOf("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1", "a8")).toBe("Ra8#");
    // two knights can reach d2: say which one
    expect(sanOf("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1", "b1", "d2")).toBe("Nbd2");
  });
});

describe("Ludo hops", () => {
  it("hops square by square, and pops out of home onto the start square", () => {
    expect(hopPath(-1, 0)).toEqual([0]);
    expect(hopPath(4, 8)).toEqual([5, 6, 7, 8]);
  });
});

describe("Snake rules", () => {
  const rand = () => 0;
  it("moves, turns (never straight back) and grows when it eats", () => {
    let s = newSnake(10, 10, { rand });
    s = { ...s, food: { x: 6, y: 5 } };
    expect(turn(s, "left")).toBe(s); // reversing is ignored
    s = step(s, rand);
    expect(s.body[0]).toEqual({ x: 6, y: 5 });
    expect(s.body).toHaveLength(4);
    expect(s.events).toContain("eat");
    expect(s.score).toBe(10);
    s = step(turn(s, "down"), rand);
    expect(s.body[0]).toEqual({ x: 6, y: 6 });
    expect(s.body).toHaveLength(4);
  });
  it("wraps through walls, or ends on them with wrap off", () => {
    let s = { ...newSnake(10, 10, { rand }), body: [{ x: 9, y: 2 }, { x: 8, y: 2 }, { x: 7, y: 2 }], food: { x: 0, y: 0 } };
    expect(step(s, rand).body[0]).toEqual({ x: 0, y: 2 });
    s = { ...s, wrap: false };
    expect(step(s, rand).over).toBe(true);
  });
  it("ends when it bites itself", () => {
    const s = { ...newSnake(10, 10, { rand }), body: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 4 }], dir: "up", food: { x: 0, y: 0 } };
    expect(step(turn(s, "left"), rand).over).toBe(true);
  });
});

describe("Ping Pong physics", () => {
  it("angles the ball by where it hits the bat, a bit faster each time", () => {
    const mid = bounceOff({ speed: 1 }, 0, true);
    expect(mid.vx).toBeCloseTo(0);
    expect(mid.vy).toBeLessThan(0);
    const edge = bounceOff({ speed: 1 }, 1, true);
    expect(edge.vx).toBeGreaterThan(0.8);
    expect(edge.speed).toBeGreaterThan(1);
    expect(bounceOff({ speed: 99 }, 0, false).speed).toBe(MAX_SPEED);
  });
  it("bounces off the sides and scores past the ends", () => {
    expect(sideWalls(-0.01, -1, 0.02)).toMatchObject({ vx: 1, hit: true });
    expect(pointTo(-0.1)).toBe("me");
    expect(pointTo(1.1)).toBe("cpu");
    expect(pointTo(0.5)).toBe(null);
    expect(winner(7, 5)).toBe("me");
    expect(winner(7, 6)).toBe(null);
    expect(winner(9, 11)).toBe("cpu");
  });
});
