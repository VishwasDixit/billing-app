// Local API server: `npm run dev` (Vite proxies /api here).
// Without MONGODB_URI in .env.local it starts a local MongoDB that keeps its data in .data/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [".env.local", ".env"]) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    // `vercel link` writes the live database URI into .env.local. Local testing must not
    // touch real shop data, so it's only used when DEV_USE_REMOTE_DB=1 is set explicitly.
    if (m[1] === "MONGODB_URI" && process.env.DEV_USE_REMOTE_DB !== "1") continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

process.env.JWT_SECRET ||= "dev-only-secret-change-me-in-production";
// Without Gmail settings, print email codes to this log so OTP flows can be tried locally.
process.env.OTP_DEV_LOG ||= "1";

if (!process.env.MONGODB_URI) {
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const dbPath = path.join(root, ".data", "mongo");
  fs.mkdirSync(dbPath, { recursive: true });
  const mongod = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: "wiredTiger", port: 27027 } });
  process.env.MONGODB_URI = mongod.getUri();
  console.log(`Local MongoDB (data in .data/mongo): ${process.env.MONGODB_URI}`);
  const stop = async () => {
    await mongod.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const { handle } = await import("./router.js");
const port = Number(process.env.API_PORT) || 3001;
http.createServer(handle).listen(port, () => console.log(`API on http://localhost:${port}`));
