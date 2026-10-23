export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
  get offline() {
    return this.status === 0;
  }
}

// On a shared kitchen phone, the worker who entered their PIN (sent with every request).
let staffToken = null;
export const setStaffToken = (t) => (staffToken = t || null);

export async function api(path, { method = "GET", body, signal } = {}) {
  let res;
  const headers = { ...(body !== undefined && { "Content-Type": "application/json" }), ...(staffToken && { "x-staff-token": staffToken }) };
  try {
    res = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "You're offline. Check the internet connection.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body) => api(p, { method: "POST", body: body ?? {} });
export const put = (p, body) => api(p, { method: "PUT", body });
export const del = (p) => api(p, { method: "DELETE" });
