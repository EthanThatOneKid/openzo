// Sites & services — openzo's answer to Zo Space, Zo Sites and user services.
//
// A service is either
//   static   a folder in the user's workspace served as a website (index.html,
//            clean URLs, 404.html, optional SPA fallback), or
//   process  a long-running command (bash -lc) in the user's sandbox that
//            listens on $PORT; the host supervises it (restart with backoff)
//            and reverse-proxies HTTP + websockets to it.
// Every user gets a static service named "space" rooted at workspace/space —
// their personal site, created on first visit to the Sites page.
//
// Where a site is reachable:
//   <host>/s/<user>/<service>/                 always
//   https://<service>-<user>.<OPENZO_SITES_DOMAIN>   with a wildcard domain
//   any custom domain the user attaches (CNAME/A to this host)
// Public services need no sign-in. Private ones need the owner's openzo
// session; on other hostnames that is a one-time ticket minted on the main
// origin and exchanged for a site-scoped cookie.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { audit, db, now, users, type User } from "./db";
import { HttpError, body, json, originOf, requireUser, route } from "./http";
import { internalRoute } from "./internal";
import { allocatePort, containerName, ensureDirs, ensureRuntime, keepAliveChecks, paths, releasePort } from "./runtime";
import { userFrom } from "./auth";

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT,
  root TEXT,
  port INTEGER,
  env TEXT NOT NULL DEFAULT '{}',
  spa INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  domains TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
`);

export interface ServiceRow {
  id: number;
  user_id: number;
  name: string;
  kind: "static" | "process";
  command: string | null;
  root: string | null;
  port: number | null;
  env: string;
  spa: number;
  public: number;
  enabled: number;
  domains: string;
  created: number;
  updated: number;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const q = {
  forUser: (uid: number) => db.query("SELECT * FROM services WHERE user_id = ? ORDER BY name = 'space' DESC, name").all(uid) as ServiceRow[],
  get: (uid: number, name: string) => db.query("SELECT * FROM services WHERE user_id = ? AND name = ?").get(uid, name) as ServiceRow | null,
  all: () => db.query("SELECT * FROM services").all() as ServiceRow[],
};

// Custom domain → service id, rebuilt whenever a service changes.
let domainIndex = new Map<string, number>();
function reindexDomains() {
  const next = new Map<string, number>();
  for (const r of q.all()) for (const d of JSON.parse(r.domains || "[]") as string[]) next.set(d, r.id);
  domainIndex = next;
}
reindexDomains();

const hostOf = (req: Request, url: URL) => (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host).toLowerCase().replace(/:\d+$/, "");

// Cheap pre-check for server.ts: does this request belong to a site?
export function isSiteRequest(req: Request, url: URL): boolean {
  if (url.pathname.startsWith("/s/")) return true;
  const host = hostOf(req, url);
  if (config.sitesDomain && host.endsWith(`.${config.sitesDomain}`)) return true;
  return domainIndex.has(host);
}

// ---------------------------------------------------------------- supervisor

type ProcState = "stopped" | "starting" | "running" | "crashed";
interface Supervised {
  state: ProcState;
  proc?: ReturnType<typeof Bun.spawn>;
  port?: number; // where the host reaches it
  target?: string; // http://ip:port
  restarts: number[];
  timer?: Timer;
  stopping?: boolean;
  error?: string;
}
const live = new Map<number, Supervised>();
const svcKey = (r: ServiceRow) => r.id;

function logPath(user: string, name: string) {
  const dir = join(paths(user).root, "services");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.log`);
}

function rotate(log: string) {
  if (existsSync(log) && statSync(log).size > 5 * 1024 * 1024) renameSync(log, `${log}.1`);
}

