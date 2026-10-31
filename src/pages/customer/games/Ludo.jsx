// Ludo against the computer (1 or 3 opponents). Rules in ludoRules.js; you play blue.
// A wooden board tilted a little towards you, pawn-shaped tokens that hop square by square,
// a tumbling 3D dice (the same cube as the menu's dice game), and sounds.
import { useEffect, useRef, useState } from "react";
import { COLORS, SAFE, TRACK_CELLS, LANE_CELLS, START, FINISH, newGame, current, movable, rollDice, moveToken, computerChoice, cellOf, hopPath } from "./ludoRules.js";
import { sfx } from "./sound.js";

const CELL = 20;
const HUE = { red: ["#ff6b6b", "#c92a2a"], green: ["#51cf66", "#2b8a3e"], yellow: ["#ffd43b", "#e67700"], blue: ["#5c7cfa", "#364fc7"] };
const NAME = { red: "Red", green: "Green", yellow: "Yellow", blue: "Blue" };
const BASE = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] }; // top-left cell of each corner
const ME = "blue";
const HOP_MS = 170;
// Turning the cube so face n is on top, and the pips on each face (same as the dice game).
const SHOW = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const roll6 = () => {
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b);
  while (b[0] >= 252); // no bias
  return (b[0] % 6) + 1;
};
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Where a token is drawn (centre, in board units).
function spot(color, progress, i) {
  if (progress === -1) {
    const [r, c] = BASE[color];
    return [(c + (i % 2 ? 4 : 2)) * CELL, (r + (i < 2 ? 2 : 4)) * CELL];
  }
  if (progress === FINISH) {
    const off = { red: [-1, 0], green: [0, -1], yellow: [1, 0], blue: [0, 1] }[color];
    return [7.5 * CELL + off[0] * 16 + (i - 1.5) * 4.5 * Math.abs(off[1]), 7.5 * CELL + off[1] * 16 + (i - 1.5) * 4.5 * Math.abs(off[0])];
  }
  const [r, c] = cellOf(color, progress);
  return [(c + 0.5) * CELL, (r + 0.5) * CELL];
}

// A pawn: round base, body and head, shaded like plastic. Drawn standing on (0, 0).
function Pawn({ color, s = 1 }) {
  return (
    <g transform={`scale(${s})`}>
      <ellipse cy="1.5" rx="7.5" ry="3" fill="rgba(0,0,0,.35)" />
      <ellipse cy="0" rx="7" ry="3" fill={`url(#ld-g-${color})`} stroke={HUE[color][1]} strokeWidth=".6" />
      <path d="M-5 -0.5 Q-4.6 -6 -2.2 -9 L2.2 -9 Q4.6 -6 5 -0.5 Z" fill={`url(#ld-g-${color})`} stroke={HUE[color][1]} strokeWidth=".6" />
      <circle cy="-11.5" r="4" fill={`url(#ld-g-${color})`} stroke={HUE[color][1]} strokeWidth=".6" />
      <ellipse cx="-1.4" cy="-12.8" rx="1.3" ry="0.9" fill="rgba(255,255,255,.75)" />
      <path d="M-3.2 -2 Q-3 -5.5 -1.6 -7.5" stroke="rgba(255,255,255,.55)" strokeWidth="1" fill="none" strokeLinecap="round" />
    </g>
  );
}

