// Chess against the computer: you play white. Tap a piece, then a highlighted square.
// Rules and the computer's thinking are in chessEngine.js.
import { useEffect, useMemo, useState } from "react";
import { fromFen, legalMoves, makeMove, gameState, inCheck, bestMove, colorOf, sqName } from "./chessEngine.js";

// Filled chess symbols for both sides (coloured by CSS); ︎ keeps phones from showing emoji.
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const LEVELS = [
  [1, "Easy"],
  [2, "Normal"],
  [3, "Hard"],
];
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export default function Chess() {
  const [level, setLevel] = useState(null);
  const [s, setS] = useState(() => fromFen());
  const [sel, setSel] = useState(-1);
  const [last, setLast] = useState(null);
  const [promo, setPromo] = useState(null); // moves waiting for the person to choose a piece
  const [past, setPast] = useState([]); // states before each of your moves (for Undo)

  const moves = useMemo(() => legalMoves(s), [s]);
  const state = useMemo(() => gameState(s, moves), [s, moves]);
  const targets = sel >= 0 ? moves.filter((m) => m.from === sel) : [];
  const thinking = level && s.turn === "b" && !state.over;

  // The computer's move, a moment after yours (so the board redraws first).
  useEffect(() => {
    if (!thinking) return;
    const t = setTimeout(() => {
      const m = bestMove(s, level);
      if (m) {
        setS(makeMove(s, m));
        setLast(m);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [thinking, s, level]);

  const play = (m) => {
    setPast((p) => [...p, { s, last }]);
    setS(makeMove(s, m));
    setLast(m);
    setSel(-1);
    setPromo(null);
  };
  const tap = (i) => {
    if (s.turn !== "w" || state.over) return;
    const ms = targets.filter((m) => m.to === i);
    if (ms.length > 1) return setPromo(ms); // a pawn reaching the end: queen, rook, bishop or knight
    if (ms.length === 1) return play(ms[0]);
    setSel(colorOf(s.board[i]) === "w" && i !== sel ? i : -1);
  };
  const undo = () => {
    const p = past.at(-1);
    if (!p) return;
    setS(p.s);
    setLast(p.last);
    setPast(past.slice(0, -1));
    setSel(-1);
    setPromo(null);
  };
  const restart = () => {
    setS(fromFen());
    setLast(null);
    setSel(-1);
    setPast([]);
    setPromo(null);
    setLevel(null);
  };

  if (!level)
    return (
      <div className="gm-setup">
        <b>Chess ♟️</b>
        <span className="small muted">You play white. Pick how strong the computer is.</span>
        {LEVELS.map(([n, label]) => (
          <button key={n} className={"btn btn-lg" + (n === 1 ? " btn-primary" : "")} onClick={() => setLevel(n)}>{label}</button>
        ))}
      </div>
    );

  // Captured pieces, from what's missing on the board.
  const count = (p) => s.board.filter((x) => x === p).length;
  const START_N = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const lost = (side) => Object.entries(START_N).flatMap(([t, n]) => Array(Math.max(0, n - count(side === "w" ? t.toUpperCase() : t))).fill(t));
  const takenByMe = lost("b"), takenByCpu = lost("w");
  const lead = takenByMe.reduce((a, t) => a + VAL[t], 0) - takenByCpu.reduce((a, t) => a + VAL[t], 0);
  const check = !state.over && inCheck(s);
  const kingInCheck = check ? s.board.indexOf(s.turn === "w" ? "K" : "k") : -1;

  return (
    <div className="gm-chess">
      <div className="ch-taken">
        <span>{takenByCpu.map((t, i) => <i key={i} className="ch-mini w">{GLYPH[t]}{"︎"}</i>)}</span>
        {lead < 0 && <small>+{-lead}</small>}
      </div>
      <div className="ch-board" role="grid" aria-label="Chess board">
        {s.board.map((p, i) => {
          const r = Math.floor(i / 8), c = i % 8;
          const t = targets.find((m) => m.to === i);
          const cls = ["ch-sq", (r + c) % 2 ? "dark" : "light"];
          if (i === sel) cls.push("sel");
          if (last && (i === last.from || i === last.to)) cls.push("last");
          if (i === kingInCheck) cls.push("check");
          return (
            <button key={i} className={cls.join(" ")} onClick={() => tap(i)} aria-label={`${sqName(i)}${p ? ` ${colorOf(p) === "w" ? "white" : "black"} ${p.toLowerCase()}` : ""}`}>
              {p && <span className={`ch-piece ${colorOf(p)}`}>{GLYPH[p.toLowerCase()]}{"︎"}</span>}
              {t && <i className={p ? "ch-hit cap" : "ch-hit"} />}
              {c === 0 && <small className="ch-rank">{8 - r}</small>}
              {r === 7 && <small className="ch-file">{"abcdefgh"[c]}</small>}
            </button>
          );
        })}
        {promo && (
          <div className="ch-promo">
            <span>Turn your pawn into:</span>
            <div>
              {["Q", "R", "B", "N"].map((k) => (
                <button key={k} onClick={() => play(promo.find((m) => m.promo === k))} aria-label={k}>
                  <span className="ch-piece w">{GLYPH[k.toLowerCase()]}{"︎"}</span>
                </button>
              ))}
            </div>
            <button className="link-btn" onClick={() => setPromo(null)}>Cancel</button>
          </div>
        )}
      </div>
      <div className="ch-taken">
        <span>{takenByMe.map((t, i) => <i key={i} className="ch-mini b">{GLYPH[t]}{"︎"}</i>)}</span>
        {lead > 0 && <small>+{lead}</small>}
      </div>
      <div className="ch-status">
        {state.over ? (
          <b>{state.result === "1-0" ? "Checkmate. You win! 🏆" : state.result === "0-1" ? "Checkmate. The computer wins." : `Draw: ${state.reason.toLowerCase()}.`}</b>
        ) : thinking ? (
          <b>Computer is thinking… 🤔</b>
        ) : (
          <b>{check ? "Check! Your move." : "Your move."}</b>
        )}
        <span className="small muted">{LEVELS.find(([n]) => n === level)[1]} computer</span>
      </div>
      <div className="ch-actions">
        <button className="btn" onClick={undo} disabled={!past.length || thinking}>↩ Undo</button>
        <button className="btn" onClick={restart}>New game</button>
      </div>
    </div>
  );
}
