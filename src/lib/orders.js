// Table orders on this device. Works offline:
// - the last list from the server is cached, so tables and the kitchen still show orders;
// - staff orders are saved here first (and their KOT printed) and uploaded when online;
// - status changes made offline are queued and sent later.
import { useSyncExternalStore } from "react";
import { get, post } from "./api.js";
import { kvGet, kvSet } from "./offline.js";
import { uuid } from "./format.js";

let state = { orders: [], pending: [], statusQueue: [], online: true, loaded: false, waiting: 0 };
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
const set = (patch) => {
  state = { ...state, ...patch };
  state.waiting = state.orders.filter((o) => o.status === "new").length;
  emit();
};

let shopKey = null; // cached data belongs to one shop
const key = (k) => `${k}:${shopKey}`;

export async function initOrders(shopId) {
  if (shopKey === shopId) return;
  shopKey = shopId;
  const [orders, pending, statusQueue] = await Promise.all([kvGet(key("orders")), kvGet(key("orderOutbox")), kvGet(key("orderStatusOutbox"))]);
  set({ orders: orders || [], pending: pending || [], statusQueue: statusQueue || [], loaded: !!orders });
}

const OPEN = ["new", "accepted", "preparing", "ready", "served"];

// Server orders + this device's unsent orders, with offline status changes applied.
export function allOrders(s = state) {
  const byId = new Map(s.orders.map((o) => [o.clientId, o]));
  for (const p of s.pending) if (!byId.has(p.clientId)) byId.set(p.clientId, { ...p, pending: true });
  for (const q of s.statusQueue) {
    const o = byId.get(q.clientId);
    if (o) byId.set(q.clientId, { ...o, status: q.status, statusPending: true });
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export const isOpen = (o) => OPEN.includes(o.status);

export function useOrders() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state
  );
}

export async function refreshOrders() {
  try {
    await flushOrders();
    const r = await get("/orders");
    set({ orders: r.orders, online: true, loaded: true });
    await kvSet(key("orders"), r.orders);
  } catch (err) {
    if (err.offline) set({ online: false });
    else throw err;
  }
}

let flushing = null;
export function flushOrders() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (state.pending.length) {
      const { results } = await post("/orders", { orders: state.pending.map(({ pending, ...o }) => o) });
      const done = new Set(results.filter((r) => r.ok).map((r) => r.clientId));
      const pending = state.pending.filter((o) => !done.has(o.clientId));
      set({ pending, orders: [...state.orders.filter((o) => !done.has(o.clientId)), ...state.pending.filter((o) => done.has(o.clientId))] });
      await kvSet(key("orderOutbox"), pending);
    }
    for (const q of [...state.statusQueue]) {
      try {
        await post(`/orders/${q.clientId}/status`, { status: q.status, reason: q.reason || "" });
      } catch (err) {
        if (err.offline) throw err;
        // 404 / 409: someone else already moved it; drop our change.
      }
      const statusQueue = state.statusQueue.filter((x) => x !== q);
      set({ statusQueue });
      await kvSet(key("orderStatusOutbox"), statusQueue);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// Order numbers taken on this device: device letter + count for the day (A1, A2, …).
async function nextOrderNo() {
  const dev = (await kvGet("device")) || { code: "T" };
  const day = new Date().toLocaleDateString("en-CA");
  const c = (await kvGet(key("orderCounter"))) || {};
  const n = c.day === day ? c.n + 1 : 1;
  await kvSet(key("orderCounter"), { day, n });
  return `${String(dev.code).replace(/[^A-Z0-9]/gi, "")}${n}`;
}

// A waiter's order for a table: saved here first, then uploaded. Returns the order.
export async function createStaffOrder({ table, tableName, items, note = "" }) {
  const order = {
    clientId: uuid(),
    orderNo: await nextOrderNo(),
    table,
    tableName,
    note,
    status: "accepted",
    source: "staff",
    createdAt: new Date().toISOString(),
    items: items.map(({ itemId, name, variant = "", category = "", qty, rate, note: n = "" }) => ({ itemId, name, variant, category, qty, rate, note: n })),
  };
  order.total = Math.round(order.items.reduce((s, i) => s + i.qty * i.rate, 0) * 100) / 100;
  const pending = [...state.pending, order];
  set({ pending });
  await kvSet(key("orderOutbox"), pending);
  flushOrders().catch(() => set({ online: false }));
  return order;
}

// Accept / reject / preparing / ready / served. Shows at once; sent now or when back online.
export async function setOrderStatus(order, status, reason = "") {
  const local = (o) => (o.clientId === order.clientId ? { ...o, status, ...(reason && { rejectReason: reason }) } : o);
  if (order.pending) {
    const pending = state.pending.map(local);
    set({ pending });
    await kvSet(key("orderOutbox"), pending);
    return;
  }
  set({ orders: state.orders.map(local) });
  try {
    const saved = await post(`/orders/${order.clientId}/status`, { status, reason });
    set({ orders: state.orders.map((o) => (o.clientId === saved.clientId ? saved : o)), online: true });
  } catch (err) {
    if (!err.offline) {
      await refreshOrders().catch(() => {});
      throw err;
    }
    const statusQueue = [...state.statusQueue.filter((q) => q.clientId !== order.clientId), { clientId: order.clientId, status, reason }];
    set({ statusQueue, online: false });
    await kvSet(key("orderStatusOutbox"), statusQueue);
  }
  await kvSet(key("orders"), state.orders);
}

// After a table is billed on this device (the server also marks them when the bill uploads).
export async function markBilledLocally(ids) {
  const s = new Set(ids);
  const mark = (o) => (s.has(o.clientId) ? { ...o, status: "billed" } : o);
  set({ orders: state.orders.map(mark), pending: state.pending.map(mark) });
  await kvSet(key("orders"), state.orders);
  await kvSet(key("orderOutbox"), state.pending);
}

// Short beep for a new order (no sound file needed).
export function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const tone = (f, t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.26);
    };
    tone(880, 0);
    tone(1175, 0.18);
  } catch {
    /* no audio */
  }
}
