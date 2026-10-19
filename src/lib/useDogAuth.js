import { useCallback, useRef, useState } from "react";
import { useApp } from "./store.jsx";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drives the door-dog: waiting while a request runs, sad on failure,
// and on success lets the dog walk in before opening the app.
export function useDogAuth() {
  const { completeLogin } = useApp();
  const [mood, setMood] = useState("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const fail = useCallback((message) => {
    clearTimeout(timer.current);
    setError(message);
    setMood("fail");
    timer.current = setTimeout(() => setMood("idle"), 2600);
  }, []);

  // `fn` performs the request and resolves with a session ({user, shop}).
  const signIn = useCallback(
    async (fn) => {
      clearTimeout(timer.current);
      setBusy(true);
      setError("");
      setMood("waiting");
      try {
        const session = await fn();
        setMood("success");
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        await sleep(reduced ? 300 : 1900);
        await completeLogin(session);
        return true;
      } catch (err) {
        fail(err.message || String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [completeLogin, fail]
  );

  // For steps that don't sign in (e.g. sending a code): waiting, then idle or sad.
  const step = useCallback(
    async (fn) => {
      clearTimeout(timer.current);
      setBusy(true);
      setError("");
      setMood("waiting");
      try {
        const r = await fn();
        setMood("idle");
        return r ?? true;
      } catch (err) {
        fail(err.message || String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fail]
  );

  return { mood, error, setError, busy, signIn, step, fail };
}
