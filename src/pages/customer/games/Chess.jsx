// Chess against the computer: you play white. Tap a piece then a square, or drag it there.
// Pieces slide to their new squares; a move list and sounds follow the game.
// Rules and the computer's thinking are in chessEngine.js.
import { useEffect, useMemo, useRef, useState } from "react";
import { fromFen, legalMoves, makeMove, gameState, inCheck, bestMove, colorOf, sqName, san } from "./chessEngine.js";
import { Piece, PieceDefs } from "./pieces.jsx";
import { sfx } from "./sound.js";

const LEVELS = [
  [1, "Easy"],
  [2, "Normal"],
  [3, "Hard"],
];
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_N = { p: 8, n: 2, b: 2, r: 2, q: 1 };

// Every piece keeps an id while it moves, so it can slide from square to square.
const startIds = (board) => board.map((p, i) => (p ? `${p}${i}` : null));
function moveIds(ids, m, turn) {
  const next = ids.slice();
  next[m.to] = next[m.from];
  next[m.from] = null;
  if (m.enPassant) next[m.to + (turn === "w" ? 8 : -8)] = null;
  if (m.castle) {
    const row = Math.floor(m.from / 8);
    const [rf, rt] = m.castle === "k" ? [row * 8 + 7, row * 8 + 5] : [row * 8, row * 8 + 3];
    next[rt] = next[rf];
    next[rf] = null;
  }
  return next;
}

function moveSound(m, after) {
  const st = gameState(after);
  if (st.over) return st.result === "1-0" ? sfx.win() : st.result === "0-1" ? sfx.lose() : sfx.point();
  if (inCheck(after)) return sfx.check();
  if (m.captured) return sfx.capture();
  sfx.move();
}

