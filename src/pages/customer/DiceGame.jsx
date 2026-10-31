// Dice game on the QR menu: throw two dice once a day; a 7 wins a code for this mobile. The server
// rolls (secure random) before anything moves; the dice here only land on what it rolled.
import { useEffect, useMemo, useState } from "react";
import { post } from "../../lib/api.js";
import { deviceKey } from "./common.js";
import { Celebrate } from "../../components/Celebrate.jsx";
import { diceOfferText, DICE_TARGET } from "../../../shared/dice.js";

// Turning the cube so face n is on top (face 1 is in front to begin with).
const SHOW = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
// Pip spots on a 3×3 grid (1 = top-left … 9 = bottom-right).
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const savedKey = (token) => `coDice:${token}`;
export function playedToday(token) {
  try {
    const s = JSON.parse(localStorage.getItem(savedKey(token)) || "null");
    return s?.day === todayIST() ? s : null;
  } catch {
    return null;
  }
}

function Die({ value, spin, rolling }) {
  const [x, y] = SHOW[value || 1];
  // Whole extra turns so it tumbles on the way, then lands flat on its value.
  const style = value ? { transform: `rotateX(${x + spin.x * 360}deg) rotateY(${y + spin.y * 360}deg) rotateZ(${spin.z}deg)` } : undefined;
  return (
    <div className={"die-wrap" + (rolling ? " thrown" : "")}>
      <div className="die" style={style}>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className={`die-face f${n}`}>
            {Array.from({ length: 9 }, (_, i) => <i key={i} className={PIPS[n].includes(i + 1) ? "pip" : ""} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiceGame({ token, rule, cur, onClose, onWin }) {
  const [phone, setPhone] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("coContact") || "{}").phone || "";
    } catch {
      return "";
    }
  });
  // { dice, win, code, already }; restored = thrown earlier today on this phone (no party again).
  const [result, setResult] = useState(() => (playedToday(token) ? { ...playedToday(token), restored: true } : null));
  const [shown, setShown] = useState(() => !!playedToday(token)); // the dice have landed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [party, setParty] = useState(false);
  const spins = useMemo(() => [0, 1].map(() => ({ x: 2 + Math.floor(Math.random() * 2), y: 2 + Math.floor(Math.random() * 2), z: Math.floor(Math.random() * 40) - 20 })), [result?.dice?.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Landed: celebrate a win and put the code in the cart.
  useEffect(() => {
    if (!shown || !result || result.restored) return;
    if (result.win && result.code) {
      onWin(result.code);
      setParty(true);
    }
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const roll = async () => {
    setError("");
    const mobile = phone.replace(/\D/g, "").slice(-10);
    if (mobile.length !== 10) return setError("Enter your 10-digit mobile number.");
    setBusy(true);
    try {
      const r = await post(`/public/shop/${token}/dice`, { phone: mobile, device: deviceKey() });
      const saved = { day: todayIST(), dice: r.dice, win: r.win, code: r.code, already: r.already, mine: r.mine };
      try {
        localStorage.setItem(savedKey(token), JSON.stringify(saved));
      } catch {
        /* private mode */
      }
      setShown(false);
      setResult(saved);
      // Let the dice fly, then show how they landed.
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      setTimeout(() => setShown(true), r.already || reduced ? 50 : 1700);
    } catch (err) {
      setError(err.offline ? "The dice game needs internet." : err.message);
    } finally {
      setBusy(false);
    }
  };

  const dice = result?.dice || [];
  const sum = dice[0] + dice[1];
  const rolling = !!result && !shown;
  return (
    <div className="co-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="co-sheet dice-sheet" role="dialog" aria-label="Dice game">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b style={{ fontSize: 18 }}>🎲 Throw a {DICE_TARGET}, win!</b>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Two dice, one throw a day. If they add up to <b>{DICE_TARGET}</b>, you win <b>{diceOfferText(rule, cur)}</b>, today only.
        </p>

        <div className={"dice-table" + (rolling ? " rolling" : "")} aria-live="polite">
          <Die value={dice[0]} spin={spins[0]} rolling={rolling} />
          <Die value={dice[1]} spin={spins[1]} rolling={rolling} />
        </div>

        {result && shown ? (
          <div className={"dice-result" + (result.win ? " win" : "")}>
            <b>{dice[0]} + {dice[1]} = {sum}</b>
            {result.win && result.code ? (
              <>
                <span>🎉 You won! Your code <b>{result.code}</b> is in your cart: {diceOfferText(rule, cur)}. Use it today.</span>
                <button className="btn btn-primary btn-lg" onClick={onClose}>Order now</button>
              </>
            ) : result.win ? (
              <span>This phone already won today with another mobile number.</span>
            ) : (
              <span>{result.already && !result.mine ? "This phone already threw the dice today." : sum === 6 || sum === 8 ? "So close! " : "Not this time. "}Come back tomorrow for another throw.</span>
            )}
          </div>
        ) : result ? (
          <div className="dice-result"><span>Rolling…</span></div>
        ) : (
          <>
            <label className="field">
              Your mobile number
              <input type="tel" inputMode="numeric" maxLength={14} placeholder="10-digit mobile" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={roll}>{busy ? "Shaking…" : "🎲 Throw the dice"}</button>
            <p className="hint" style={{ margin: 0 }}>Every throw is random and the same for everyone: the dice are rolled by the restaurant's server, not this phone.</p>
          </>
        )}
      </div>
      {party && <Celebrate title={`You threw a ${DICE_TARGET}! 🎲`} note={`Code ${result.code} · ${diceOfferText(rule, cur)}`} onDone={() => setParty(false)} />}
    </div>
  );
}