const containerIps = new Map<string, string>();
async function containerIp(user: string): Promise<string> {
  const cached = containerIps.get(user);
  if (cached) return cached;
  const proc = Bun.spawn([config.docker, "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", containerName(user)], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim().split(/\s+/)[0] ?? "";
  await proc.exited;
  const ip = out || "127.0.0.1";
  containerIps.set(user, ip);
  setTimeout(() => containerIps.delete(user), 60_000).unref?.();
  return ip;
}

function workdirFor(row: ServiceRow, user: string, inContainer: boolean): string {
  const base = inContainer ? "/workspace" : paths(user).workspace;
  const rel = (row.root ?? "").replace(/^\/+/, "").replace(/^workspace\/?/, "");
  const wd = normalize(join(base, rel));
  if (wd !== base && !wd.startsWith(base + sep)) throw new HttpError(400, "workdir escapes the workspace");
  return wd;
}

async function launch(row: ServiceRow, sup: Supervised) {
  const user = users.byId(row.user_id);
  if (!user || user.disabled) return;
  const env = JSON.parse(row.env || "{}") as Record<string, string>;
  const log = logPath(user.name, row.name);
  rotate(log);
  const fd = openSync(log, "a");
  writeFileSync(fd, `\n[openzo] ${new Date().toISOString()} starting: ${row.command}\n`);
  sup.state = "starting";
  sup.error = undefined;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    if (config.driver === "gvisor") {
      await ensureRuntime(user);
      const port = row.port ?? 8000;
      const wd = workdirFor(row, user.name, true);
      const pidfile = `/state/services/${row.name}.pid`;
      const script = `mkdir -p /state/services; cd ${JSON.stringify(wd)} || exit 1; echo $$ > ${pidfile}; exec setsid bash -lc "$OZ_CMD"`;
      const args = [config.docker, "exec", "-i", "-w", "/workspace", "-e", `PORT=${port}`, "-e", `OZ_CMD=${row.command}`];
      for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
      args.push(containerName(user.name), "bash", "-c", script);
      proc = Bun.spawn(args, { stdin: "ignore", stdout: fd, stderr: fd });
      sup.port = port;
      sup.target = `http://${await containerIp(user.name)}:${port}`;
    } else {
      const port = row.port && row.port > 0 ? row.port : await allocatePort();
      const p = ensureDirs(user.name);
      const passthrough: Record<string, string> = {};
      for (const k of ["PATH", "LANG", "TZ", "SSL_CERT_FILE"]) if (process.env[k]) passthrough[k] = process.env[k]!;
      // Same /workspace → real-root rewrite the agent's bash tool does.
      const cmd = row.command!.replace(/(^|[\s'"=:(;|&<>])\/workspace(?=$|[\s/'");|&<>])/g, `$1${p.workspace}`);
      proc = Bun.spawn(["setsid", "bash", "-lc", cmd], {
        cwd: workdirFor(row, user.name, false),
        env: { ...passthrough, ...env, HOME: p.workspace, PORT: String(port), HOST: "127.0.0.1", OPENZO_WORKSPACE: p.workspace },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
      sup.port = port;
      sup.target = `http://127.0.0.1:${port}`;
    }
  } catch (e) {
    closeSync(fd);
    sup.state = "crashed";
    sup.error = String((e as Error)?.message ?? e);
    return;
  }
  sup.proc = proc;
  sup.state = "running";
  proc.exited.then((code) => {
    try {
      writeFileSync(fd, `[openzo] ${new Date().toISOString()} exited with code ${code}\n`);
      closeSync(fd);
    } catch {}
    if (config.driver !== "gvisor" && sup.port && !(row.port && row.port > 0)) releasePort(sup.port);
    sup.proc = undefined;
    if (sup.stopping) {
      sup.state = "stopped";
      return;
    }
    // Crash loop guard: 5 exits inside 2 minutes and we stop trying.
    const t = Date.now();
    sup.restarts = sup.restarts.filter((x) => t - x < 120_000).concat(t);
    if (sup.restarts.length >= 5) {
      sup.state = "crashed";
      sup.error = `exited ${sup.restarts.length} times in 2 minutes (last code ${code}); see the log`;
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** (sup.restarts.length - 1));
    sup.state = "starting";
    sup.timer = setTimeout(() => {
      const fresh = db.query("SELECT * FROM services WHERE id = ?").get(row.id) as ServiceRow | null;
      if (fresh && fresh.enabled && fresh.kind === "process" && !sup.stopping) void launch(fresh, sup);
      else sup.state = "stopped";
    }, delay);
  });
}

export async function startService(row: ServiceRow) {
  if (row.kind !== "process" || !row.command) return;
  let sup = live.get(svcKey(row));
  if (sup?.proc || sup?.state === "starting") return;
  sup = { state: "stopped", restarts: [] };
  live.set(svcKey(row), sup);
  await launch(row, sup);
}

export async function stopService(row: ServiceRow) {
  const sup = live.get(svcKey(row));
  if (!sup) return;
  sup.stopping = true;
  if (sup.timer) clearTimeout(sup.timer);
  const proc = sup.proc;
  if (proc && proc.exitCode === null) {
    if (config.driver === "gvisor") {
      const user = users.byId(row.user_id);
      if (user) {
        const kill = `p=$(cat /state/services/${row.name}.pid 2>/dev/null) && { kill -TERM -- -$p 2>/dev/null || kill -TERM $p; sleep 3; kill -KILL -- -$p 2>/dev/null; }; true`;
        await Bun.spawn([config.docker, "exec", containerName(user.name), "sh", "-c", kill], { stdout: "ignore", stderr: "ignore" }).exited;
      }
      proc.kill();
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!done) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }
    }
    await Promise.race([proc.exited, Bun.sleep(3000)]);
  }
  sup.state = "stopped";
  live.delete(svcKey(row));
}

keepAliveChecks.push((name) => {
  const u = users.byName(name);
  if (!u) return false;
  return q.forUser(u.id).some((r) => r.kind === "process" && live.get(r.id)?.proc);
});

function status(row: ServiceRow) {
  if (row.kind === "static") return { state: row.enabled ? "running" : "stopped" };
  const sup = live.get(row.id);
  return { state: sup?.state ?? "stopped", error: sup?.error ?? null };
}

// ---------------------------------------------------------------- views

function urlsFor(row: ServiceRow, user: string, origin: string) {
  const out = [`${origin}/s/${user}/${row.name}/`];
  if (config.sitesDomain) {
    const scheme = origin.startsWith("https") ? "https" : "http";
    out.push(`${scheme}://${row.name}-${user}.${config.sitesDomain}/`);
  }
  for (const d of JSON.parse(row.domains || "[]") as string[]) out.push(`https://${d}/`);
  return out;
}

export function serviceView(row: ServiceRow, user: string, origin: string) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    command: row.command,
    root: row.root,
    port: row.port,
    env: Object.keys(JSON.parse(row.env || "{}")),
    spa: !!row.spa,
    public: !!row.public,
    enabled: !!row.enabled,
    domains: JSON.parse(row.domains || "[]"),
    urls: urlsFor(row, user, origin),
    ...status(row),
    created: row.created,
    updated: row.updated,
  };
}

// ---------------------------------------------------------------- mutations

export interface ServiceInput {
  name?: string;
  kind?: "static" | "process";
  command?: string;
  root?: string;
  port?: number | null;
  env?: Record<string, string>;
  spa?: boolean;
  public?: boolean;
  enabled?: boolean;
  domains?: string[];
}

function cleanDomains(list: unknown, ownerId: number, selfId?: number): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!d) continue;
    if (!DOMAIN_RE.test(d)) throw new HttpError(400, `not a domain: ${d}`);
    const main = config.publicUrl ? new URL(config.publicUrl).hostname : null;
    if (d === main || (config.sitesDomain && (d === config.sitesDomain || d.endsWith(`.${config.sitesDomain}`)))) throw new HttpError(400, `${d} belongs to this server`);
    const taken = (q.all() as ServiceRow[]).find((r) => r.id !== selfId && (JSON.parse(r.domains) as string[]).includes(d));
    if (taken) throw new HttpError(409, `${d} is already attached to another site`);
    out.push(d);
  }
  return [...new Set(out)].slice(0, 10);
  void ownerId;
}

