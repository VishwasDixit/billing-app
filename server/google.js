// Verifies "Sign in with Google" ID tokens (free, no SDK): checks the signature against
// Google's public keys, then the audience (GOOGLE_CLIENT_ID), issuer, expiry and that
// Google has verified the email. Tests can plug in their own verifier.
import crypto from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

let testVerifier = null;
export function setTestVerifier(fn) {
  testVerifier = fn;
}

export const googleClientId = () => (process.env.GOOGLE_CLIENT_ID || "").trim();
export const googleEnabled = () => !!googleClientId() || !!testVerifier;

export class GoogleError extends Error {
  name = "GoogleError";
}

let keys = { at: 0, ttl: 0, byKid: {} };
async function publicKey(kid) {
  if (!keys.byKid[kid] || Date.now() - keys.at > keys.ttl) {
    const r = await fetch(CERTS_URL);
    if (!r.ok) throw new GoogleError("Couldn't reach Google. Please try again.");
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get("cache-control") || "")?.[1] || 3600);
    const { keys: list } = await r.json();
    keys = { at: Date.now(), ttl: maxAge * 1000, byKid: Object.fromEntries(list.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: "jwk" })])) };
  }
  return keys.byKid[kid];
}

const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// Returns { email, name } for a valid credential, or throws GoogleError.
export async function verifyGoogleCredential(credential) {
  if (testVerifier) return testVerifier(credential);
  const clientId = googleClientId();
  if (!clientId) throw new GoogleError("Google sign-in isn't set up yet.");
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw new GoogleError("Google sign-in failed. Please try again.");
  let header, claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    throw new GoogleError("Google sign-in failed. Please try again.");
  }
  const key = header.alg === "RS256" && (await publicKey(header.kid));
  const signed = key && crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  if (!signed) throw new GoogleError("Google sign-in failed. Please try again.");
  if (claims.aud !== clientId || !ISSUERS.includes(claims.iss)) throw new GoogleError("This Google sign-in wasn't meant for this app.");
  if (!(claims.exp * 1000 > Date.now())) throw new GoogleError("Google sign-in expired. Please try again.");
  if (!claims.email || claims.email_verified === false) throw new GoogleError("Google hasn't verified this email address.");
  return { email: String(claims.email).toLowerCase(), name: claims.name || "" };
}
