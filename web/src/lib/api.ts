// Thin client for the openzo host API. Same-origin; the session cookie rides
// along automatically.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The session token, kept client-side so it survives auth proxies that strip
// our cookie (see host/auth.ts). The cookie still works where it's allowed.
const TOKEN_KEY = "openzo-session";
export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string | undefined | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
};

export function authHeaders(): Record<string, string> {
  const t = session.get();
  return t ? { "x-openzo-session": t } : {};
}

// For places that can't send headers: websockets, <a href>, <img src>.
export function authUrl(path: string): string {
  const t = session.get();
  if (!t) return path;
  return `${path}${path.includes("?") ? "&" : "?"}oz_token=${encodeURIComponent(t)}`;
}

export async function authFetch(path: string, init: RequestInit = {}) {
  return fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers as Record<string, string>) } });
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { accept: "application/json", ...authHeaders(), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (data && typeof data === "object" && typeof data.token === "string") session.set(data.token);
  if (res.status === 401 && session.get() && !path.startsWith("/api/login")) session.set(null);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `${res.status} ${res.statusText}`);
  return data as T;
}

export interface Me {
  id: number;
  name: string;
  email: string | null;
  role: "admin" | "user";
}

export interface Bootstrap {
  version: string;
  needsSetup: boolean;
  signup: "open" | "invite" | "closed";
  driver: "process" | "gvisor";
  user: Me | null;
}

export interface Conversation {
  id: string;
  title: string;
  source: string;
  created: number;
  updated: number;
}

export interface Feature {
  id: string;
  name: string;
  status: "working" | "partial" | "stub";
  detail: string;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