export async function upsertService(user: User, input: ServiceInput, existing?: ServiceRow | null): Promise<ServiceRow> {
  const name = String(existing?.name ?? input.name ?? "").toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, "service name: a–z, 0–9, dash, starting with a letter, max 31 chars");
  const kind = existing?.kind ?? input.kind ?? (input.command ? "process" : "static");
  if (kind !== "static" && kind !== "process") throw new HttpError(400, "kind must be static or process");
  if (!existing && q.forUser(user.id).length >= config.maxServicesPerUser) throw new HttpError(429, `at most ${config.maxServicesPerUser} services per user`);
  const command = input.command !== undefined ? String(input.command).trim() : existing?.command ?? null;
  if (kind === "process" && !command) throw new HttpError(400, "a process service needs a command");
  const root = input.root !== undefined ? String(input.root).trim() : existing?.root ?? (kind === "static" ? name : "");
  if (kind === "static") {
    const dir = resolve(paths(user.name).workspace, `./${root.replace(/^\/+/, "").replace(/^workspace\/?/, "")}`);
    if (!dir.startsWith(paths(user.name).workspace)) throw new HttpError(400, "root escapes the workspace");
    mkdirSync(dir, { recursive: true });
  }
  let port = input.port !== undefined ? (input.port === null ? null : Number(input.port)) : existing?.port ?? null;
  if (port !== null && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new HttpError(400, "port must be 1024–65535");
  const env = input.env !== undefined ? Object.fromEntries(Object.entries(input.env ?? {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => [k, String(v)])) : JSON.parse(existing?.env ?? "{}");
  const domains = input.domains !== undefined ? cleanDomains(input.domains, user.id, existing?.id) : JSON.parse(existing?.domains ?? "[]");
  const fields = {
    kind,
    command,
    root,
    port,
    env: JSON.stringify(env),
    spa: input.spa !== undefined ? (input.spa ? 1 : 0) : existing?.spa ?? 0,
    public: input.public !== undefined ? (input.public ? 1 : 0) : existing?.public ?? 1,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing?.enabled ?? 1,
    domains: JSON.stringify(domains),
  };
  let row: ServiceRow;
  if (existing) {
    db.query(
      "UPDATE services SET kind=?, command=?, root=?, port=?, env=?, spa=?, public=?, enabled=?, domains=?, updated=? WHERE id=?",
    ).run(fields.kind, fields.command, fields.root, fields.port, fields.env, fields.spa, fields.public, fields.enabled, fields.domains, now(), existing.id);
    row = db.query("SELECT * FROM services WHERE id = ?").get(existing.id) as ServiceRow;
    // Visibility and domains are read per request; only a change to what the
    // process runs (or turning it off) needs a restart.
    const changed = (["command", "root", "port", "env", "enabled"] as const).some((k) => row[k] !== existing[k]);
    if (existing.kind === "process" && changed) await stopService(existing);
  } else {
    row = db
      .query(
        "INSERT INTO services (user_id, name, kind, command, root, port, env, spa, public, enabled, domains, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
      )
      .get(user.id, name, fields.kind, fields.command, fields.root, fields.port, fields.env, fields.spa, fields.public, fields.enabled, fields.domains, now(), now()) as ServiceRow;
  }
  reindexDomains();
  if (row.kind === "process" && row.enabled && !live.get(row.id)?.proc) await startService(row);
  audit(user.id, existing ? "service.update" : "service.create", { name, kind });
  return row;
}

export async function deleteService(user: User, row: ServiceRow) {
  await stopService(row);
  db.query("DELETE FROM services WHERE id = ?").run(row.id);
  reindexDomains();
  audit(user.id, "service.delete", { name: row.name });
}

export function ensureSpace(user: User): ServiceRow {
  const existing = q.get(user.id, "space");
  if (existing) return existing;
  const dir = join(paths(user.name).workspace, "space");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "index.html"))) {
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${user.name}'s space</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:12vh auto;padding:0 1.5rem;color:#2b2622;background:#faf7f2}h1{font-weight:600;letter-spacing:-.02em}code{background:#efe9df;padding:.1em .35em;border-radius:4px}</style>
</head><body><h1>${user.name}'s space</h1>
<p>This page lives in <code>space/index.html</code> in your openzo workspace. Edit it, or ask your agent to build something here.</p>
</body></html>
`,
    );
  }
  return db
    .query("INSERT INTO services (user_id, name, kind, root, public, created, updated) VALUES (?, 'space', 'static', 'space', 1, ?, ?) RETURNING *")
    .get(user.id, now(), now()) as ServiceRow;
}

export async function startAllServices() {
  for (const row of q.all()) {
    if (row.kind === "process" && row.enabled) {
      const u = users.byId(row.user_id);
      if (u && !u.disabled) void startService(row).catch(() => {});
    }
  }
}

export async function stopAllServices() {
  await Promise.all([...live.keys()].map((id) => {
    const row = db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
    return row ? stopService(row) : null;
  }));
}

export async function stopUserServices(userId: number) {
  for (const r of q.forUser(userId)) await stopService(r);
}

// ---------------------------------------------------------------- serving

// Site-scoped auth for private services on other hostnames.
const sign = (s: string) => createHmac("sha256", config.secret).update(`site:${s}`).digest("base64url");
function signedOk(value: string, mac: string) {
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(value));
  return a.length === b.length && timingSafeEqual(a, b);
}
function makeTicket(userId: number, host: string, ttlMs: number) {
  const v = `${userId}.${host}.${Date.now() + ttlMs}`;
  return `${Buffer.from(v).toString("base64url")}.${sign(v)}`;
}
function readTicket(t: string | null, host: string): number | null {
  if (!t) return null;
  const [b64, mac] = t.split(".");
  if (!b64 || !mac) return null;
  const v = Buffer.from(b64, "base64url").toString();
  if (!signedOk(v, mac)) return null;
  const parts = v.split(".");
  const exp = Number(parts.pop());
  const uid = Number(parts.shift());
  if (parts.join(".") !== host || !(exp > Date.now())) return null;
  return uid;
}
const SITE_COOKIE = "oz_site";
function cookieValue(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

interface Resolved {
  row: ServiceRow;
  owner: User;
  prefix: string; // path prefix stripped before forwarding ("" on own hostnames)
  rest: string;
  ownHost: boolean;
}

export function resolveSite(req: Request, url: URL): Resolved | null | "redirect-slash" {
  const host = hostOf(req, url);
  {
    let row: ServiceRow | null = null;
    let owner: User | null = null;
    if (config.sitesDomain && host.endsWith(`.${config.sitesDomain}`)) {
      const label = host.slice(0, -(config.sitesDomain.length + 1));
      if (!label.includes(".")) {
        // <service>-<user>; both may contain dashes, so try every split.
        const bits = label.split("-");
        for (let i = 1; i < bits.length && !row; i++) {
          const u = users.byName(bits.slice(i).join("-"));
          if (u) {
            row = q.get(u.id, bits.slice(0, i).join("-"));
            owner = row ? u : null;
          }
        }
      }
    } else {
      const id = domainIndex.get(host);
      row = id ? (db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null) : null;
      owner = row ? users.byId(row.user_id) : null;
    }
    if (row && owner) return { row, owner, prefix: "", rest: url.pathname, ownHost: true };
  }
  const m = /^\/s\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  const owner = users.byName(m[1]!);
  if (!owner) return null;
  const row = q.get(owner.id, m[2]!);
  if (!row) return null;
  if (m[3] === undefined) return "redirect-slash";
  return { row, owner, prefix: `/s/${m[1]}/${m[2]}`, rest: m[3], ownHost: false };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".xml": "application/xml", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
};

function serveStaticSite(r: Resolved, req: Request): Response {
  const root = resolve(paths(r.owner.name).workspace, `./${(r.row.root ?? "").replace(/^\/+/, "").replace(/^workspace\/?/, "")}`);
  let rel: string;
  try {
    rel = decodeURIComponent(r.rest);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (rel.split("/").some((s) => s.startsWith(".") && s !== "")) return new Response("not found", { status: 404 });
  const target = resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + sep)) return new Response("not found", { status: 404 });
  const candidates = rel.endsWith("/") ? [join(target, "index.html")] : [target, `${target}.html`, join(target, "index.html")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      if (c === join(target, "index.html") && !rel.endsWith("/")) {
        const loc = `${r.prefix}${rel}/${new URL(req.url).search}`;
        return new Response(null, { status: 301, headers: { location: loc } });
      }
      const ext = c.slice(c.lastIndexOf(".")).toLowerCase();
      return new Response(Bun.file(c), { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
    }
  }
  if (r.row.spa && existsSync(join(root, "index.html"))) return new Response(Bun.file(join(root, "index.html")), { headers: { "content-type": MIME[".html"]! } });
  if (existsSync(join(root, "404.html"))) return new Response(Bun.file(join(root, "404.html")), { status: 404, headers: { "content-type": MIME[".html"]! } });
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "content-encoding", "content-length"]);

async function proxyProcess(r: Resolved, req: Request, url: URL): Promise<Response> {
  const sup = live.get(r.row.id);
  if (!sup?.target || !r.row.enabled) {
    if (r.row.enabled && !sup) void startService(r.row);
    return new Response(`${r.row.name} is ${sup?.state ?? "stopped"}${sup?.error ? `: ${sup.error}` : ""}. Open Sites in openzo to see its log.`, { status: 503, headers: { "content-type": "text/plain", "retry-after": "3" } });
  }
  const headers = new Headers();
  for (const [k, v] of req.headers) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== "cookie") headers.set(k, v);
  // Pass the user's own cookies through, never openzo's session cookies.
  const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/).filter((c) => c && !/^(oz_session|oz_site)=/.test(c));
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  headers.set("x-forwarded-host", req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host);
  headers.set("x-forwarded-proto", req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", ""));
  if (r.prefix) headers.set("x-forwarded-prefix", r.prefix);
  try {
    const res = await fetch(`${sup.target}${r.rest}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // @ts-expect-error Bun streams request bodies with duplex
      duplex: "half",
    });
    const out = new Headers();
    for (const [k, v] of res.headers) if (!HOP.has(k.toLowerCase())) out.append(k, v);
    const loc = out.get("location");
    if (loc && r.prefix && loc.startsWith("/") && !loc.startsWith(r.prefix)) out.set("location", r.prefix + loc);
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    return new Response(`${r.row.name} is not answering on port ${sup.port}: ${String((e as Error)?.message ?? e)}`, { status: 502, headers: { "content-type": "text/plain" } });
  }
}

