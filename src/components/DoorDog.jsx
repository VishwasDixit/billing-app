// A dog waiting outside a door. mood: "idle" | "waiting" | "success" | "fail".
// success: the door opens and the dog goes inside. fail: the dog is sad and stays outside.
const CAPTIONS = {
  idle: "Knock knock! Let me in? 🐾",
  waiting: "Checking…",
  success: "Welcome in! 🎉",
  fail: "Wrong… the door stays shut 😢",
};

export function DoorDog({ mood = "idle", caption }) {
  return (
    <div className={`door-dog dd-${mood}`} aria-live="polite">
      <svg viewBox="0 0 240 170" role="img" aria-label={caption || CAPTIONS[mood]}>
        <defs>
          <radialGradient id="dd-light" cx="50%" cy="40%" r="70%">
            <stop offset="0" stopColor="#fff3c4" />
            <stop offset="1" stopColor="#ffc857" />
          </radialGradient>
        </defs>

        {/* ground and house */}
        <rect x="0" y="140" width="240" height="30" rx="6" fill="#e9dcc7" />
        <rect x="112" y="12" width="122" height="130" rx="6" fill="#f4e7d4" />
        <path d="M104 18 L173 -2 L242 18 Z" fill="#c8664a" />
        {/* warm room behind the door */}
        <rect className="dd-inside" x="140" y="48" width="56" height="92" fill="url(#dd-light)" />
        <g className="dd-glow">
          <path d="M140 140 L196 140 L222 168 L114 168 Z" fill="#ffd36e" opacity=".45" />
        </g>
        {/* door (hinged on the left) */}
        <g className="dd-door">
          <rect x="140" y="48" width="56" height="92" rx="2" fill="#b4642b" />
          <rect x="146" y="55" width="44" height="34" rx="2" fill="#c47436" />
          <rect x="146" y="96" width="44" height="38" rx="2" fill="#c47436" />
          <circle cx="187" cy="97" r="3.2" fill="#f2c94c" />
        </g>
        <rect x="136" y="44" width="64" height="98" rx="3" fill="none" stroke="#8a4a1f" strokeWidth="6" />
        <circle cx="168" cy="30" r="5" fill="#ffd36e" className="dd-lamp" />
        <ellipse cx="168" cy="147" rx="34" ry="5" fill="#9c3d2a" />
        {/* heart when let in */}
        <path className="dd-heart" d="M168 28c-5-7-15-2-10 6l10 9 10-9c5-8-5-13-10-6z" fill="#e5533d" />

        {/* the dog */}
        <g transform="translate(26 66)">
          <g className="dd-dog">
            <ellipse cx="46" cy="76" rx="34" ry="5" fill="#000" opacity=".1" />
            <path className="dd-tail" d="M18 46 C6 40 2 28 9 19" fill="none" stroke="#c98a4b" strokeWidth="7" strokeLinecap="round" />
            <rect x="22" y="58" width="9" height="20" rx="4" fill="#b0763c" />
            <rect x="34" y="60" width="9" height="18" rx="4" fill="#c98a4b" />
            <rect x="52" y="60" width="9" height="18" rx="4" fill="#b0763c" />
            <rect x="63" y="58" width="9" height="20" rx="4" fill="#c98a4b" />
            <ellipse cx="45" cy="50" rx="30" ry="19" fill="#c98a4b" />
            <ellipse cx="50" cy="56" rx="16" ry="9" fill="#e2b27a" />
            {/* collar stays on the body when the head moves */}
            <rect x="56" y="33" width="12" height="16" rx="5" fill="#d9363e" transform="rotate(-18 62 41)" />
            <circle cx="65" cy="49" r="3" fill="#f2c94c" />
            <g className="dd-head">
              <circle cx="75" cy="27" r="18" fill="#d79b58" />
              <path className="dd-ear" d="M63 13c-12 5-10 22-5 28 5-3 9-14 9-24z" fill="#8a5a2b" />
              <ellipse cx="89" cy="34" rx="11" ry="8.5" fill="#f1d2a8" />
              <ellipse cx="97" cy="30" rx="4.2" ry="3.2" fill="#2b1b12" />
              <g className="dd-eyes">
                <circle cx="79" cy="22" r="3.2" fill="#2b1b12" />
                <circle cx="80" cy="21" r="1" fill="#fff" />
              </g>
              <path className="dd-brow" d="M73 15.5l9 3" stroke="#5b3a1d" strokeWidth="2" strokeLinecap="round" />
              <path className="dd-smile" d="M87 40q5 5 10 0" fill="none" stroke="#2b1b12" strokeWidth="1.8" strokeLinecap="round" />
              <path className="dd-frown" d="M87 43q5-4 10 0" fill="none" stroke="#2b1b12" strokeWidth="1.8" strokeLinecap="round" />
              <ellipse className="dd-tongue" cx="92" cy="44" rx="3.2" ry="4.2" fill="#ef6b7a" />
              <path className="dd-tear" d="M82 27c-2 4-3 6-3 7.5a3 3 0 0 0 6 0c0-1.5-1-3.5-3-7.5z" fill="#5aa9e6" />
            </g>
          </g>
        </g>
      </svg>
      <div className="dd-caption">{caption || CAPTIONS[mood]}</div>
    </div>
  );
}
