import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Handlers return this when they need a status code or headers.
export const respond = (status, data, headers) => ({ __response: true, status, data, headers });

export function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

export function sendError(res, err) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return send(res, 400, { error: `${first.path.join(".") || "input"}: ${first.message}` });
  }
  if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
  console.error(err);
  return send(res, 500, { error: "Something went wrong on the server." });
}

const MAX_BODY = 512 * 1024;

// Returns { raw, json }. Reads the stream ourselves so webhooks can verify the raw body.
export async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return { raw: "", json: {} };
  let raw = "";
  if (!req.readableEnded) {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) throw new HttpError(413, "Request is too large.");
    }
  }
  if (!raw && req.body !== undefined) {
    // Platform already consumed and parsed the body.
    return { raw: typeof req.body === "string" ? req.body : JSON.stringify(req.body), json: typeof req.body === "string" ? safeJson(req.body) : req.body || {} };
  }
  return { raw, json: raw ? safeJson(raw) : {} };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    throw new HttpError(400, "Body must be valid JSON.");
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
