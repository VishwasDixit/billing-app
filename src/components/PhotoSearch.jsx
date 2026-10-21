import { useEffect, useState } from "react";
import { get } from "../lib/api.js";
import { Modal } from "./ui.jsx";

// Search the free Pexels library for a dish photo. Only the chosen photo's link is saved.
export function PhotoSearch({ name, category, onPick, onClose }) {
  const [q, setQ] = useState(name || "");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async (text = q) => {
    if (text.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      setData(await get(`/images/search?${new URLSearchParams({ q: text.trim(), category: category || "" })}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (name) search(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title="Find a photo" onClose={onClose} wide>
      {/* Not a <form>: this opens inside the item editor's form. */}
      <div className="photo-search-bar">
        <input
          className="input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())}
          placeholder="e.g. paneer tikka"
          autoFocus
        />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => search()}>{busy ? "Searching…" : "Search"}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {data && data.results.length === 0 && <div className="empty">No photos found. Try a simpler name, e.g. “paneer curry”.</div>}
      <div className="photo-grid">
        {data?.results.map((p) => (
          <button key={p.id} type="button" className="photo-cell" onClick={() => onPick(p)} title={p.alt || "Use this photo"}>
            <img src={p.thumb} alt={p.alt} loading="lazy" />
            <span className="photo-by">{p.author}</span>
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>
        Tap a photo to use it. Only its link is saved, so it takes no storage.{" "}
        <a href="https://www.pexels.com" target="_blank" rel="noopener noreferrer">Photos provided by Pexels</a>
      </p>
    </Modal>
  );
}
