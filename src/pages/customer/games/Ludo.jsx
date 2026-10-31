// Ludo against the computer (1 or 3 opponents). Rules in ludoRules.js; you play blue.
import { useEffect, useState } from "react";
import { COLORS, SAFE, TRACK_CELLS, LANE_CELLS, START, FINISH, newGame, current, movable, rollDice, moveToken, computerChoice, cellOf } from "./ludoRules.js";

const CELL = 20;
const HUE = { red: "#e5484d", green: "#30a46c", yellow: "#f5b400", blue: "#3e63dd" };
const NAME = { red: "Red", green: "Green", yellow: "Yellow", blue: "Blue" };
const BASE = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] }; // top-left cell of each corner
const ME = "blue";
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const roll6 = () => {
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b);
  while (b[0] >= 252); // no bias
  return (b[0] % 6) + 1;
};

// Where a token is drawn (centre, in board units).
function spot(color, progress, i) {
  if (progress === -1) {
    const [r, c] = BASE[color];
    return [(c + (i % 2 ? 4 : 2)) * CELL, (r + (i < 2 ? 2 : 4)) * CELL];
  }
  if (progress === FINISH) {
    // In the middle, on its own colour's side.
    const off = { red: [-1, 0], green: [0, -1], yellow: [1, 0], blue: [0, 1] }[color];
    return [7.5 * CELL + off[0] * 16 + (i - 1.5) * 4 * Math.abs(off[1]), 7.5 * CELL + off[1] * 16 + (i - 1.5) * 4 * Math.abs(off[0])];
  }
  const [r, c] = cellOf(color, progress);
  return [(c + 0.5) * CELL, (r + 0.5) * CELL];
}

function Board({ g, choices, onPick }) {
  const cells = [];
  TRACK_CELLS.forEach(([r, c], idx) => {
    const startOf = COLORS.find((k) => START[k] === idx);
    cells.push(
      <g key={`t${idx}`}>
        <rect x={c * CELL} y={r * CELL} width={CELL} height={CELL} className="ld-cell" style={startOf ? { fill: HUE[startOf] } : undefined} />
        {SAFE.has(idx) && !startOf && <text x={(c + 0.5) * CELL} y={(r + 0.5) * CELL + 5} className="ld-star">★</text>}
      </g>
    );
  });
  for (const k of COLORS)
    LANE_CELLS[k].forEach(([r, c], i) => cells.push(<rect key={`l${k}${i}`} x={c * CELL} y={r * CELL} width={CELL} height={CELL} className="ld-cell" style={{ fill: HUE[k] }} />));

  // Tokens sharing a square sit side by side.
  const tokens = [];
  const crowd = new Map();
  for (const color of g.players)
    g.tokens[color].forEach((p, i) => {
      const [x, y] = spot(color, p, i);
      const key = p >= 0 && p < FINISH ? `${x},${y}` : `${color}${i}`;
      const n = crowd.get(key) || 0;
      crowd.set(key, n + 1);
      tokens.push({ color, i, x, y, key, n, p });
    });
  return (
    <svg viewBox="0 0 300 300" className="ld-board" role="img" aria-label="Ludo board">
      <rect width="300" height="300" className="ld-bg" rx="8" />
      {COLORS.map((k) => {
        const [r, c] = BASE[k];
        return (
          <g key={k}>
            <rect x={c * CELL} y={r * CELL} width={6 * CELL} height={6 * CELL} fill={HUE[k]} rx="6" />
            <rect x={(c + 1) * CELL} y={(r + 1) * CELL} width={4 * CELL} height={4 * CELL} className="ld-yard" rx="8" />
            {[0, 1, 2, 3].map((i) => {
              const [x, y] = spot(k, -1, i);
              return <circle key={i} cx={x} cy={y} r="7" fill={HUE[k]} opacity=".25" />;
            })}
          </g>
        );
      })}
      {cells}
      {/* the centre: four triangles, each colour's lane points into its own */}
      <polygon points="120,120 150,150 120,180" fill={HUE.red} />
      <polygon points="120,120 180,120 150,150" fill={HUE.green} />
      <polygon points="180,120 180,180 150,150" fill={HUE.yellow} />
      <polygon points="120,180 150,150 180,180" fill={HUE.blue} />
      {tokens.map((t) => {
        const total = crowd.get(t.key);
        const shift = total > 1 ? (t.n - (total - 1) / 2) * 6 : 0;
        const can = t.color === current(g) && choices.includes(t.i);
        const r = t.p === FINISH ? 4.5 : total > 1 ? 6 : 7.5;
        return (
          <g
            key={`${t.color}${t.i}`}
            className={"ld-token" + (can ? " can" : "")}
            style={{ transform: `translate(${t.x + shift}px, ${t.y}px)` }}
            onClick={can ? () => onPick(t.i) : undefined}
            role={can ? "button" : undefined}
            aria-label={can ? `Move token ${t.i + 1}` : undefined}
          >
            {can && <circle r="13" className="ld-hit" />}
            {can && <circle r={r + 3.5} className="ld-ring" />}
            <circle r={r} fill={HUE[t.color]} className="ld-piece" />
            <circle r={r * 0.4} className="ld-piece-top" />
          </g>
        );
      })}
    </svg>
  );
}

