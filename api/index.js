// Single Vercel function for the whole API (vercel.json rewrites /api/* here).
import { handle } from "../server/router.js";

export default handle;
