// Shops' payment-gateway secrets, encrypted at rest (AES-256-GCM). The key is the server-only
// PAYMENT_KEYS_SECRET (Vercel), or one derived from JWT_SECRET if that isn't set.
import crypto from "node:crypto";

const key = () => crypto.createHash("sha256").update(process.env.PAYMENT_KEYS_SECRET || `payment-keys:${process.env.JWT_SECRET || ""}`).digest();

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(box) {
  const [v, iv, tag, ct] = String(box || "").split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
