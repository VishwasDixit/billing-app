// A little kitchen scene on My orders that follows the order: the chef reads the ticket while it
// waits, flips a pan while it cooks, and the dish comes out under a lifting cover when it's ready.
// Plain SVG + CSS (styles.css, .ck-*): colours follow light/dark, and it stands still for
// "reduce motion".

const LINES = {
  wait: ["Chef is reading your order…", "Sharpening knives, warming pans…", "Your order is next in line!"],
  cook: ["Chef Tadka is on it! 🔥", "Flip, sizzle, flip…", "A pinch of love, a dash of masala…"],
  ready: ["Ta-da! Fresh and hot 🛎️", "Your food is on its way!"],
  served: ["Enjoy your meal! 😋", "Bon appétit!"],
};

export const sceneOf = (status) =>
  status === "new" ? "wait" : status === "accepted" || status === "preparing" ? "cook" : status === "ready" ? "ready" : status === "served" ? "served" : null;

// The chef: white coat, puffy hat, big moustache. `look` makes the eyes read left-right.
function Chef({ x = 0, look = false, arm = null }) {
  return (
    <g className="ck-chef" transform={`translate(${x} 0)`}>
      <ellipse className="ck-shadow" cx="60" cy="132" rx="34" ry="5" />
      {/* coat */}
      <path className="ck-coat" d="M30 132 C30 100 40 88 60 88 C80 88 90 100 90 132 Z" />
      <circle className="ck-button" cx="60" cy="104" r="2" />
      <circle className="ck-button" cx="60" cy="116" r="2" />
      <path className="ck-scarf" d="M48 88 L60 98 L72 88 Z" />
      {/* head */}
      <circle className="ck-skin" cx="60" cy="68" r="20" />
      <circle className="ck-skin" cx="40" cy="70" r="4" />
      <circle className="ck-skin" cx="80" cy="70" r="4" />
      <g className={look ? "ck-eyes ck-look" : "ck-eyes"}>
        <ellipse className="ck-eye" cx="52" cy="65" rx="2.6" ry="3.2" />
        <ellipse className="ck-eye" cx="68" cy="65" rx="2.6" ry="3.2" />
      </g>
      <ellipse className="ck-cheek" cx="46" cy="74" rx="4" ry="2.4" />
      <ellipse className="ck-cheek" cx="74" cy="74" rx="4" ry="2.4" />
      <path className="ck-tache" d="M60 75 C54 71 46 72 43 78 C49 77 54 79 60 77 C66 79 71 77 77 78 C74 72 66 71 60 75 Z" />
      {/* hat */}
      <g className="ck-hat">
        <rect className="ck-hat-band" x="44" y="44" width="32" height="9" rx="2" />
        <circle className="ck-hat-puff" cx="48" cy="38" r="9" />
        <circle className="ck-hat-puff" cx="60" cy="32" r="11" />
        <circle className="ck-hat-puff" cx="72" cy="38" r="9" />
      </g>
      {arm}
    </g>
  );
}

function Steam({ x, y, d = 0 }) {
  return <path className="ck-steam" style={{ animationDelay: `${d}s` }} d={`M${x} ${y} c-4 -6 4 -10 0 -16 c-4 -6 4 -10 0 -16`} />;
}

function Waiting() {
  return (
    <>
      {/* wall clock, its hand going round */}
      <g transform="translate(200 30)">
        <circle className="ck-clock" r="14" />
        <line className="ck-hand ck-tick" x1="0" y1="0" x2="0" y2="-10" />
        <line className="ck-hand" x1="0" y1="0" x2="6" y2="0" />
      </g>
      <rect className="ck-counter" x="0" y="118" width="240" height="22" />
      <Chef
        x={40}
        look
        arm={
          // the order ticket, held up and swaying a little
          <g className="ck-ticket">
            <rect className="ck-paper" x="74" y="84" width="26" height="32" rx="2" />
            <line className="ck-ink" x1="78" y1="92" x2="96" y2="92" />
            <line className="ck-ink" x1="78" y1="99" x2="94" y2="99" />
            <line className="ck-ink" x1="78" y1="106" x2="92" y2="106" />
            <circle className="ck-skin" cx="76" cy="104" r="5" />
          </g>
        }
      />
      <g className="ck-bubble">
        <path className="ck-bubble-bg" d="M28 22 h40 a8 8 0 0 1 8 8 v10 a8 8 0 0 1 -8 8 h-26 l-8 8 v-8 h-6 a8 8 0 0 1 -8 -8 v-10 a8 8 0 0 1 8 -8 z" />
        <circle className="ck-dot" cx="38" cy="35" r="3" />
        <circle className="ck-dot d2" cx="48" cy="35" r="3" />
        <circle className="ck-dot d3" cx="58" cy="35" r="3" />
      </g>
    </>
  );
}