function Die({ value, rolling }) {
  return (
    <span className={"ld-die" + (rolling ? " rolling" : "")} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => <i key={i} className={value && PIPS[value].includes(i) ? "pip" : ""} />)}
    </span>
  );
}

export default function Ludo() {
  const [g, setG] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [shown, setShown] = useState(null); // last dice value, kept after the move for the picture

  const who = g && current(g);
  const mine = who === ME;
  const choices = g && g.roll != null ? movable(g) : [];

  const doRoll = () => {
    if (!g || g.roll != null || g.winner || rolling) return;
    setRolling(true);
    setTimeout(() => {
      const v = roll6();
      setShown(v);
      setRolling(false);
      setG((x) => rollDice(x, v));
    }, 450);
  };
  const pick = (i) => setG((x) => moveToken(x, i));

  // The computer plays its turns; for you, a single possible move is made for you.
  useEffect(() => {
    if (!g || g.winner) return;
    if (!mine && g.roll == null && !rolling) {
      const t = setTimeout(doRoll, 650);
      return () => clearTimeout(t);
    }
    if (g.roll != null && (!mine || choices.length === 1)) {
      const t = setTimeout(() => pick(mine ? choices[0] : computerChoice(g)), mine ? 350 : 600);
      return () => clearTimeout(t);
    }
  }, [g, rolling]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g)
    return (
      <div className="gm-setup">
        <b>Ludo 🎲</b>
        <span className="small muted">You're blue. Roll a 6 to bring a token out. Land on someone to send them home. Stars and start squares are safe.</span>
        <button className="btn btn-primary btn-lg" onClick={() => setG(newGame([ME, "green"]))}>Play vs 1 computer</button>
        <button className="btn btn-lg" onClick={() => setG(newGame([ME, "red", "green", "yellow"]))}>Play vs 3 computers</button>
      </div>
    );

  const l = g.last;
  const said = !l
    ? "Your turn: tap the dice."
    : l.text === "three sixes"
      ? `${NAME[l.color]} rolled three 6s: turn lost.`
      : l.text === "no move"
        ? `${l.color === ME ? "You" : NAME[l.color]} rolled ${l.roll}: no move.`
        : l.captured
          ? `${l.color === ME ? "You" : NAME[l.color]} sent ${l.captured > 1 ? "tokens" : "a token"} home! 💥`
          : l.finished
            ? `${l.color === ME ? "You" : NAME[l.color]} got a token home! 🏠`
            : l.moved != null
              ? `${l.color === ME ? "You" : NAME[l.color]} moved ${l.roll}.`
              : `${l.color === ME ? "You" : NAME[l.color]} rolled ${l.roll}.`;

  return (
    <div className="gm-ludo">
      <Board g={g} choices={mine ? choices : []} onPick={pick} />
      {g.winner ? (
        <div className="gm-result">
          <b>{g.winner === ME ? "You win! 🏆" : `${NAME[g.winner]} wins this time`}</b>
          <button className="btn btn-primary" onClick={() => (setG(null), setShown(null))}>Play again</button>
        </div>
      ) : (
        <div className="ld-controls">
          <button className="ld-roll" onClick={doRoll} disabled={!mine || g.roll != null || rolling} style={{ "--hue": HUE[who] }} aria-label={mine ? "Roll the dice" : `${NAME[who]} is playing`}>
            <Die value={rolling ? null : shown} rolling={rolling} />
          </button>
          <div className="ld-say">
            <b style={{ color: HUE[who] }}>{mine ? (g.roll != null ? (choices.length > 1 ? "Tap a token to move" : "Moving…") : "Your turn: tap the dice") : `${NAME[who]} is playing…`}</b>
            <span className="small muted">{said}</span>
          </div>
        </div>
      )}
    </div>
  );
}
