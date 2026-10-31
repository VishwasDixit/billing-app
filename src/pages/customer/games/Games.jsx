// Games to pass the time while the food is cooked (My orders › Play a game). This file and each
// game load only when opened, so the menu stays quick; the app caches them for offline play.
// A bar on top keeps showing the order's progress.
import { Suspense, lazy, useEffect, useState } from "react";
import { isMuted, setMuted, sfx } from "./sound.js";

const GAMES = [
  { id: "race", icon: "🛵", name: "Tiffin Dash", Game: lazy(() => import("./Racer.jsx")) },
  { id: "ludo", icon: "🎲", name: "Ludo", Game: lazy(() => import("./Ludo.jsx")) },
  { id: "snake", icon: "🐍", name: "Snake", Game: lazy(() => import("./Snake.jsx")) },
  { id: "pong", icon: "🏓", name: "Ping Pong", Game: lazy(() => import("./PingPong.jsx")) },
  { id: "chess", icon: "♟️", name: "Chess", Game: lazy(() => import("./Chess.jsx")) },
];
const BLURB = {
  race: "Dodge cars, autos and cows on a winding road",
  ludo: "Race your 4 tokens home vs the computer",
  snake: "The old-phone classic: eat, grow, don't bite your tail",
  pong: "Table tennis: drag your bat, angle your shots",
  chess: "Play white against the computer",
};

export default function Games({ onClose, status }) {
  const [pick, setPick] = useState(() => {
    try {
      return localStorage.getItem("coGame") || "";
    } catch {
      return "";
    }
  });
  const game = GAMES.find((g) => g.id === pick);
  const [quiet, setQuiet] = useState(isMuted);
  const toggleSound = () => {
    setMuted(!quiet);
    setQuiet(!quiet);
    if (quiet) sfx.blip();
  };
  const choose = (id) => {
    sfx.blip();
    setPick(id);
    try {
      localStorage.setItem("coGame", id);
    } catch {
      /* private mode */
    }
  };
  // The phone's back gesture closes the games instead of leaving the page.
  useEffect(() => {
    if (!history.state?.coGames) history.pushState({ coGames: true }, "");
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => (history.state?.coGames ? history.back() : onClose());

  return (
    <div className="gm-page" role="dialog" aria-label="Games">
      <header className="gm-top">
        <button className="gm-x" onClick={close} aria-label="Back to my orders">←</button>
        <div className="gm-tabs" role="tablist">
          {GAMES.map((g) => (
            <button key={g.id} role="tab" aria-selected={pick === g.id} className={pick === g.id ? "on" : ""} onClick={() => choose(g.id)}>
              <span aria-hidden="true">{g.icon}</span> {g.name}
            </button>
          ))}
        </div>
        <button className="gm-x gm-sound" onClick={toggleSound} aria-label={quiet ? "Sound on" : "Sound off"} aria-pressed={!quiet}>{quiet ? "🔇" : "🔊"}</button>
      </header>
      {status && (
        <button className={`gm-status ${status.tone || ""}`} onClick={close} aria-live="polite">
          <span aria-hidden="true">{status.icon}</span>
          <span>
            <b>Order #{status.orderNo}</b> · {status.text}
          </span>
          <span className="gm-status-go">View</span>
        </button>
      )}
      <main className="gm-body">
        {game ? (
          <Suspense fallback={<div className="gm-loading"><span className="co-spinner" />Loading {game.name}…</div>}>
            <game.Game key={game.id} />
          </Suspense>
        ) : (
          <div className="gm-pick">
            <b>Pick a game while the kitchen cooks 👨‍🍳</b>
            {GAMES.map((g) => (
              <button key={g.id} className="gm-pick-card" onClick={() => choose(g.id)}>
                <span className="gm-pick-icon" aria-hidden="true">{g.icon}</span>
                <span>
                  <b>{g.name}</b>
                  <small>{BLURB[g.id]}</small>
                </span>
              </button>
            ))}
            <span className="small muted">With sound (tap 🔊 to mute). Works offline too. We'll show you here when your order moves along.</span>
          </div>
        )}
      </main>
    </div>
  );
}
