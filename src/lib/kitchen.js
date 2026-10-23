// Kitchen stock on this device: the last lists from the server (so the kitchen phone works
// offline) and a queue of cook entries (received / waste / expired / count) sent when online.
import { get, post, setStaffToken } from "./api.js";
import { kvGet, kvSet } from "./offline.js";
import { uuid } from "./format.js";

let shopKey = "";
export const setKitchenShop = (id) => (shopKey = id);
const k = (name) => `${name}:${shopKey}`;

export async function loadIngredients() {
  try {
    const r = await get("/kitchen/ingredients");
    await kvSet(k("ingredients"), r);
    return { ...r, offline: false };
  } catch (err) {
    if (!err.offline) throw err;
    const cached = await kvGet(k("ingredients"));
    if (!cached) throw err;
    return { ...cached, offline: true };
  }
}

export async function pendingMoves() {
  return (await kvGet(k("moves"))) || [];
}

// Records a cook entry. Sent now if online, otherwise kept and sent later.
export async function addMove(move) {
  const m = { clientId: uuid(), ...move };
  const queue = [...(await pendingMoves()), m];
  await kvSet(k("moves"), queue);
  return flushMoves();
}

let flushing = null;
export function flushMoves() {
  if (flushing) return flushing;
  flushing = (async () => {
    const queue = await pendingMoves();
    if (!queue.length) return { sent: 0, left: 0 };
    try {
      const { results } = await post("/kitchen/moves", { moves: queue });
      const done = new Set(results.filter((r) => r.ok).map((r) => r.clientId));
      const failed = results.filter((r) => !r.ok);
      const left = queue.filter((m) => !done.has(m.clientId) && !failed.some((f) => f.clientId === m.clientId));
      await kvSet(k("moves"), left);
      return { sent: done.size, left: left.length, errors: failed.map((f) => f.error) };
    } catch (err) {
      if (err.offline) return { sent: 0, left: queue.length, offline: true };
      throw err;
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// ---------- Who is using the shared kitchen phone ----------
const IDLE_MS = 10 * 60 * 1000;
let current = null; // { token, staff, at }
const listeners = new Set();
export const onStaffChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export function currentStaff() {
  if (current && Date.now() - current.at > IDLE_MS) signOutStaff();
  return current?.staff || null;
}
export function setCurrentStaff(token, staff) {
  current = { token, staff, at: Date.now() };
  setStaffToken(token);
  listeners.forEach((l) => l(staff));
}
export function touchStaff() {
  if (current) current.at = Date.now();
}
export function signOutStaff() {
  current = null;
  setStaffToken(null);
  listeners.forEach((l) => l(null));
}
