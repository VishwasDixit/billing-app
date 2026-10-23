import { useCallback, useState } from "react";

// Per-device preferences (not shared with other phones of the same shop).
function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function useShowPictures() {
  const [on, setOn] = useState(() => read("showPictures", true));
  const set = useCallback((v) => {
    setOn(v);
    try {
      localStorage.setItem("showPictures", JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, []);
  return [on, set];
}

// Any per-device setting, e.g. usePref("kotAuto", true).
export function usePref(key, fallback) {
  const [v, setV] = useState(() => read(key, fallback));
  const save = useCallback(
    (next) => {
      setV(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key]
  );
  return [v, save];
}
export const readPref = read;
