// openzo host: the control plane in front of every user's agent runtime.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { config } from "./config";
import { audit, db, now, users, type User } from "./db";
import {
  clearCookie,
  clearFailures,
  createSession,
  destroySession,
  hashPassword,
  recordFailure,
  sessionCookie,
  throttled,
  tokenOf,
  userFrom,
  validName,
  verifyPassword,
} from "./auth";
import { agentHeaders, bumpConversation, continuationFrom, readEvents, recordConversation, titleFrom } from "./agent-client";
import { automations, nextRun, parseCron, runAutomation, startScheduler, validTz } from "./automations";
import * as files from "./files";
import { FileError } from "./files";
import {
  allRuntimes,
  driverCheck,
  ensureDirs,
  ensureRuntime,
  paths,
  restartRuntime,
  runtimeStatus,
  shellCommand,
  shutdownAll,
  stopRuntime,
  touch,
} from "./runtime";
import { maskedSettings, mergeSettings, PRESETS, readSettings } from "./settings";
import { FEATURES } from "./features";
import { handleInternal, internalRoute } from "./internal";
import { CHANNELS, startChannels, stopChannels } from "./channels";
import "./api";
import "./skills";
import "./profile";
import "./integrations";
import { handleSite, isSiteRequest, siteWebsocket, startAllServices, stopAllServices, type SiteWs } from "./services";
import { shutdownBrowsers } from "./browser";
import { HttpError, body, checkOrigin, isSecure, json, match, publicUser, requireAdmin, requireUser, route, routes } from "./http";

const VERSION = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version ?? "0.0.0";

// ------------------------------------------------------------------ helpers

function clientIp(req: Request, server: Bun.Server<WsData>): string {
  if (config.trustProxy) {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
  }
  return server.requestIP(req)?.address ?? "unknown";
}

// Issue a session: cookie for plain deployments, token in the body for the
// header/query carriers (see auth.ts tokenFrom).
function withSession(req: Request, user: User, body: Record<string, unknown>) {
  const token = createSession(user, req.headers.get("user-agent"));
  return json({ ...body, token }, 200, { "set-cookie": sessionCookie(token, isSecure(req)) });
}

function validPassword(p: unknown): string {
  if (typeof p !== "string" || p.length < 8) throw new HttpError(400, "password must be at least 8 characters");
  return p;
}

let lastSeenWrite = new Map<number, number>();
function seen(u: User) {
  const t = lastSeenWrite.get(u.id) ?? 0;
  if (now() - t > 60_000) {
    lastSeenWrite.set(u.id, now());
    users.update(u.id, { last_seen: now() });
  }
}

// ------------------------------------------------------------------ eve proxy

async function proxyEve(req: Request, user: User, url: URL): Promise<Response> {
  const runtime = await ensureRuntime(user);
  const target = `${runtime}${url.pathname}${url.search}`;
  const headers = new Headers(agentHeaders(user));
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("accept", req.headers.get("accept") ?? "*/*");

  const createMatch = req.method === "POST" && url.pathname === "/eve/v1/session";
  const followMatch = req.method === "POST" ? /^\/eve\/v1\/session\/([^/]+)$/.exec(url.pathname) : null;

  let reqBody: BodyInit | null = null;
  let parsed: any = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text();
    reqBody = text;
    if (createMatch || followMatch) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
  }

  const res = await fetch(target, { method: req.method, headers, body: reqBody, redirect: "manual" });
  touch(user.name);

  if (createMatch && res.ok) {
    const out = await res.text();
    try {
      const data = JSON.parse(out);
      if (data.sessionId) recordConversation(user, data.sessionId, titleFrom(parsed?.message), "chat", data.continuationToken);
    } catch {}
    return new Response(out, { status: res.status, headers: { "content-type": "application/json" } });
  }
  if (followMatch && res.ok) bumpConversation(user, decodeURIComponent(followMatch[1]!));

  const outHeaders = new Headers();
  for (const [k, v] of res.headers) {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) outHeaders.set(k, v);
  }
  outHeaders.set("cache-control", "no-store");
  outHeaders.set("x-accel-buffering", "no");
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

