// After ordering: "post your order on your Instagram story and follow us, get a meal free". The
// staff check the story and give the code (Orders › 📸 Insta reward), so nothing is claimed here.
import { money } from "../../lib/format.js";

const seenKey = (token) => `coInsta:${token}`;
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// Once a day on this phone.
export function instaDue(token) {
  try {
    return localStorage.getItem(seenKey(token)) !== todayIST();
  } catch {
    return true;
  }
}
function markSeen(token) {
  try {
    localStorage.setItem(seenKey(token), todayIST());
  } catch {
    /* private mode */
  }
}

export function InstaPopup({ token, insta, cur, onClose }) {
  const close = () => {
    markSeen(token);
    onClose();
  };
  const handle = insta.handle;
  return (
    <div className="co-sheet-back ig-back" onClick={close}>
      <div className="ig-card" role="dialog" aria-modal="true" aria-labelledby="ig-title" onClick={(e) => e.stopPropagation()}>
        <button className="ig-x" onClick={close} aria-label="Close">✕</button>
        <div className="ig-badge" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="56" height="56">
            <defs>
              <radialGradient id="ig-grad" cx="30%" cy="107%" r="150%">
                <stop offset="0" stopColor="#fdf497" />
                <stop offset=".05" stopColor="#fdf497" />
                <stop offset=".45" stopColor="#fd5949" />
                <stop offset=".6" stopColor="#d6249f" />
                <stop offset=".9" stopColor="#285AEB" />
              </radialGradient>
            </defs>
            <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#ig-grad)" />
            <rect x="11" y="11" width="26" height="26" rx="8" fill="none" stroke="#fff" strokeWidth="3" />
            <circle cx="24" cy="24" r="6.5" fill="none" stroke="#fff" strokeWidth="3" />
            <circle cx="32.5" cy="15.5" r="2" fill="#fff" />
          </svg>
        </div>
        <h3 id="ig-title">Get 1 meal free! 🎉</h3>
        <p className="ig-text">
          📸 Post your order on your <b>Instagram story</b>, tag &amp; follow <b>@{handle}</b>, and get <b>1 meal free</b> (up to {money(insta.max, cur)}).
        </p>
        <ol className="ig-steps">
          <li>Take a photo of your food and post it on your story</li>
          <li>Tag <b>@{handle}</b> and follow us</li>
          <li>Show the story to the staff to get your free-meal code</li>
        </ol>
        <a className="btn btn-lg ig-follow" href={`https://instagram.com/${encodeURIComponent(handle)}`} target="_blank" rel="noopener noreferrer">
          Follow @{handle}
        </a>
        <button className="btn btn-ghost" onClick={close}>Maybe later</button>
        <small className="muted">One free meal per mobile number.</small>
      </div>
    </div>
  );
}
