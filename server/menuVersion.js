// The menu's version: changes whenever something the menu screens show changes (a price, a dish,
// stock, add-ons, table-group prices, hours). Open screens check it cheaply and fetch the menu
// again only when it moved, so prices are live without anyone refreshing.
export async function bumpMenu(db, shopId) {
  // Now, or one more than before if two changes land in the same millisecond.
  await db.collection("shops").updateOne({ _id: shopId }, [
    { $set: { menuVersion: { $max: [Date.now(), { $add: [{ $ifNull: ["$menuVersion", 0] }, 1] }] } } },
  ]);
}

// Staff changes that touch the menu: anything under /menu (not photo downloads) and shop settings.
export const changesMenu = (method, path) => method !== "GET" && (/^\/menu(\/|$)/.test(path) || path === "/shop");