function Board({ tokens, players, turn, choices, onPick, hopping }) {
  const cells = [];
  TRACK_CELLS.forEach(([r, c], idx) => {
    const startOf = COLORS.find((k) => START[k] === idx);
    cells.push(
      <g key={`t${idx}`}>
        <rect x={c * CELL} y={r * CELL} width={CELL} height={CELL} className="ld-cell" fill={startOf ? `url(#ld-g-${startOf})` : undefined} />
        {SAFE.has(idx) && !startOf && <text x={(c + 0.5) * CELL} y={(r + 0.5) * CELL + 5} className="ld-star">★</text>}
        {startOf && <text x={(c + 0.5) * CELL} y={(r + 0.5) * CELL + 4.5} className="ld-star on">★</text>}
      </g>
    );
  });
  for (const k of COLORS)
    LANE_CELLS[k].forEach(([r, c], i) => cells.push(<rect key={`l${k}${i}`} x={c * CELL} y={r * CELL} width={CELL} height={CELL} className="ld-cell" fill={`url(#ld-g-${k})`} />));

  // Tokens sharing a square sit side by side; drawn top to bottom so nearer ones overlap.
  const list = [];
  const crowd = new Map();
  for (const color of players)
    tokens[color].forEach((p, i) => {
      const [x, y] = spot(color, p, i);
      const key = p >= 0 && p < FINISH ? `${x},${y}` : `${color}${i}`;
      const n = crowd.get(key) || 0;
      crowd.set(key, n + 1);
      list.push({ color, i, x, y, key, n, p });
    });
  list.sort((a, b) => a.y - b.y);
  return (
    <svg viewBox="-14 -14 328 328" className="ld-board" role="img" aria-label="Ludo board">
      <defs>
        {COLORS.map((k) => (
          <radialGradient key={k} id={`ld-g-${k}`} cx="35%" cy="30%" r="80%">
            <stop offset="0" stopColor={HUE[k][0]} />
            <stop offset="1" stopColor={HUE[k][1]} />
          </radialGradient>
        ))}
        <linearGradient id="ld-wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a8703f" />
          <stop offset=".5" stopColor="#7c4a22" />
          <stop offset="1" stopColor="#5e3517" />
        </linearGradient>
        <pattern id="ld-grain" width="40" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
          <path d="M0 4 Q10 1 20 4 T40 4" stroke="rgba(0,0,0,.18)" strokeWidth="1" fill="none" />
        </pattern>
        <linearGradient id="ld-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,.45)" />
          <stop offset=".5" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <rect x="-14" y="-14" width="328" height="328" rx="14" fill="url(#ld-wood)" />
      <rect x="-14" y="-14" width="328" height="328" rx="14" fill="url(#ld-grain)" />
      <rect x="-3" y="-3" width="306" height="306" rx="6" fill="rgba(0,0,0,.35)" />
      <rect width="300" height="300" className="ld-bg" rx="4" />
      {COLORS.map((k) => {
        const [r, c] = BASE[k];
        return (
          <g key={k}>
            <rect x={c * CELL} y={r * CELL} width={6 * CELL} height={6 * CELL} fill={`url(#ld-g-${k})`} rx="5" />
            <rect x={c * CELL} y={r * CELL} width={6 * CELL} height={3 * CELL} fill="url(#ld-gloss)" rx="5" />
            <rect x={(c + 1) * CELL} y={(r + 1) * CELL} width={4 * CELL} height={4 * CELL} className="ld-yard" rx="10" />
            {[0, 1, 2, 3].map((i) => {
              const [x, y] = spot(k, -1, i);
              return <circle key={i} cx={x} cy={y} r="8" fill={`url(#ld-g-${k})`} opacity=".3" />;
            })}
          </g>
        );
      })}
      {cells}
      {/* the centre: four triangles, each colour's lane points into its own */}
      <polygon points="120,120 150,150 120,180" fill="url(#ld-g-red)" />
      <polygon points="120,120 180,120 150,150" fill="url(#ld-g-green)" />
      <polygon points="180,120 180,180 150,150" fill="url(#ld-g-yellow)" />
      <polygon points="120,180 150,150 180,180" fill="url(#ld-g-blue)" />
      <circle cx="150" cy="150" r="9" fill="rgba(255,255,255,.35)" />
      {list.map((t) => {
        const total = crowd.get(t.key);
        const shift = total > 1 ? (t.n - (total - 1) / 2) * 6 : 0;
        const can = t.color === players[turn] && choices.includes(t.i);
        const s = t.p === FINISH ? 0.55 : total > 1 ? 0.75 : 0.95;
        const hop = hopping && hopping.color === t.color && hopping.i === t.i;
        return (
          <g
            key={`${t.color}${t.i}`}
            className={"ld-token" + (can ? " can" : "") + (hop ? " moving" : "")}
            style={{ transform: `translate(${t.x + shift}px, ${t.y + 4}px)` }}
            onClick={can ? () => onPick(t.i) : undefined}
            role={can ? "button" : undefined}
            aria-label={can ? `Move token ${t.i + 1}` : undefined}
          >
            {can && <circle r="13" cy="-4" className="ld-hit" />}
            {can && <ellipse rx="9" ry="4" className="ld-ring" />}
            <g key={hop ? hopping.step : "still"} className={hop ? "ld-hop" : undefined}>
              <Pawn color={t.color} s={s} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

function Dice({ value, turns, rolling }) {
  const [x, y] = SHOW[value || 1];
  return (
    <div className={"die-wrap ld-die3d" + (rolling ? " tumbling" : "")}>
      <div className="die" style={{ transform: `rotateX(${x - 20 + turns * 720}deg) rotateY(${y + 25 + turns * 360}deg)` }}>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className={`die-face f${n}`}>
            {Array.from({ length: 9 }, (_, i) => <i key={i} className={PIPS[n].includes(i + 1) ? "pip" : ""} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Ludo() {
  const [g, setG] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [face, setFace] = useState(6); // what the dice shows
  const [turns, setTurns] = useState(0); // extra spins, so each throw tumbles
  const [hopping, setHopping] = useState(null); // { color, i, path, step, before, after }
  const ended = useRef(false);

  const who = g && current(g);
  const mine = who === ME;
  const busy = rolling || !!hopping;
  const choices = g && g.roll != null && !busy ? movable(g) : [];

  const doRoll = () => {
    if (!g || g.roll != null || g.winner || busy) return;
    const v = roll6();
    setFace(v);
    setTurns((t) => t + 1);
    setRolling(true);
    sfx.roll();
    setTimeout(() => {
      setRolling(false);
      setG((x) => rollDice(x, v));
    }, reduceMotion() ? 150 : 750);
  };
  // Moving: the rules settle it at once; the token then hops there square by square.
  const pick = (i) => {
    const color = current(g);
    const from = g.tokens[color][i];
    const after = moveToken(g, i);
    const to = after.tokens[color][i];
    if (reduceMotion()) return finish(after);
    setHopping({ color, i, path: hopPath(from, to), step: 0, before: g, after });
  };
  const finish = (after) => {
    const l = after.last;
    if (after.winner) {
      ended.current = true;
      (after.winner === ME ? sfx.win : sfx.lose)();
    } else if (l?.captured) {
      sfx.capture();
      navigator.vibrate?.(40);
    } else if (l?.finished) sfx.home();
    setHopping(null);
    setG(after);
  };
  useEffect(() => {
    if (!hopping) return;
    const t = setTimeout(() => {
      sfx.tick();
      if (hopping.step + 1 >= hopping.path.length) finish(hopping.after);
      else setHopping((h) => ({ ...h, step: h.step + 1 }));
    }, HOP_MS);
    return () => clearTimeout(t);
  }, [hopping]); // eslint-disable-line react-hooks/exhaustive-deps

  // The computer plays its turns; for you, a single possible move is made for you.
  useEffect(() => {
    if (!g || g.winner || busy) return;
    if (!mine && g.roll == null) {
      const t = setTimeout(doRoll, 600);
      return () => clearTimeout(t);
    }
    if (g.roll != null && (!mine || choices.length === 1)) {
      const t = setTimeout(() => pick(mine ? choices[0] : computerChoice(g)), mine ? 300 : 550);
      return () => clearTimeout(t);
    }
  }, [g, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g)
    return (
      <div className="gm-setup">
        <b>Ludo 🎲</b>
        <span className="small muted">You're blue. Roll a 6 to bring a token out. Land on someone to send them home. Stars and start squares are safe.</span>
        <button className="btn btn-primary btn-lg" onClick={() => setG(newGame([ME, "green"]))}>Play vs 1 computer</button>
        <button className="btn btn-lg" onClick={() => setG(newGame([ME, "red", "green", "yellow"]))}>Play vs 3 computers</button>
      </div>
    );

  // While a token hops, show the board as it was, with that token on its way.
  let shown = g.tokens;
  if (hopping) {
    shown = Object.fromEntries(Object.entries(hopping.before.tokens).map(([c, t]) => [c, t.slice()]));
    shown[hopping.color][hopping.i] = hopping.path[hopping.step];
  }
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
      <div className="ld-stage">
        <div className="ld-tilt">
          <Board tokens={shown} players={g.players} turn={g.turn} choices={mine ? choices : []} onPick={pick} hopping={hopping} />
        </div>
      </div>
      {g.winner ? (
        <div className="gm-result">
          <b>{g.winner === ME ? "You win! 🏆" : `${NAME[g.winner]} wins this time`}</b>
          <button className="btn btn-primary" onClick={() => ((ended.current = false), setG(null))}>Play again</button>
        </div>
      ) : (
        <div className="ld-controls">
          <button className="ld-roll" onClick={doRoll} disabled={!mine || g.roll != null || busy} style={{ "--hue": HUE[who][1] }} aria-label={mine ? "Roll the dice" : `${NAME[who]} is playing`}>
            <Dice value={face} turns={turns} rolling={rolling} />
          </button>
          <div className="ld-say">
            <b style={{ color: HUE[who][1] }}>{mine ? (g.roll != null && !busy ? (choices.length > 1 ? "Tap a token to move" : "Moving…") : busy ? "…" : "Your turn: tap the dice") : `${NAME[who]} is playing…`}</b>
            <span className="small muted">{said}</span>
          </div>
        </div>
      )}
    </div>
  );
}
