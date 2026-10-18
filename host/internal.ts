// The internal API: what a user's runtime (the agent's tools) may ask of the
// host — send a notification, run a service, call an integration, open the
// browser. Every call carries `x-openzo-runtime: <user>.<token>`, where the
// token is an HMAC of the user name under the host secret, handed to the
// runtime in its env at boot. A runtime can therefore only ever act as its
// own user, and nothing outside the host's runtimes can mint a token.
//
// Served on the main listener under /internal/ (process driver) and on the
// internal bridge listener (gvisor driver), the one host port containers may
// reach.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { users, type User } from "./db";
import { HttpError, json, match, type Handler } from "./http";

export function runtimeToken(name: string): string {
  return createHmac("sha256", config.secret).update(`runtime:${name}`).digest("base64url");
}

export function internalBase(containerized: boolean): string {
  if (containerized) return `http://${config.internalHost ?? "host.docker.internal"}:${config.internalPort}/internal`;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}/internal`;
}

export function runtimeUser(req: Request): User {
  const h = req.headers.get("x-openzo-runtime") ?? "";
  const dot = h.lastIndexOf(".");
  const name = h.slice(0, dot);
  const given = Buffer.from(h.slice(dot + 1));
  const want = Buffer.from(runtimeToken(name));
  if (dot < 1 || given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, "bad runtime token");
  const u = users.byName(name);
  if (!u || u.disabled) throw new HttpError(403, "user disabled");
  return u;
}

export type InternalHandler = (ctx: { req: Request; url: URL; params: string[]; user: User }) => Promise<Response> | Response;
const table: { method: string; re: RegExp; fn: Handler }[] = [];
const handlers = new Map<Handler, InternalHandler>();

export function internalRoute(method: string, path: string, fn: InternalHandler) {
  const stub: Handler = () => new Response(null);
  handlers.set(stub, fn);
  table.push({ method, re: new RegExp(`^/internal${path.replace(/:[a-z]+/g, "([^/]+)")}$`), fn: stub });
}

export async function handleInternal(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const hit = match(table, req.method, url.pathname);
    if (!hit) throw new HttpError(404, "no such internal endpoint");
    const user = runtimeUser(req);
    return await handlers.get(hit.fn)!({ req, url, params: hit.params, user });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(`[openzo] internal ${req.method} ${url.pathname}:`, e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
}

internalRoute("GET", "/whoami", ({ user }) => json({ user: user.name }));
