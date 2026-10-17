// Device-local storage (IndexedDB): cached session/menu and the outbox of bills
// waiting to be uploaded.
import { openDB } from "idb";
import { post } from "./api.js";

const dbp = openDB("billing", 1, {
  upgrade(db) {
    db.createObjectStore("kv");
    db.createObjectStore("outbox", { keyPath: "clientId" });
  },
});

export async function kvGet(key) {
  try {
    return await (await dbp).get("kv", key);
  } catch {
    return undefined;
  }
}

export async function kvSet(key, value) {
  try {
    await (await dbp).put("kv", value, key);
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

export async function kvDel(key) {
  try {
    await (await dbp).delete("kv", key);
  } catch {
    /* ignore */
  }
}

// Bills for one shop (each bill remembers which shop made it).
export async function outboxAll(shopId) {
  try {
    const all = await (await dbp).getAll("outbox");
    return all.filter((b) => !shopId || b.shopId === shopId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function outboxPut(bill) {
  await (await dbp).put("outbox", bill);
}

export async function outboxDelete(clientId) {
  await (await dbp).delete("outbox", clientId);
}

export async function clearDeviceData() {
  const db = await dbp;
  await db.clear("kv");
  // Bills not yet uploaded are kept; they upload after the same shop logs in again.
}

let syncing = null;

// Uploads the shop's queued bills. Returns { sent, pending, blocked, error }.
export function syncOutbox(shopId) {
  if (syncing) return syncing;
  syncing = (async () => {
    const queue = (await outboxAll(shopId)).filter((b) => b.syncState !== "blocked");
    let sent = 0;
    let error = null;
    for (let i = 0; i < queue.length; i += 50) {
      const batch = queue.slice(i, i + 50);
      try {
        const { results } = await post("/bills", { bills: batch.map(({ syncState, syncError, shopId, ...b }) => b) });
        for (const r of results) {
          const bill = batch.find((b) => b.clientId === r.clientId);
          if (!bill) continue;
          if (r.ok) {
            await outboxDelete(r.clientId);
            sent++;
          } else {
            await outboxPut({ ...bill, syncState: r.code === 402 ? "blocked" : "error", syncError: r.error });
          }
        }
      } catch (err) {
        error = err;
        break;
      }
    }
    const left = await outboxAll(shopId);
    return { sent, pending: left.length, blocked: left.filter((b) => b.syncState === "blocked").length, error };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// Retry bills that were blocked (e.g. after the plan was renewed).
export async function unblockOutbox(shopId) {
  for (const b of await outboxAll(shopId)) {
    if (b.syncState) await outboxPut({ ...b, syncState: undefined, syncError: undefined });
  }
}
