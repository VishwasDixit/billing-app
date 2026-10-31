// "Congratulations! You saved ₹X": a short confetti burst when a code or a free dish is applied.
// Tap anywhere to close; it also closes by itself. No confetti for people who turn motion off.
import { useEffect, useMemo } from "react";

const COLORS = ["#e8492b", "#f5b700", "#25d366", "#14a594", "#7c5cff", "#ff6fa8"];

export function Celebrate({ title = "Congratulations!", amount, note, onDone, ms = 2600 }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        dur: 1.6 + Math.random() * 1.2,
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 6,
        round: Math.random() < 0.35,
      })),
    []
  );
  useEffect(() => {
    try {
      navigator.vibrate?.(40);
    } catch {
      /* not allowed */
    }
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="celebrate" role="status" aria-live="polite" onClick={onDone}>
      <div className="confetti" aria-hidden="true">
        {bits.map((b, i) => (
          <i key={i} style={{ left: `${b.left}%`, width: b.size, height: b.round ? b.size : b.size * 1.6, background: b.color, borderRadius: b.round ? "50%" : 2, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s` }} />
        ))}
      </div>
      <div className="celebrate-card">
        <div className="celebrate-emoji" aria-hidden="true">🎉</div>
        <b>{title}</b>
        {amount && <div className="celebrate-amount">You saved <span>{amount}</span></div>}
        {note && <div className="celebrate-note">{note}</div>}
      </div>
    </div>
  );
}