// Websocket pass-through for process services (dev servers, live apps).
export interface SiteWs {
  kind: "site";
  target: string;
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
}

export const siteWebsocket = {
  open(ws: import("bun").ServerWebSocket<SiteWs>) {
    const up = new WebSocket(ws.data.target);
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m as string);
      ws.data.queue = [];
    };
    up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
    up.onclose = () => ws.close();
    up.onerror = () => ws.close(1011, "upstream error");
  },
  message(ws: import("bun").ServerWebSocket<SiteWs>, m: string | Buffer) {
    const data = typeof m === "string" ? m : new Uint8Array(m);
    if (ws.data.upstream?.readyState === 1) ws.data.upstream.send(data as string);
    else ws.data.queue.push(data);
  },
  close(ws: import("bun").ServerWebSocket<SiteWs>) {
    ws.data.upstream?.close();
  },
};

// Entry point from server.ts. Returns null when the request is not for a site.
export async function handleSite(req: Request, url: URL, server: Bun.Server<any>): Promise<Response | null | undefined> {
  const r = resolveSite(req, url);
  if (r === null) return null;
  if (r === "redirect-slash") return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
  const host = hostOf(req, url);

  // Ticket exchange on site hostnames: /__openzo_auth?ticket=…&next=/path
  if (r.ownHost && r.rest === "/__openzo_auth") {
    const uid = readTicket(url.searchParams.get("ticket"), host);
    if (uid !== r.owner.id) return new Response("sign-in link expired", { status: 403 });
    const next = url.searchParams.get("next") ?? "/";
    const cookie = makeTicket(uid, host, 7 * 86_400_000);
    return new Response(null, {
      status: 302,
      headers: { location: next.startsWith("/") ? next : "/", "set-cookie": `${SITE_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : ""}` },
    });
  }

  if (!r.row.public) {
    const viewer = r.ownHost ? readTicket(cookieValue(req, SITE_COOKIE), host) : userFrom(req)?.id ?? null;
    if (viewer !== r.owner.id) {
      if (!r.ownHost) {
        return new Response("This site is private. Sign in to openzo as its owner.", { status: 403, headers: { "content-type": "text/plain" } });
      }
      const back = `${url.protocol}//${host}${r.rest}${url.search}`;
      return new Response(null, { status: 302, headers: { location: `${originOf()}/api/sites/auth?return=${encodeURIComponent(back)}` } });
    }
  }

  if (r.row.kind === "static") {
    if (!r.row.enabled) return new Response("This site is turned off.", { status: 503 });
    return serveStaticSite(r, req);
  }
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const sup = live.get(r.row.id);
    if (!sup?.target) return new Response("service not running", { status: 503 });
    const target = `${sup.target.replace(/^http/, "ws")}${r.rest}${url.search}`;
    if ((server as Bun.Server<SiteWs>).upgrade(req, { data: { kind: "site", target, queue: [] } })) return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
  }
  return proxyProcess(r, req, url);
}

