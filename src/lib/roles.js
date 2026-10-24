// Who is signed in: the owner (or admin) sees everything; a billing manager runs billing and the
// kitchen but no money reports; a cook (own phone or the shared kitchen phone) sees the kitchen only.
export const isOwner = (user) => user?.role === "owner" || user?.role === "admin";
export const isManager = (user) => user?.role === "manager";
export const isCook = (user) => user?.role === "kitchen";