export default function Chess() {
  const [level, setLevel] = useState(null);
  const [game, setGame] = useState(() => {
    const s = fromFen();
    return { s, ids: startIds(s.board), last: null, list: [] };
  });
  const [sel, setSel] = useState(-1);
  const [promo, setPromo] = useState(null); // moves waiting for the person to choose a piece
  const [past, setPast] = useState([]); // games before each of your moves (for Undo)
  const [drag, setDrag] = useState(null); // { from, x, y } in board pixels
  const boardRef = useRef(null);
  const dragRef = useRef(null);
  const listRef = useRef(null);
  const { s, ids, last, list } = game;

  const moves = useMemo(() => legalMoves(s), [s]);
  const state = useMemo(() => gameState(s, moves), [s, moves]);
  const targets = sel >= 0 ? moves.filter((m) => m.from === sel) : [];
  const thinking = level && s.turn === "b" && !state.over;

  const apply = (g, m) => {
    const after = makeMove(g.s, m);
    moveSound(m, after);
    return { s: after, ids: moveIds(g.ids, m, g.s.turn), last: m, list: [...g.list, san(g.s, m)] };
  };

  // The computer's move, a moment after yours (so your piece finishes sliding first).
  useEffect(() => {
    if (!thinking) return;
    const t = setTimeout(() => {
      const m = bestMove(s, level);
      if (m) setGame((g) => apply(g, m));
    }, 420);
    return () => clearTimeout(t);
  }, [thinking, s, level]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.scrollTo({ left: 1e6, behavior: "smooth" });
  }, [list.length]);

  const play = (m) => {
    setPast((p) => [...p, game]);
    setGame((g) => apply(g, m));
    setSel(-1);
    setPromo(null);
  };
  const tryMove = (from, to) => {
    const ms = moves.filter((m) => m.from === from && m.to === to);
    if (ms.length > 1) return setPromo(ms), true; // a pawn reaching the end: queen, rook, bishop or knight
    if (ms.length === 1) return play(ms[0]), true;
    return false;
  };
  const myTurn = () => s.turn === "w" && !state.over && !promo;

  // Taps and drags on the board.
  const squareAt = (e) => {
    const r = boardRef.current.getBoundingClientRect();
    const c = Math.floor(((e.clientX - r.left) / r.width) * 8);
    const row = Math.floor(((e.clientY - r.top) / r.height) * 8);
    return c < 0 || c > 7 || row < 0 || row > 7 ? -1 : row * 8 + c;
  };
  const onDown = (e) => {
    if (!myTurn()) return;
    const i = squareAt(e);
    if (i < 0) return;
    if (colorOf(s.board[i]) === "w") {
      dragRef.current = { from: i, x0: e.clientX, y0: e.clientY, moved: false, wasSel: sel === i };
      setSel(i);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } else dragRef.current = { tap: i };
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || d.tap != null) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
    d.moved = true;
    const r = boardRef.current.getBoundingClientRect();
    setDrag({ from: d.from, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (d.tap != null) {
      if (sel >= 0 && tryMove(sel, d.tap)) return;
      return setSel(-1);
    }
    if (d.moved) {
      const to = squareAt(e);
      if (to >= 0 && to !== d.from && tryMove(d.from, to)) return;
      return;
    }
    if (d.wasSel) setSel(-1);
  };

  const undo = () => {
    const p = past.at(-1);
    if (!p) return;
    setGame(p);
    setPast(past.slice(0, -1));
    setSel(-1);
    setPromo(null);
  };
  const restart = () => {
    const s0 = fromFen();
    setGame({ s: s0, ids: startIds(s0.board), last: null, list: [] });
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
          <button key={n} className={"btn btn-lg" + (n === 1 ? " btn-primary" : "")} onClick={() => (setLevel(n), sfx.blip())}>{label}</button>
        ))}
      </div>
    );

  // Captured pieces, from what's missing on the board.
  const count = (p) => s.board.filter((x) => x === p).length;
  const lost = (side) => Object.entries(START_N).flatMap(([t, n]) => Array(Math.max(0, n - count(side === "w" ? t.toUpperCase() : t))).fill(t));
  const takenByMe = lost("b"), takenByCpu = lost("w");
  const lead = takenByMe.reduce((a, t) => a + VAL[t], 0) - takenByCpu.reduce((a, t) => a + VAL[t], 0);
  const check = !state.over && inCheck(s);
  const kingInCheck = check ? s.board.indexOf(s.turn === "w" ? "K" : "k") : -1;

  return (
    <div className="gm-chess">
      <PieceDefs />
      <div className="ch-taken">
        <span>{takenByCpu.map((t, i) => <i key={i} className="ch-mini"><Piece p={t.toUpperCase()} /></i>)}</span>
        {lead < 0 && <small>+{-lead}</small>}
      </div>
      <div className="ch-frame">
        <div className="ch-board" ref={boardRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => ((dragRef.current = null), setDrag(null))} role="grid" aria-label="Chess board">
          {s.board.map((p, i) => {
            const r = Math.floor(i / 8), c = i % 8;
            const t = targets.find((m) => m.to === i);
            const cls = ["ch-sq", (r + c) % 2 ? "dark" : "light"];
            if (i === sel) cls.push("sel");
            if (last && (i === last.from || i === last.to)) cls.push("last");
            if (i === kingInCheck) cls.push("check");
            return (
              <div key={i} className={cls.join(" ")} role="gridcell" aria-label={`${sqName(i)}${p ? ` ${colorOf(p) === "w" ? "white" : "black"} ${p.toLowerCase()}` : ""}`}>
                {t && <i className={p ? "ch-hit cap" : "ch-hit"} />}
                {c === 0 && <small className="ch-rank">{8 - r}</small>}
                {r === 7 && <small className="ch-file">{"abcdefgh"[c]}</small>}
              </div>
            );
          })}
          <div className="ch-pieces" aria-hidden="true">
            {s.board.map((p, i) => {
              if (!p) return null;
              const dragging = drag && drag.from === i;
              const style = dragging
                ? { transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -60%) scale(1.18)`, transition: "none", zIndex: 5 }
                : { transform: `translate(${(i % 8) * 100}%, ${Math.floor(i / 8) * 100}%)` };
              return (
                <div key={ids[i] || i} className={"ch-p" + (dragging ? " drag" : "")} style={style}>
                  <Piece p={p} />
                </div>
              );
            })}
          </div>
          {promo && (
            <div className="ch-promo" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
              <span>Turn your pawn into:</span>
              <div>
                {["Q", "R", "B", "N"].map((k) => (
                  <button key={k} onClick={() => play(promo.find((m) => m.promo === k))} aria-label={k}>
                    <Piece p={k} />
                  </button>
                ))}
              </div>
              <button className="link-btn" onClick={() => setPromo(null)}>Cancel</button>
            </div>
          )}
        </div>
      </div>
      <div className="ch-taken">
        <span>{takenByMe.map((t, i) => <i key={i} className="ch-mini"><Piece p={t} /></i>)}</span>
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
      {list.length > 0 && (
        <div className="ch-moves" ref={listRef}>
          {list.map((m, i) => (
            <span key={i} className={i === list.length - 1 ? "now" : ""}>
              {i % 2 === 0 && <b>{i / 2 + 1}.</b>}
              {m}
            </span>
          ))}
        </div>
      )}
      <div className="ch-actions">
        <button className="btn" onClick={undo} disabled={!past.length || thinking}>↩ Undo</button>
        <button className="btn" onClick={restart}>New game</button>
      </div>
    </div>
  );
}