// ---------------------------------------------------------------- user API

const one = (u: User, name: string) => {
  const row = q.get(u.id, String(name).toLowerCase());
  if (!row) throw new HttpError(404, "no such service");
  return row;
};

route("GET", "/api/sites", ({ req }) => {
  const u = requireUser(req);
  ensureSpace(u);
  return json({ services: q.forUser(u.id).map((r) => serviceView(r, u.name, originOf(req))), sitesDomain: config.sitesDomain ?? null, driver: config.driver });
});

route("POST", "/api/sites", async ({ req }) => {
  const u = requireUser(req);
  const b = await body<ServiceInput>(req);
  if (q.get(u.id, String(b.name ?? "").toLowerCase())) throw new HttpError(409, "a service with that name exists");
  const row = await upsertService(u, b);
  return json({ service: serviceView(row, u.name, originOf(req)) });
});

route("PATCH", "/api/sites/:name", async ({ req, params }) => {
  const u = requireUser(req);
  const row = await upsertService(u, await body<ServiceInput>(req), one(u, params[0]!));
  return json({ service: serviceView(row, u.name, originOf(req)) });
});

route("POST", "/api/sites/:name/restart", async ({ req, params }) => {
  const u = requireUser(req);
  const row = one(u, params[0]!);
  await stopService(row);
  if (row.enabled) await startService(row);
  return json({ service: serviceView(row, u.name, originOf(req)) });
});

