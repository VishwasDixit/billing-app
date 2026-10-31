// Chess pieces drawn as SVG (our own simple shapes), shaded like turned wood / plastic.
// <Piece p="K" /> for white, lower case for black. Gradients are defined once by <PieceDefs />.

const OUT = { w: "#2b2b2b", b: "#050505" };
const LINE = { w: "#3a3a3a", b: "#b9b9b9" };

const BASE = (y = 36) => <rect x="10.5" y={y} width="24" height="4.5" rx="2" />;

const SHAPES = {
  p: (
    <>
      <path d="M12 39 Q12 36.5 15 36 L30 36 Q33 36.5 33 39 L33 40.5 L12 40.5 Z" />
      <path d="M16.5 36 Q16.8 29.5 20.2 25.3 L18.6 23.4 Q22.5 20.6 26.4 23.4 L24.8 25.3 Q28.2 29.5 28.5 36 Z" />
      <circle cx="22.5" cy="15.8" r="5.4" />
    </>
  ),
  r: (
    <>
      {BASE()}
      <rect x="13" y="31.5" width="19" height="4.5" rx="1" />
      <path d="M15 31.5 L16.2 17 H28.8 L30 31.5 Z" />
      <rect x="13.5" y="13" width="18" height="4" rx="1" />
      <path d="M12.5 13 V7.5 H16.5 V10 H20.5 V7.5 H24.5 V10 H28.5 V7.5 H32.5 V13 Z" />
    </>
  ),
  n: (
    <>
      {BASE()}
      <path d="M13.5 36 C13.8 29.5 16.5 26 18.6 22.4 C16.8 23 15.2 23.8 13.6 24.3 L11.6 24.8 C9.6 25.2 8.6 23.3 9.6 21.7 L13.2 15.6 C15.2 12 18.8 9.2 23 8.6 L24.8 5 L26.8 8.8 C31 10.4 33.6 14.6 32.6 19.6 C31.6 24.8 31.8 30 32 36 Z" />
    </>
  ),
  b: (
    <>
      {BASE()}
      <rect x="15" y="30.5" width="15" height="3.5" rx="1.5" />
      <path d="M22.5 10 C15.5 15.5 14.6 24.5 17 30.5 H28 C30.4 24.5 29.5 15.5 22.5 10 Z" />
      <circle cx="22.5" cy="7.6" r="2.6" />
    </>
  ),
  q: (
    <>
      {BASE()}
      <path d="M11.5 33.5 L9.5 14.5 L15.5 25 L17.2 11.5 L22.5 24 L27.8 11.5 L29.5 25 L35.5 14.5 L33.5 33.5 Z" />
      <rect x="11.5" y="31" width="22" height="3.5" rx="1.5" />
      {[[9.5, 12.5], [17.2, 9.4], [22.5, 8.4], [27.8, 9.4], [35.5, 12.5]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.2" />)}
    </>
  ),
  k: (
    <>
      {BASE()}
      <path d="M12.5 33.5 C9.2 26 11.8 18.4 17 18.4 C19.2 18.4 21.2 20.2 22.5 22.4 C23.8 20.2 25.8 18.4 28 18.4 C33.2 18.4 35.8 26 32.5 33.5 Z" />
      <rect x="12" y="31" width="21" height="3.5" rx="1.5" />
      <path d="M19 19.5 Q22.5 14 26 19.5 Z" />
      <rect x="21" y="5" width="3" height="10.5" rx=".8" />
      <rect x="18" y="8" width="9" height="3" rx=".8" />
    </>
  ),
};

// Little details on top (in a contrasting line colour).
const DETAIL = {
  p: null,
  r: <path d="M15 31.5 H30 M16 17 H29" />,
  n: (
    <>
      <circle cx="21.6" cy="13.6" r="1.2" stroke="none" fill="currentColor" />
      <path d="M26.8 9.6 C29.8 12.4 30.6 16.8 29.6 21.4 M12 22.8 L13.4 21.8" />
    </>
  ),
  b: <path d="M25.2 15.4 L20.6 21.8 M17 30.5 H28" />,
  q: <path d="M11.5 31 H33.5" />,
  k: <path d="M12 31 H33" />,
};

export function PieceDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="pc-w" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".55" stopColor="#efe9df" />
          <stop offset="1" stopColor="#bdb3a3" />
        </linearGradient>
        <linearGradient id="pc-b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6b6b6b" />
          <stop offset=".45" stopColor="#2a2a2a" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Piece({ p }) {
  const side = p === p.toUpperCase() ? "w" : "b";
  const t = p.toLowerCase();
  return (
    <svg viewBox="0 0 45 45" className={`pc pc-${side}`} aria-hidden="true">
      <g fill={`url(#pc-${side})`} stroke={OUT[side]} strokeWidth="1.3" strokeLinejoin="round">
        {SHAPES[t]}
      </g>
      {DETAIL[t] && (
        <g fill="none" stroke={LINE[side]} strokeWidth="1.1" strokeLinecap="round" color={LINE[side]}>
          {DETAIL[t]}
        </g>
      )}
      {/* a soft shine down the left side */}
      <path d="M17 34 Q15.5 26 18.5 19" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