// ------------------------------------------------------------------ static

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webp": "image/webp",
};

function serveStatic(pathname: string): Response {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(config.webDist, rel);
  if (!file.startsWith(config.webDist) || !existsSync(file) || statSync(file).isDirectory()) {
    if (rel.startsWith("/assets/")) return new Response("not found", { status: 404 });
    file = join(config.webDist, "index.html");
  }
  if (!existsSync(file)) {
    return new Response("openzo: web UI not built. Run `npm run build` (or `cd web && npm run build`).", { status: 503 });
  }
  const ext = file.slice(file.lastIndexOf("."));
  const immutable = file.includes(`${join(config.webDist, "assets")}`);
  return new Response(Bun.file(file), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

// ------------------------------------------------------------------ routes

route("GET", "/api/health", async () => {
  const d = await driverCheck();
  return json({ ok: d.ok, version: VERSION, driver: config.driver, detail: d.detail }, d.ok ? 200 : 503);
});

route("GET", "/api/bootstrap", ({ req }) => {
  const u = userFrom(req);
  return json({
    version: VERSION,
    needsSetup: users.count() === 0,
    signup: config.signup,
    driver: config.driver,
    user: u ? publicUser(u) : null,
  });
});

route("POST", "/api/setup", async ({ req }) => {
  if (users.count() > 0) throw new HttpError(409, "already set up");
  const b = await body(req);
  const name = String(b.name ?? "").toLowerCase();
  if (!validName(name)) throw new HttpError(400, "username: 2–31 chars, a–z, 0–9, dash, starting with a letter");
  const user = users.create(name, await hashPassword(validPassword(b.password)), "admin", b.email ?? null);
  ensureDirs(name);
  audit(user.id, "setup.admin");
  return withSession(req, user, { user: publicUser(user) });
});

route("POST", "/api/login", async ({ req, server }) => {
  const ip = clientIp(req, server);
  if (throttled(ip)) throw new HttpError(429, "too many attempts, try again in 15 minutes");
  const b = await body(req);
  const user = users.byName(String(b.name ?? ""));
  if (!user || user.disabled || !(await verifyPassword(String(b.password ?? ""), user.pass))) {
    recordFailure(ip);
    throw new HttpError(401, "wrong username or password");
  }
  clearFailures(ip);
  audit(user.id, "login", { ip });
  return withSession(req, user, { user: publicUser(user) });
});

route("POST", "/api/logout", ({ req }) => {
  const t = tokenOf(req);
  if (t) destroySession(t);
  return json({ ok: true }, 200, { "set-cookie": clearCookie });
});

route("POST", "/api/signup", async ({ req }) => {
  if (config.signup === "closed") throw new HttpError(403, "sign-ups are closed on this server");
  const b = await body(req);
  const name = String(b.name ?? "").toLowerCase();
  if (!validName(name)) throw new HttpError(400, "username: 2–31 chars, a–z, 0–9, dash, starting with a letter");
  if (users.byName(name)) throw new HttpError(409, "that username is taken");
  let role: "user" | "admin" = "user";
  let inviteCode: string | null = null;
  if (config.signup === "invite") {
    inviteCode = String(b.invite ?? "").trim();
    const inv = db.query("SELECT * FROM invites WHERE code = ? AND used_by IS NULL").get(inviteCode) as any;
    if (!inv || (inv.expires && inv.expires < now())) throw new HttpError(403, "invite code is invalid or used");
    role = inv.role;
  }
  const user = users.create(name, await hashPassword(validPassword(b.password)), role, b.email ?? null);
  if (inviteCode) db.query("UPDATE invites SET used_by = ? WHERE code = ?").run(user.id, inviteCode);
  ensureDirs(name);
  audit(user.id, "signup", { invite: inviteCode });
  return withSession(req, user, { user: publicUser(user) });
});

route("GET", "/api/me", ({ req }) => json({ user: publicUser(requireUser(req)) }));

route("POST", "/api/me/password", async ({ req }) => {
  const u = requireUser(req);
  const b = await body(req);
  if (!(await verifyPassword(String(b.current ?? ""), u.pass))) throw new HttpError(403, "current password is wrong");
  users.update(u.id, { pass: await hashPassword(validPassword(b.password)) });
  db.query("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  audit(u.id, "password.change");
  return withSession(req, u, { ok: true });
});

route("GET", "/api/features", () => json({ features: FEATURES }));
route("GET", "/api/presets", () => json({ presets: PRESETS, default: config.defaultLane }));

route("GET", "/api/settings", ({ req }) => json({ settings: maskedSettings(readSettings(requireUser(req))) }));

route("PUT", "/api/settings", async ({ req }) => {
  const u = requireUser(req);
  const next = mergeSettings(readSettings(u), await body(req));
  users.update(u.id, { settings: JSON.stringify(next) });
  audit(u.id, "settings.update", { preset: next.model.preset });
  const fresh = users.byId(u.id)!;
  // The runtime reads its lane from env at boot: restart so the change lands.
  await restartRuntime(fresh);
  return json({ settings: maskedSettings(next) });
});

route("GET", "/api/runtime", ({ req }) => json(runtimeStatus(requireUser(req).name)));
route("POST", "/api/runtime/start", async ({ req }) => {
  const u = requireUser(req);
  await ensureRuntime(u);
  return json(runtimeStatus(u.name));
});
route("POST", "/api/runtime/restart", async ({ req }) => {
  const u = requireUser(req);
  await restartRuntime(u);
  await ensureRuntime(u);
  return json(runtimeStatus(u.name));
});
route("GET", "/api/runtime/log", ({ req }) => {
  const u = requireUser(req);
  const log = paths(u.name).log;
  if (config.driver === "gvisor") {
    return (async () => {
      const proc = Bun.spawn([config.docker, "logs", "--tail", "300", `openzo-u-${u.name}`], { stdout: "pipe", stderr: "pipe" });
      const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return new Response(o + e, { headers: { "content-type": "text/plain; charset=utf-8" } });
    })();
  }
  const text = existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-300).join("\n") : "";
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
});

// conversations
route("GET", "/api/conversations", ({ req }) => {
  const u = requireUser(req);
  const rows = db.query("SELECT id, title, source, created, updated FROM conversations WHERE user_id = ? ORDER BY updated DESC LIMIT 200").all(u.id);
  return json({ conversations: rows });
});

route("GET", "/api/conversations/:id", async ({ req, params }) => {
  const u = requireUser(req);
  const id = decodeURIComponent(params[0]!);
  const row = db.query("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, u.id) as any;
  if (!row) throw new HttpError(404, "conversation not found");
  const events = await readEvents(u, id);
  const continuationToken = continuationFrom(events) ?? row.continuation ?? undefined;
  return json({ conversation: { id: row.id, title: row.title, source: row.source }, session: { sessionId: id, continuationToken, streamIndex: events.length }, events });
});

route("PATCH", "/api/conversations/:id", async ({ req, params }) => {
  const u = requireUser(req);
  const b = await body(req);
  const title = String(b.title ?? "").trim().slice(0, 120);
  if (!title) throw new HttpError(400, "title required");
  db.query("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?").run(title, decodeURIComponent(params[0]!), u.id);
  return json({ ok: true });
});

route("DELETE", "/api/conversations/:id", ({ req, params }) => {
  const u = requireUser(req);
  db.query("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(decodeURIComponent(params[0]!), u.id);
  return json({ ok: true });
});

// files
const ws = (u: User) => ensureDirs(u.name).workspace;

route("GET", "/api/files", async ({ req, url }) => {
  const u = requireUser(req);
  const p = url.searchParams.get("path") ?? "/";
  return json({ path: p, entries: await files.list(ws(u), p, url.searchParams.get("hidden") === "1") });
});

route("GET", "/api/files/raw", async ({ req, url }) => {
  const u = requireUser(req);
  const f = await files.fileFor(ws(u), url.searchParams.get("path") ?? "");
  const file = Bun.file(f.path);
  const download = url.searchParams.get("download") === "1";
  return new Response(file, {
    headers: {
      "content-type": download ? "application/octet-stream" : file.type || "application/octet-stream",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(f.name)}"`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});

route("PUT", "/api/files/raw", async ({ req, url }) => {
  const u = requireUser(req);
  await files.write(ws(u), url.searchParams.get("path") ?? "", await req.blob());
  return json({ ok: true });
});

route("POST", "/api/files/upload", async ({ req, url }) => {
  const u = requireUser(req);
  const dir = url.searchParams.get("dir") ?? "/";
  const form = await req.formData();
  const saved: string[] = [];
  for (const [, value] of form) {
    if (typeof value === "string") continue;
    const rel = `${dir.replace(/\/$/, "")}/${(value as File).name}`;
    await files.write(ws(u), rel, value as Blob);
    saved.push(rel);
  }
  return json({ saved });
});

route("POST", "/api/files/mkdir", async ({ req }) => {
  const u = requireUser(req);
  await files.makeDir(ws(u), String((await body(req)).path ?? ""));
  return json({ ok: true });
});

route("POST", "/api/files/move", async ({ req }) => {
  const u = requireUser(req);
  const b = await body(req);
  await files.move(ws(u), String(b.from ?? ""), String(b.to ?? ""));
  return json({ ok: true });
});

route("DELETE", "/api/files", async ({ req, url }) => {
  const u = requireUser(req);
  await files.remove(ws(u), url.searchParams.get("path") ?? "");
  return json({ ok: true });
});

// automations
function automationView(a: any) {
  let next: number | null = null;
  try {
    next = a.enabled ? nextRun(a.cron, a.tz) : null;
  } catch {}
  return { ...a, enabled: !!a.enabled, next_run: next };
}

function validateAutomation(b: any, partial = false) {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name ?? "").trim();
    if (!name) throw new HttpError(400, "name required");
    out.name = name.slice(0, 120);
  }
  if (!partial || b.cron !== undefined) {
    try {
      parseCron(String(b.cron ?? ""));
    } catch (e) {
      throw new HttpError(400, `schedule: ${(e as Error).message}`);
    }
    out.cron = String(b.cron).trim();
  }
  if (!partial || b.tz !== undefined) {
    const tz = String(b.tz ?? "UTC");
    if (!validTz(tz)) throw new HttpError(400, "unknown time zone");
    out.tz = tz;
  }
  if (!partial || b.prompt !== undefined) {
    const prompt = String(b.prompt ?? "").trim();
    if (!prompt) throw new HttpError(400, "prompt required");
    out.prompt = prompt.slice(0, 20_000);
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.deliver !== undefined) {
    const d = String(b.deliver ?? "");
    if (d && d !== "auto" && !(CHANNELS as readonly string[]).includes(d)) throw new HttpError(400, "deliver: '', 'auto' or a channel id");
    out.deliver = d;
  }
  return out;
}

route("GET", "/api/automations", ({ req }) => json({ automations: automations.forUser(requireUser(req).id).map(automationView) }));

route("POST", "/api/automations", async ({ req }) => {
  const u = requireUser(req);
  const v = validateAutomation(await body(req));
  const row = db
    .query("INSERT INTO automations (user_id, name, cron, tz, prompt, enabled, deliver, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(u.id, v.name as string, v.cron as string, v.tz as string, v.prompt as string, (v.enabled as number) ?? 1, (v.deliver as string) ?? "", now());
  audit(u.id, "automation.create", { name: v.name });
  return json({ automation: automationView(row) });
});

route("PATCH", "/api/automations/:id", async ({ req, params }) => {
  const u = requireUser(req);
  const a = automations.get(Number(params[0]), u.id);
  if (!a) throw new HttpError(404, "automation not found");
  const v = validateAutomation(await body(req), true);
  const keys = Object.keys(v);
  if (keys.length) db.query(`UPDATE automations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(v) as any[]), a.id);
  return json({ automation: automationView(automations.get(a.id, u.id)) });
});

route("DELETE", "/api/automations/:id", ({ req, params }) => {
  const u = requireUser(req);
  db.query("DELETE FROM automations WHERE id = ? AND user_id = ?").run(Number(params[0]), u.id);
  return json({ ok: true });
});

route("POST", "/api/automations/:id/run", ({ req, params }) => {
  const u = requireUser(req);
  const a = automations.get(Number(params[0]), u.id);
  if (!a) throw new HttpError(404, "automation not found");
  void runAutomation(a);
  return json({ ok: true });
});

// The agent's handle on automations (Zo's create_automation / edit / delete).
internalRoute("GET", "/automations", ({ user }) => json({ automations: automations.forUser(user.id).map(automationView) }));
internalRoute("POST", "/automations", async ({ req, user }) => {
  const b = await body<any>(req);
  const action = String(b.action ?? "create");
  if (action === "create") {
    if (automations.forUser(user.id).length >= 50) throw new HttpError(429, "at most 50 automations");
    const v = validateAutomation(b);
    const row = db
      .query("INSERT INTO automations (user_id, name, cron, tz, prompt, enabled, deliver, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(user.id, v.name as string, v.cron as string, v.tz as string, v.prompt as string, (v.enabled as number) ?? 1, (v.deliver as string) ?? "", now());
    audit(user.id, "automation.create", { name: v.name, by: "agent" });
    return json({ automation: automationView(row) });
  }
  const a = automations.get(Number(b.id), user.id);
  if (!a) throw new HttpError(404, "automation not found");
  if (action === "delete") {
    db.query("DELETE FROM automations WHERE id = ?").run(a.id);
    return json({ ok: true });
  }
  if (action === "run") {
    void runAutomation(a);
    return json({ ok: true, started: true });
  }
  const v = validateAutomation(b, true);
  const keys = Object.keys(v);
  if (keys.length) db.query(`UPDATE automations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(v) as any[]), a.id);
  return json({ automation: automationView(automations.get(a.id, user.id)) });
});

// admin
route("GET", "/api/admin/overview", async ({ req }) => {
  requireAdmin(req);
  const rts = new Map(allRuntimes().map((r) => [r.user, r]));
  const list = await Promise.all(
    users.all().map(async (u) => ({
      ...publicUser(u),
      runtime: rts.get(u.name) ?? runtimeStatus(u.name),
      diskBytes: await files.usage(paths(u.name).workspace).catch(() => 0),
      conversations: (db.query("SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?").get(u.id) as any).n,
    })),
  );
  return json({ users: list, system: await driverCheck(), config: { driver: config.driver, signup: config.signup, idleMinutes: config.idleMinutes, maxRuntimes: config.maxRuntimes, memory: config.memory, cpus: config.cpus, defaultLane: config.defaultLane } });
});

route("POST", "/api/admin/users", async ({ req }) => {
  const admin = requireAdmin(req);
  const b = await body(req);
  const name = String(b.name ?? "").toLowerCase();
  if (!validName(name)) throw new HttpError(400, "invalid username");
  if (users.byName(name)) throw new HttpError(409, "username taken");
  const user = users.create(name, await hashPassword(validPassword(b.password)), b.role === "admin" ? "admin" : "user", b.email ?? null);
  ensureDirs(name);
  audit(admin.id, "admin.user.create", { name });
  return json({ user: publicUser(user) });
});

route("PATCH", "/api/admin/users/:id", async ({ req, params }) => {
  const admin = requireAdmin(req);
  const target = users.byId(Number(params[0]));
  if (!target) throw new HttpError(404, "user not found");
  const b = await body(req);
  const fields: Record<string, any> = {};
  if (b.role !== undefined) fields.role = b.role === "admin" ? "admin" : "user";
  if (b.disabled !== undefined) fields.disabled = b.disabled ? 1 : 0;
  if (b.password !== undefined) fields.pass = await hashPassword(validPassword(b.password));
  if (target.id === admin.id && (fields.role === "user" || fields.disabled === 1)) throw new HttpError(400, "you cannot demote or disable yourself");
  users.update(target.id, fields);
  if (fields.disabled || fields.pass) db.query("DELETE FROM sessions WHERE user_id = ?").run(target.id);
  if (fields.disabled) await stopRuntime(target.name);
  audit(admin.id, "admin.user.update", { id: target.id, ...fields, pass: fields.pass ? "changed" : undefined });
  return json({ user: publicUser(users.byId(target.id)!) });
});

route("DELETE", "/api/admin/users/:id", async ({ req, params, url }) => {
  const admin = requireAdmin(req);
  const target = users.byId(Number(params[0]));
  if (!target) throw new HttpError(404, "user not found");
  if (target.id === admin.id) throw new HttpError(400, "you cannot delete yourself");
  await stopRuntime(target.name, { remove: true });
  users.remove(target.id);
  if (url.searchParams.get("purge") === "1") rmSync(paths(target.name).root, { recursive: true, force: true });
  audit(admin.id, "admin.user.delete", { name: target.name, purge: url.searchParams.get("purge") === "1" });
  return json({ ok: true });
});

route("POST", "/api/admin/users/:id/stop", async ({ req, params }) => {
  requireAdmin(req);
  const target = users.byId(Number(params[0]));
  if (!target) throw new HttpError(404, "user not found");
  await stopRuntime(target.name);
  return json({ ok: true });
});

route("GET", "/api/admin/invites", ({ req }) => {
  requireAdmin(req);
  return json({ invites: db.query("SELECT i.*, u.name AS used_by_name FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created DESC").all() });
});

route("POST", "/api/admin/invites", async ({ req }) => {
  const admin = requireAdmin(req);
  const b = await body(req).catch(() => ({}) as any);
  const code = randomBytes(9).toString("base64url");
  const days = Number(b.days ?? 7);
  db.query("INSERT INTO invites (code, created_by, role, expires, created) VALUES (?, ?, ?, ?, ?)").run(
    code,
    admin.id,
    b.role === "admin" ? "admin" : "user",
    days > 0 ? now() + days * 86_400_000 : null,
    now(),
  );
  audit(admin.id, "admin.invite.create");
  return json({ code });
});

route("DELETE", "/api/admin/invites/:code", ({ req, params }) => {
  requireAdmin(req);
  db.query("DELETE FROM invites WHERE code = ?").run(decodeURIComponent(params[0]!));
  return json({ ok: true });
});

route("GET", "/api/admin/audit", ({ req }) => {
  requireAdmin(req);
  return json({ audit: db.query("SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300").all() });
});

// ------------------------------------------------------------------ terminal

interface TermWs {
  kind?: "terminal";
  user: User;
  proc?: ReturnType<typeof Bun.spawn>;
}
type WsData = TermWs | SiteWs;

async function openTerminal(socket: ServerWebSocket<TermWs>) {
  const { user } = socket.data;
  if (config.driver === "gvisor") await ensureRuntime(user);
  const sh = shellCommand(user.name);
  const proc = Bun.spawn(sh.cmd, {
    cwd: sh.cwd,
    env: { ...(process.env as Record<string, string>), ...sh.env },
    terminal: {
      cols: 100,
      rows: 30,
      data(_t, chunk) {
        if (socket.readyState === 1) socket.send(chunk);
      },
    },
  });
  socket.data.proc = proc;
  proc.exited.then((code) => {
    if (socket.readyState === 1) {
      socket.send(`\r\n\x1b[2m[shell exited with code ${code}]\x1b[0m\r\n`);
      socket.close(1000, "shell exited");
    }
  });
  audit(user.id, "terminal.open");
}

// ------------------------------------------------------------------ server

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: config.host,
  maxRequestBodySize: 512 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (process.env.OPENZO_DEBUG_HEADERS === "1" && url.pathname.startsWith("/api/")) {
      const cookieNames = (req.headers.get("cookie") ?? "").split(/;\s*/).map((c) => c.split("=")[0]).filter(Boolean);
      console.log(`[openzo:debug] ${req.method} ${url.pathname} host=${req.headers.get("host")} xfh=${req.headers.get("x-forwarded-host")} xfp=${req.headers.get("x-forwarded-proto")} origin=${req.headers.get("origin")} cookies=[${cookieNames.join(",")}] auth=${req.headers.has("authorization")} xos=${req.headers.has("x-openzo-session")}`);
    }
    try {
      if (isSiteRequest(req, url)) {
        const res = await handleSite(req, url, server);
        if (res !== null) return res as Response;
      }
      if (url.pathname === "/api/terminal") {
        const user = requireUser(req);
        checkOrigin(req);
        const origin = req.headers.get("origin");
        if (origin && new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))) throw new HttpError(403, "cross-origin");
        if (server.upgrade(req, { data: { user } })) return undefined as unknown as Response;
        throw new HttpError(400, "websocket upgrade expected");
      }
      if (url.pathname.startsWith("/internal/")) return await handleInternal(req);
      if (url.pathname === "/zo/ask") url.pathname = "/api/ask";
      if (url.pathname.startsWith("/eve/")) {
        const user = requireUser(req);
        checkOrigin(req);
        seen(user);
        return await proxyEve(req, user, url);
      }
      if (url.pathname.startsWith("/api/")) {
        checkOrigin(req);
        const hit = match(routes, req.method, url.pathname);
        if (hit) return await hit.fn({ req, url, params: hit.params, server });
        throw new HttpError(404, "no such endpoint");
      }
      return serveStatic(url.pathname);
    } catch (e) {
      if (e instanceof HttpError || e instanceof FileError) return json({ error: e.message }, e.status);
      console.error(`[openzo] ${req.method} ${url.pathname}:`, e);
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  },
  websocket: {
    open(socket) {
      if (socket.data.kind === "site") return siteWebsocket.open(socket as ServerWebSocket<SiteWs>);
      openTerminal(socket as ServerWebSocket<TermWs>).catch((e) => {
        socket.send(`\r\n[openzo] could not open a shell: ${String(e?.message ?? e)}\r\n`);
        socket.close(1011, "shell failed");
      });
    },
    message(socket, message) {
      if (socket.data.kind === "site") return siteWebsocket.message(socket as ServerWebSocket<SiteWs>, message);
      const proc = socket.data.proc;
      if (!proc?.terminal) return;
      if (typeof message === "string" && message.startsWith("{")) {
        try {
          const m = JSON.parse(message);
          if (m.type === "resize" && m.cols > 0 && m.rows > 0) proc.terminal.resize(Math.min(m.cols, 500), Math.min(m.rows, 200));
          else if (m.type === "input" && typeof m.data === "string") proc.terminal.write(m.data);
          return;
        } catch {}
      }
      proc.terminal.write(typeof message === "string" ? message : new Uint8Array(message));
    },
    close(socket) {
      if (socket.data.kind === "site") return siteWebsocket.close(socket as ServerWebSocket<SiteWs>);
      socket.data.proc?.kill();
    },
  },
});

// Internal listener for gVisor runtimes: bound to the openzo bridge gateway,
// the one host port containers may reach. It serves the runtime API
// (/internal/*, token-authenticated per user) and a read-only SearXNG proxy.
if (config.internalHost) {
  Bun.serve({
    hostname: config.internalHost,
    port: config.internalPort,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/internal/")) return handleInternal(req);
      if (!config.searxngUrl || req.method !== "GET" || url.pathname !== "/searxng/search") return new Response("not found", { status: 404 });
      const upstream = new URL("/search", config.searxngUrl);
      for (const k of ["q", "format", "pageno", "language", "time_range", "categories", "safesearch"]) {
        const v = url.searchParams.get(k);
        if (v) upstream.searchParams.set(k, v);
      }
      const res = await fetch(upstream, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res) return new Response("search upstream unreachable", { status: 502 });
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    },
  });
  console.log(`[openzo] internal runtime API on http://${config.internalHost}:${config.internalPort}/internal`);
}

startScheduler();
void startAllServices();
startChannels();
console.log(`[openzo] v${VERSION} listening on http://${config.host}:${server.port} — driver=${config.driver}, signup=${config.signup}, data=${process.env.OPENZO_DATA ?? "./data"}`);
if (config.driver === "gvisor" && !config.internalHost) console.warn("[openzo] WARNING: gvisor driver without OPENZO_INTERNAL_HOST — runtimes cannot reach the host, so hosting, channels, automations, integrations and browser tools will fail. Set it to the bridge gateway (deploy/openzo.env.example).");
if (users.count() === 0) console.log("[openzo] no accounts yet — open the UI to create the admin account");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`[openzo] ${sig}: stopping runtimes`);
    await shutdownBrowsers().catch(() => {});
    stopChannels();
    await stopAllServices();
    await shutdownAll();
    process.exit(0);
  });
}