function Cooking() {
  return (
    <>
      <rect className="ck-counter" x="0" y="118" width="240" height="22" />
      {/* stove and flames */}
      <rect className="ck-stove" x="128" y="108" width="80" height="10" rx="3" />
      <g className="ck-flames">
        {[146, 160, 174, 188].map((x, i) => (
          <path key={x} className="ck-flame" style={{ animationDelay: `${i * 0.13}s` }} d={`M${x} 108 c-5 -6 -3 -12 0 -16 c3 4 5 10 0 16 z`} />
        ))}
      </g>
      <Chef
        x={20}
        arm={
          // the pan flips; the food jumps out of it and lands back
          <g className="ck-pan">
            <circle className="ck-skin" cx="94" cy="100" r="5" />
            <rect className="ck-handle" x="96" y="97" width="40" height="5" rx="2.5" />
            <path className="ck-panbody" d="M134 94 h50 a4 4 0 0 1 0 4 c-3 10 -11 12 -25 12 c-14 0 -22 -2 -25 -12 a4 4 0 0 1 0 -4 z" />
          </g>
        }
      />
      <g className="ck-food">
        <circle className="ck-veg a" cx="152" cy="90" r="4.5" />
        <rect className="ck-veg b" x="160" y="84" width="8" height="6" rx="2" />
        <circle className="ck-veg c" cx="172" cy="89" r="3.5" />
      </g>
      <Steam x={150} y={80} />
      <Steam x={166} y={76} d={0.7} />
      <Steam x={182} y={80} d={1.4} />
      <path className="ck-sweat" d="M64 56 c-3 4 -3 7 0 8 c3 -1 3 -4 0 -8 z" />
    </>
  );
}

function Plated({ served }) {
  return (
    <>
      <rect className="ck-counter" x="0" y="118" width="240" height="22" />
      <ellipse className="ck-shadow" cx="120" cy="120" rx="58" ry="6" />
      <ellipse className="ck-plate" cx="120" cy="112" rx="56" ry="10" />
      <ellipse className="ck-plate-in" cx="120" cy="110" rx="40" ry="6" />
      {/* the dish: a little rice hill with garnish */}
      <path className="ck-rice" d="M88 110 c4 -24 60 -24 64 0 z" />
      <circle className="ck-veg a" cx="108" cy="98" r="3.5" />
      <circle className="ck-veg c" cx="128" cy="96" r="3" />
      <path className="ck-leaf" d="M118 90 c4 -8 12 -8 14 -4 c-4 4 -10 6 -14 4 z" />
      {!served && (
        <g className="ck-cloche">
          <path className="ck-cloche-body" d="M70 110 a50 44 0 0 1 100 0 z" />
          <circle className="ck-cloche-knob" cx="120" cy="64" r="6" />
        </g>
      )}
      <Steam x={106} y={86} d={0.2} />
      <Steam x={122} y={82} d={0.9} />
      <Steam x={138} y={86} d={1.6} />
      {[
        [56, 52],
        [186, 46],
        [66, 92],
        [178, 90],
        [120, 22],
      ].map(([x, y], i) => (
        <path key={i} className={served ? "ck-heart" : "ck-spark"} style={{ animationDelay: `${i * 0.35}s` }} transform={`translate(${x} ${y})`} d={served ? "M0 3 c-6 -6 -10 0 0 7 c10 -7 6 -13 0 -7 z" : "M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2 Z"} />
      ))}
    </>
  );
}

export function CookingScene({ status, seed = 0 }) {
  const scene = sceneOf(status);
  if (!scene) return null;
  const lines = LINES[scene];
  const line = lines[Math.abs(seed) % lines.length];
  return (
    <figure className={`ck-scene ck-${scene}`}>
      <svg viewBox="0 0 240 140" role="img" aria-label={line}>
        {scene === "wait" && <Waiting />}
        {scene === "cook" && <Cooking />}
        {(scene === "ready" || scene === "served") && <Plated served={scene === "served"} />}
      </svg>
      <figcaption>{line}</figcaption>
    </figure>
  );
}
