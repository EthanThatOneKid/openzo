// Shared HTTP plumbing: errors, JSON helpers, auth guards and the route table.
// Feature modules (services, channels, integrations, browser, skills, tokens…)
// import `route` and register their endpoints at module load; server.ts
// imports them for that side effect and dispatches through `routes`.
import { config } from "./config";
import type { User } from "./db";
import { userFrom } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export async function body<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "expected a JSON body");
  }
}

export function isSecure(req: Request): boolean {
  if (config.trustProxy && req.headers.get("x-forwarded-proto") === "https") return true;
  return new URL(req.url).protocol === "https:" || (config.publicUrl?.startsWith("https://") ?? false);
}

// The origin this host is reached at, for links handed to users (OAuth
// redirects, site URLs, Telegram replies).
export function originOf(req?: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  if (!req) return `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${isSecure(req) ? "https" : "http"}://${host}`;
}

// Same-origin check for state-changing requests (SameSite=Lax already blocks
// most cross-site POSTs; this closes the rest).
export function checkOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (new URL(origin).host !== host) throw new HttpError(403, "cross-origin request refused");
}

export function requireUser(req: Request): User {
  const u = userFrom(req);
  if (!u) throw new HttpError(401, "sign in first");
  return u;
}

export function requireAdmin(req: Request): User {
  const u = requireUser(req);
  if (u.role !== "admin") throw new HttpError(403, "admins only");
  return u;
}

export const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, disabled: !!u.disabled, created: u.created, lastSeen: u.last_seen });

export type Ctx = { req: Request; url: URL; params: string[]; server: Bun.Server<any> };
export type Handler = (ctx: Ctx) => Promise<Response> | Response;
export const routes: { method: string; re: RegExp; fn: Handler }[] = [];
export const route = (method: string, path: string, fn: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), fn });

export function match(table: typeof routes, method: string, pathname: string) {
  for (const r of table) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { fn: r.fn, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}