route("DELETE", "/api/sites/:name", async ({ req, params }) => {
  const u = requireUser(req);
  const row = one(u, params[0]!);
  if (row.name === "space") throw new HttpError(400, "your space can be turned off but not deleted");
  await deleteService(u, row);
  return json({ ok: true });
});

route("GET", "/api/sites/:name/log", ({ req, params }) => {
  const u = requireUser(req);
  const row = one(u, params[0]!);
  const log = logPath(u.name, row.name);
  const text = existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-400).join("\n") : "";
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
});

// Private sites on their own hostnames: mint a short ticket for the owner.
route("GET", "/api/sites/auth", ({ req, url }) => {
  const back = url.searchParams.get("return") ?? "";
  let target: URL;
  try {
    target = new URL(back);
  } catch {
    throw new HttpError(400, "bad return url");
  }
  const u = userFrom(req);
  if (!u) return new Response(null, { status: 302, headers: { location: `/?next=${encodeURIComponent(url.pathname + url.search)}` } });
  const r = resolveSite(new Request(target, { headers: { host: target.host } }), target);
  if (!r || r === "redirect-slash" || r.owner.id !== u.id) throw new HttpError(403, "that site is not yours");
  const ticket = makeTicket(u.id, target.hostname.toLowerCase(), 60_000);
  return new Response(null, { status: 302, headers: { location: `${target.origin}/__openzo_auth?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(target.pathname + target.search)}` } });
});

