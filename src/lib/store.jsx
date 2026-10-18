import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { get, post, put, del, ApiError } from "./api.js";
import { kvGet, kvSet, clearDeviceData, outboxAll, outboxPut, syncOutbox, unblockOutbox } from "./offline.js";
import { computeTotals } from "../../shared/totals.js";
import { uuid } from "./format.js";
import { warmLogo } from "../printer/index.js";

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

// Recomputed on the device so an expired trial is noticed even offline.
export function accessState(shop) {
  const s = shop?.status;
  if (!s) return { active: false, state: "expired", daysLeft: 0 };
  if (s.state === "admin") return { ...s, active: true };
  const endsAt = new Date(s.endsAt);
  const daysLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 864e5));
  return { ...s, active: endsAt > new Date(), daysLeft, state: endsAt > new Date() ? s.state : "expired" };
}

export function AppProvider({ children }) {
  const [session, setSession] = useState(null); // { user, shop }
  const [menu, setMenu] = useState([]);
  const [booting, setBooting] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState({ pending: 0, blocked: 0, errors: 0 });
  // Udhar customers: last list from the server, ones added offline, and unsynced bills.
  const [customerList, setCustomerList] = useState([]);
  const [pendingCustomers, setPendingCustomers] = useState({});
  const [outbox, setOutbox] = useState([]);
  const shopId = session?.shop?.id;
  const shopIdRef = useRef(shopId);
  shopIdRef.current = shopId;

  const applySession = useCallback(async (s) => {
    setSession(s);
    await kvSet("session", s);
    warmLogo(s?.shop);
  }, []);

  const refreshCounts = useCallback(async () => {
    const list = await outboxAll(shopIdRef.current);
    setOutbox(list);
    setSync({
      pending: list.length,
      blocked: list.filter((b) => b.syncState === "blocked").length,
      errors: list.filter((b) => b.syncState === "error").length,
    });
  }, []);

  const syncNow = useCallback(async () => {
    if (!shopIdRef.current) return;
    const r = await syncOutbox(shopIdRef.current);
    setOnline(!r.error?.offline);
    await refreshCounts();
    if (r.sent > 0) loadCustomersRef.current?.().catch(() => {});
    return r;
  }, [refreshCounts]);

  const loadCustomersRef = useRef(null);
  const loadCustomers = useCallback(async () => {
    const r = await get("/customers");
    setCustomerList(r.customers);
    await kvSet("customers", r.customers);
    // Customers added offline are on the server now once their bill has synced.
    setPendingCustomers((prev) => {
      const next = { ...prev };
      for (const c of r.customers) delete next[c.clientId];
      kvSet("pendingCustomers", next);
      return next;
    });
    return r;
  }, []);
  loadCustomersRef.current = loadCustomers;

  // Dues include udhar bills still waiting to upload from this device.
  const customers = useMemo(() => {
    const unsynced = {};
    for (const b of outbox) {
      if (b.paymentMode === "credit" && b.customer) unsynced[b.customer.clientId] = (unsynced[b.customer.clientId] || 0) + (b.creditAmount || 0);
    }
    const known = new Set(customerList.map((c) => c.clientId));
    const all = [
      ...customerList,
      ...Object.values(pendingCustomers).filter((c) => !known.has(c.clientId)).map((c) => ({ ...c, due: 0, pending: true })),
    ];
    return all.map((c) => {
      const due = Math.round(((c.due || 0) + (unsynced[c.clientId] || 0)) * 100) / 100;
      return { ...c, due, settled: due <= 0 };
    });
  }, [customerList, pendingCustomers, outbox]);

  const loadMenu = useCallback(async () => {
    const m = await get("/menu");
    setMenu(m);
    await kvSet("menu", m);
    return m;
  }, []);

  // Boot: show cached data instantly, then refresh from the server.
  useEffect(() => {
    (async () => {
      const cached = await kvGet("session");
      if (cached) {
        setSession(cached);
        setMenu((await kvGet("menu")) || []);
        setCustomerList((await kvGet("customers")) || []);
        setPendingCustomers((await kvGet("pendingCustomers")) || {});
        warmLogo(cached.shop);
        setBooting(false);
      }
      try {
        const fresh = await get("/auth/me");
        await applySession(fresh);
        await loadMenu();
        loadCustomers().catch(() => {});
        setOnline(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setSession(null);
          await kvSet("session", null);
        } else if (err.offline) {
          setOnline(false);
        }
      } finally {
        setBooting(false);
      }
    })();
  }, [applySession, loadMenu, loadCustomers]);

  // Bill-number prefix for this device (A, B, …) so offline devices never clash.
  const ensureDevice = useCallback(async () => {
    let dev = await kvGet("device");
    if (!dev || dev.shopId !== shopIdRef.current || dev.code.startsWith("T")) {
      let code;
      try {
        code = (await post("/devices")).code;
      } catch {
        if (dev?.shopId === shopIdRef.current) return dev; // keep the temporary code until online
        code = "T" + Math.floor(Math.random() * 900 + 100); // first use while offline
      }
      dev = { shopId: shopIdRef.current, code, counter: 0 };
      await kvSet("device", dev);
    }
    return dev;
  }, []);

  // Upload queued bills when we come online, and every 30 s.
  useEffect(() => {
    if (!shopId) return;
    refreshCounts();
    syncNow();
    ensureDevice().catch(() => {}); // get the bill-number prefix while we're online
    const goOnline = () => {
      setOnline(true);
      syncNow();
      ensureDevice().catch(() => {});
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    const t = setInterval(syncNow, 30000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      clearInterval(t);
    };
  }, [shopId, syncNow, refreshCounts, ensureDevice]);

  const nextBillNo = useCallback(async () => {
    const dev = { ...(await ensureDevice()) };
    dev.counter += 1;
    await kvSet("device", dev);
    return { billNo: `${dev.code}-${dev.counter}`, deviceCode: dev.code };
  }, []);

  const actions = useMemo(
    () => ({
      async login(email, password) {
        const s = await post("/auth/login", { email, password });
        await applySession(s);
        await loadMenu();
      },
      async register(data) {
        const s = await post("/auth/register", data);
        await applySession(s);
        await loadMenu();
      },
      async logout() {
        await syncNow().catch(() => {});
        try {
          await post("/auth/logout");
        } catch {
          /* offline: still log out locally */
        }
        await clearDeviceData();
        setSession(null);
        setMenu([]);
      },
      async refresh() {
        const s = await get("/auth/me");
        await applySession(s);
        return s;
      },
      async saveShop(patch) {
        const shop = await put("/shop", patch);
        await applySession({ ...session, shop });
        return shop;
      },
      loadMenu,
      // Returns the saved item (new items need its id before a photo can be attached).
      async saveMenuItem(item) {
        const { id, ...body } = item;
        const saved = id ? await put(`/menu/${id}`, body) : await post("/menu", body);
        await loadMenu();
        return saved;
      },
      async setMenuPhoto(id, dataUrl) {
        await put(`/menu/${id}/image`, { dataUrl });
        return loadMenu();
      },
      async removeMenuPhoto(id) {
        await del(`/menu/${id}/image`);
        return loadMenu();
      },
      async addDefaultPictures() {
        const r = await post("/menu/default-images");
        setMenu(r.menu);
        await kvSet("menu", r.menu);
        return r.updated;
      },
      async deleteMenuItem(id) {
        await del(`/menu/${id}`);
        return loadMenu();
      },
      async resetMenu() {
        const m = await post("/menu/reset-default");
        setMenu(m);
        await kvSet("menu", m);
      },
      // Saves a bill on this device first, then uploads it. Works offline.
      async recordBill({ items, discount, gstPercent, paymentMode, customer, paidNow }) {
        const { billNo, deviceCode } = await nextBillNo();
        const t = computeTotals(items, discount, gstPercent);
        const credit = paymentMode === "credit";
        const paid = credit ? Math.min(Math.max(Number(paidNow) || 0, 0), t.total) : t.total;
        const creditAmount = Math.round((t.total - paid) * 100) / 100;
        const bill = {
          shopId: shopIdRef.current,
          clientId: uuid(),
          billNo,
          deviceCode,
          createdAt: new Date().toISOString(),
          items: t.lines.map(({ itemId, name, variant, category, qty, rate, amount }) => ({ itemId, name, variant, category, qty, rate, amount })),
          itemCount: t.itemCount,
          subtotal: t.subtotal,
          discount: t.discount,
          gst: t.gst,
          gstPercent: t.gst.percent,
          total: t.total,
          paymentMode,
          status: "paid",
          ...(credit
            ? {
                customer: { clientId: customer.clientId, name: customer.name, phone: customer.phone || "", address: customer.address || "", note: customer.note || "" },
                paidNow: paid,
                creditAmount,
                // Printed on the receipt; the server recomputes dues itself.
                dueAfter: Math.round(((customers.find((c) => c.clientId === customer.clientId)?.due || 0) + creditAmount) * 100) / 100,
              }
            : {}),
        };
        await outboxPut(bill);
        await refreshCounts();
        syncNow();
        return bill;
      },
      loadCustomers,
      // Adds an udhar customer; works offline (created on the server when its bill syncs).
      async addCustomer({ name, phone = "", address = "", note = "" }) {
        const c = { clientId: uuid(), name: name.trim(), phone: phone.trim(), address: address.trim(), note: note.trim() };
        try {
          const saved = await post("/customers", c);
          await loadCustomers();
          return saved;
        } catch (err) {
          if (!err.offline) throw err;
          setPendingCustomers((prev) => {
            const next = { ...prev, [c.clientId]: c };
            kvSet("pendingCustomers", next);
            return next;
          });
          return { ...c, due: 0, pending: true };
        }
      },
      syncNow,
      async retryBlocked() {
        await unblockOutbox(shopIdRef.current);
        return syncNow();
      },
    }),
    [applySession, loadMenu, loadCustomers, nextBillNo, refreshCounts, session, syncNow, customers]
  );

  const value = { session, user: session?.user, shop: session?.shop, menu, customers, booting, online, sync, ...actions };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