// Caddy on-demand TLS: only issue certificates for hostnames we serve.
route("GET", "/api/sites/tls-ask", ({ req, url }) => {
  const domain = (url.searchParams.get("domain") ?? "").toLowerCase();
  const probe = new URL(`https://${domain}/`);
  const r = resolveSite(new Request(probe, { headers: { host: domain } }), probe);
  void req;
  return r && r !== "redirect-slash" && r.ownHost ? new Response("ok") : new Response("unknown host", { status: 404 });
});

// ---------------------------------------------------------------- runtime API

internalRoute("GET", "/services", ({ user }) => {
  ensureSpace(user);
  return json({ services: q.forUser(user.id).map((r) => serviceView(r, user.name, originOf())), sitesDomain: config.sitesDomain ?? null, driver: config.driver });
});

internalRoute("POST", "/services", async ({ req, user }) => {
  const b = await body<ServiceInput & { action?: string }>(req);
  const name = String(b.name ?? "").toLowerCase();
  const existing = q.get(user.id, name);
  const action = b.action ?? "upsert";
  if (action === "delete") {
    if (!existing) throw new HttpError(404, "no such service");
    if (existing.name === "space") throw new HttpError(400, "the space can be turned off (enabled=false) but not deleted");
    await deleteService(user, existing);
    return json({ ok: true, deleted: name });
  }
  if (action === "restart") {
    if (!existing) throw new HttpError(404, "no such service");
    await stopService(existing);
    if (existing.enabled) await startService(existing);
    await Bun.sleep(1500);
    return json({ service: serviceView(existing, user.name, originOf()) });
  }
  if (action === "logs") {
    if (!existing) throw new HttpError(404, "no such service");
    const log = logPath(user.name, existing.name);
    return json({ log: existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-120).join("\n") : "" });
  }
  if (name === "space") ensureSpace(user);
  const row = await upsertService(user, b, q.get(user.id, name));
  if (row.kind === "process") await Bun.sleep(1500);
  return json({ service: serviceView(row, user.name, originOf()) });
});
