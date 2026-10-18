// Integrations: the user's own accounts at Google, GitHub, Notion, Linear,
// Spotify, Slack, Microsoft and Discord, connected with real OAuth against
// OAuth apps the ADMIN registers (env `OPENZO_OAUTH_<PROVIDER>_CLIENT_ID` /
// `_CLIENT_SECRET`, or the admin section of the Integrations page), plus plain
// API-key connections for services without OAuth.
//
// Tokens never leave the host. The agent gets two internal endpoints: one that
// lists what is connected, and one that performs an HTTP request on a
// connection's behalf — the host checks the URL against that provider's API
// host allowlist, injects the credential (refreshing it first if it has
// expired) and hands back the response. Tokens and client secrets are
// encrypted at rest under a key derived from the host secret.
//
// The OAuth dance is bound to the user twice: `state` is an HMAC-signed nonce
// whose PKCE verifier and owner are kept here, and the callback only finishes
// the connection for a request that proves it is that same user (the session
// cookie, or — when an auth proxy strips cookies — the web app POSTing
// /api/integrations/finish with its session header). A callback URL handed to
// someone else therefore cannot attach their account to your user.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { audit, db, now, type User } from "./db";
import { HttpError, body, json, originOf, requireAdmin, requireUser, route } from "./http";
import { userFrom } from "./auth";
import { internalRoute } from "./internal";
import { paths } from "./runtime";
import * as files from "./files";

// ------------------------------------------------------------------ providers

export interface Bundle {
  id: string;
  label: string;
  scopes: string[];
  default?: boolean;
}

export interface Provider {
  id: string;
  label: string;
  description: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  bundles?: Bundle[];
  scopeSeparator?: string;
  scopeParam?: string; // Slack puts user scopes in `user_scope`
  pkce: boolean;
  tokenAuth: "basic" | "body";
  extraAuthorize?: Record<string, string>;
  hosts: string[];
  allowHttp?: boolean; // test provider only
  defaultHeaders?: Record<string, string>;
  // Account label: fetched from a userinfo endpoint, or read off the token response.
  userinfo?: { url: string; method?: string; body?: unknown; headers?: Record<string, string>; pick: (d: any) => string | undefined };
  labelFromToken?: (t: any) => string | undefined;
  // Where the access token lives in the token response (Slack user tokens are nested).
  extractToken?: (t: any) => { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  docs: string; // one line for the agent
  setupUrl: string; // where an admin registers the OAuth app
}

const UA = "openzo-integrations";

const PROVIDERS: Provider[] = [
  {
    id: "google",
    label: "Google",
    description: "Gmail, Calendar, Drive, Sheets and Tasks.",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    bundles: [
      { id: "gmail", label: "Gmail", scopes: ["https://www.googleapis.com/auth/gmail.modify"], default: true },
      { id: "calendar", label: "Calendar", scopes: ["https://www.googleapis.com/auth/calendar"], default: true },
      { id: "drive", label: "Drive", scopes: ["https://www.googleapis.com/auth/drive"], default: true },
      { id: "sheets", label: "Sheets", scopes: ["https://www.googleapis.com/auth/spreadsheets"] },
      { id: "tasks", label: "Tasks", scopes: ["https://www.googleapis.com/auth/tasks"] },
    ],
    pkce: true,
    tokenAuth: "body",
    extraAuthorize: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    hosts: ["gmail.googleapis.com", "www.googleapis.com", "sheets.googleapis.com", "tasks.googleapis.com", "people.googleapis.com", "openidconnect.googleapis.com"],
    userinfo: { url: "https://openidconnect.googleapis.com/v1/userinfo", pick: (d) => d.email ?? d.name },
    docs: "Gmail https://gmail.googleapis.com/gmail/v1/users/me/{messages,threads,labels,drafts,messages/send}; Calendar https://www.googleapis.com/calendar/v3/calendars/primary/events; Drive https://www.googleapis.com/drive/v3/files (download: files/{id}?alt=media, export Docs: files/{id}/export?mimeType=text/plain); Sheets https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}; Tasks https://tasks.googleapis.com/tasks/v1/users/@me/lists",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Repositories, issues, pull requests, gists.",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user", "user:email", "gist", "workflow"],
    pkce: true,
    tokenAuth: "body",
    hosts: ["api.github.com", "uploads.github.com"],
    defaultHeaders: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    userinfo: { url: "https://api.github.com/user", headers: { accept: "application/vnd.github+json" }, pick: (d) => d.login },
    docs: "REST https://api.github.com (e.g. /user/repos, /repos/{owner}/{repo}/issues, /search/issues?q=...); GraphQL POST https://api.github.com/graphql",
    setupUrl: "https://github.com/settings/applications/new",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Pages and databases you share with the integration.",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    pkce: false,
    tokenAuth: "basic",
    extraAuthorize: { owner: "user" },
    hosts: ["api.notion.com"],
    defaultHeaders: { "notion-version": "2022-06-28" },
    labelFromToken: (t) => t.owner?.user?.person?.email ?? t.workspace_name,
    docs: "https://api.notion.com/v1 (POST /search, GET /pages/{id}, GET /blocks/{id}/children, POST /databases/{id}/query, POST /pages); the Notion-Version header is added for you",
    setupUrl: "https://www.notion.so/profile/integrations",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Issues, projects and cycles.",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    scopeSeparator: ",",
    pkce: true,
    tokenAuth: "body",
    hosts: ["api.linear.app"],
    userinfo: {
      url: "https://api.linear.app/graphql",
      method: "POST",
      body: { query: "{ viewer { email name } }" },
      pick: (d) => d.data?.viewer?.email ?? d.data?.viewer?.name,
    },
    docs: "GraphQL only: POST https://api.linear.app/graphql with {query, variables} (e.g. { viewer { assignedIssues { nodes { identifier title state { name } } } } })",
    setupUrl: "https://linear.app/settings/api/applications/new",
  },
  {
    id: "spotify",
    label: "Spotify",
    description: "Playback, playlists and library.",
    authorizeUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    scopes: [
      "user-read-email",
      "user-read-private",
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "user-read-recently-played",
      "user-top-read",
      "user-library-read",
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
    ],
    pkce: true,
    tokenAuth: "basic",
    hosts: ["api.spotify.com"],
    userinfo: { url: "https://api.spotify.com/v1/me", pick: (d) => d.email ?? d.display_name },
    docs: "https://api.spotify.com/v1 (GET /me/player/currently-playing, PUT /me/player/play, GET /me/playlists, GET /search?q=...&type=track)",
    setupUrl: "https://developer.spotify.com/dashboard",
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read and post as you in your workspace.",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history", "mpim:read", "users:read", "chat:write", "search:read"],
    scopeSeparator: ",",
    scopeParam: "user_scope",
    pkce: false,
    tokenAuth: "body",
    hosts: ["slack.com"],
    labelFromToken: (t) => [t.team?.name, t.authed_user?.id].filter(Boolean).join(" / ") || undefined,
    extractToken: (t) => ({ ...(t.authed_user ?? {}), scope: t.authed_user?.scope }),
    docs: "Web API https://slack.com/api/<method> (conversations.list, conversations.history?channel=, chat.postMessage, search.messages?query=, users.info); responses are 200 with ok:false on error",
    setupUrl: "https://api.slack.com/apps",
  },
  {
    id: "microsoft",
    label: "Microsoft",
    description: "Outlook mail and calendar, OneDrive, via Microsoft Graph.",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["openid", "email", "profile", "offline_access", "User.Read"],
    bundles: [
      { id: "mail", label: "Outlook mail", scopes: ["Mail.ReadWrite", "Mail.Send"], default: true },
      { id: "calendar", label: "Calendar", scopes: ["Calendars.ReadWrite"], default: true },
      { id: "files", label: "OneDrive", scopes: ["Files.ReadWrite.All"], default: true },
    ],
    pkce: true,
    tokenAuth: "body",
    hosts: ["graph.microsoft.com"],
    userinfo: { url: "https://graph.microsoft.com/v1.0/me", pick: (d) => d.mail ?? d.userPrincipalName },
    docs: "Graph https://graph.microsoft.com/v1.0 (/me/messages, /me/sendMail, /me/events, /me/calendarView?startDateTime=&endDateTime=, /me/drive/root/children, /me/drive/items/{id}/content)",
    setupUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
  {
    id: "discord",
    label: "Discord",
    description: "Your profile and the servers you are in (read-only).",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scopes: ["identify", "email", "guilds"],
    pkce: false,
    tokenAuth: "body",
    hosts: ["discord.com"],
    userinfo: { url: "https://discord.com/api/users/@me", pick: (d) => d.username },
    docs: "https://discord.com/api/v10 (GET /users/@me, /users/@me/guilds) — user tokens cannot post messages",
    setupUrl: "https://discord.com/developers/applications",
  },
];

// A provider pointing at a local mock, for tools/e2e-integrations.ts only.
const TEST_BASE = process.env.OPENZO_OAUTH_TEST_PROVIDER?.trim();
if (TEST_BASE && /^https?:\/\//.test(TEST_BASE)) {
  const base = TEST_BASE.replace(/\/$/, "");
  PROVIDERS.push({
    id: "testoauth",
    label: "Test OAuth",
    description: "Mock provider (OPENZO_OAUTH_TEST_PROVIDER).",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    scopes: ["base"],
    bundles: [
      { id: "alpha", label: "Alpha", scopes: ["alpha"], default: true },
      { id: "beta", label: "Beta", scopes: ["beta"] },
    ],
    pkce: true,
    tokenAuth: "basic",
    extraAuthorize: { access_type: "offline" },
    hosts: [new URL(base).host],
    allowHttp: true,
    defaultHeaders: { "x-test-default": "yes" },
    userinfo: { url: `${base}/userinfo`, pick: (d) => d.email },
    docs: `${base}/api/*`,
    setupUrl: base,
  });
}

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

function requireProvider(id: string): Provider {
  const p = providerById(id);
  if (!p) throw new HttpError(404, `unknown integration "${id}"`);
  return p;
}

// ------------------------------------------------------------------ storage

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  provider TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  updated INTEGER NOT NULL,
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'oauth',
  label TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  scopes TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  last_used INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id, provider);
`);

interface ConnRow {
  id: number;
  user_id: number;
  provider: string;
  kind: "oauth" | "apikey";
  label: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  scopes: string | null;
  meta: string;
  last_used: number | null;
  created: number;
  updated: number;
}

interface ApiKeyMeta {
  name: string;
  apiBase: string;
  placement: "header" | "query";
  header: string;
  prefix: string;
  param: string;
}

// AES-256-GCM under a key derived from the host secret. Rotating OPENZO_SECRET
// makes stored tokens unreadable: users reconnect, admins re-enter secrets.
const KEY = createHash("sha256").update(`openzo-integrations:${config.secret}`).digest();
function seal(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}
function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  if (!sealed.startsWith("v1:")) return sealed;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const envKey = (p: string, k: string) => process.env[`OPENZO_OAUTH_${p.toUpperCase()}_${k}`]?.trim() || undefined;

function clientFor(p: Provider): { id: string; secret: string | null; source: "env" | "admin" } | null {
  const envId = envKey(p.id, "CLIENT_ID");
  if (envId) return { id: envId, secret: envKey(p.id, "CLIENT_SECRET") ?? null, source: "env" };
  const row = db.query("SELECT * FROM oauth_clients WHERE provider = ?").get(p.id) as { client_id: string; client_secret: string | null } | null;
  if (!row) return null;
  return { id: row.client_id, secret: unseal(row.client_secret), source: "admin" };
}

const conns = {
  forUser: (uid: number) => db.query("SELECT * FROM connections WHERE user_id = ? ORDER BY provider, created").all(uid) as ConnRow[],
  byId: (uid: number, id: number) => db.query("SELECT * FROM connections WHERE user_id = ? AND id = ?").get(uid, id) as ConnRow | null,
};

const meta = (c: ConnRow) => {
  try {
    return JSON.parse(c.meta || "{}");
  } catch {
    return {};
  }
};

// What the UI and the agent may see about a connection — never a credential.
function publicConn(c: ConnRow) {
  const m = meta(c);
  const p = providerById(c.provider);
  return {
    id: c.id,
    provider: c.provider,
    kind: c.kind,
    label: c.label,
    scopes: c.scopes ? c.scopes.split(/[ ,]+/).filter(Boolean) : [],
    bundles: m.bundles ?? [],
    expiresAt: c.expires_at,
    refreshable: !!c.refresh_token,
    lastUsed: c.last_used,
    created: c.created,
    hosts: c.kind === "apikey" ? [new URL(m.apiBase).host] : p?.hosts ?? [],
    ...(c.kind === "apikey" ? { apiBase: m.apiBase, placement: m.placement } : {}),
  };
}

// ------------------------------------------------------------------ OAuth flow

interface Pending {
  userId: number;
  provider: string;
  verifier: string | null;
  redirectUri: string;
  scopes: string[];
  bundles: string[];
  expires: number;
  code?: string;
}
const pending = new Map<string, Pending>();
const sign = (nonce: string) => createHmac("sha256", config.secret).update(`oauth-state:${nonce}`).digest("base64url");
function readState(state: string): [string, Pending] {
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) throw new HttpError(400, "bad state");
  const want = Buffer.from(sign(nonce));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(400, "bad state signature");
  const p = pending.get(nonce);
  if (!p || p.expires < now()) {
    pending.delete(nonce);
    throw new HttpError(400, "this connect link has expired — start again");
  }
  return [nonce, p];
}
setInterval(() => {
  for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
}, 60_000).unref?.();

export const redirectUri = (req?: Request) => `${originOf(req)}/api/integrations/callback`;

function form(data: Record<string, string>) {
  return new URLSearchParams(data).toString();
}

async function tokenRequest(p: Provider, params: Record<string, string>): Promise<any> {
  const client = clientFor(p);
  if (!client) throw new HttpError(409, `${p.label} is not configured on this host`);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA };
  const data = { ...params };
  if (p.tokenAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret ?? "")}`).toString("base64")}`;
  } else {
    data.client_id = client.id;
    if (client.secret) data.client_secret = client.secret;
  }
  const res = await fetch(p.tokenUrl, { method: "POST", headers, body: form(data), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let out: any;
  try {
    out = JSON.parse(text);
  } catch {
    out = Object.fromEntries(new URLSearchParams(text)); // GitHub without Accept
  }
  if (!res.ok || out.error || out.ok === false) {
    const why = out.error_description ?? out.error ?? `HTTP ${res.status}`;
    throw new HttpError(502, `${p.label} token endpoint refused: ${why}`);
  }
  return out;
}

function tokenFields(p: Provider, t: any) {
  const x = p.extractToken ? p.extractToken(t) : t;
  if (!x?.access_token) throw new HttpError(502, `${p.label} returned no access token`);
  return {
    access: String(x.access_token),
    refresh: x.refresh_token ? String(x.refresh_token) : null,
    expiresAt: x.expires_in ? now() + Number(x.expires_in) * 1000 : null,
    scope: typeof x.scope === "string" ? x.scope : null,
  };
}

async function accountLabel(p: Provider, access: string, tok: any): Promise<string> {
  let label = p.labelFromToken?.(tok);
  if (!label && p.userinfo) {
    try {
      const u = p.userinfo;
      const res = await fetch(u.url, {
        method: u.method ?? "GET",
        headers: { authorization: `Bearer ${access}`, "user-agent": UA, accept: "application/json", ...(p.defaultHeaders ?? {}), ...(u.headers ?? {}), ...(u.body ? { "content-type": "application/json" } : {}) },
        body: u.body ? JSON.stringify(u.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) label = u.pick(await res.json());
    } catch {}
  }
  return String(label || `${p.label} account`).slice(0, 200);
}

async function completeConnect(nonce: string, pend: Pending, code: string): Promise<ConnRow> {
  pending.delete(nonce);
  const p = requireProvider(pend.provider);
  const tok = await tokenRequest(p, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pend.redirectUri,
    ...(pend.verifier ? { code_verifier: pend.verifier } : {}),
  });
  const f = tokenFields(p, tok);
  const label = await accountLabel(p, f.access, tok);
  const scopes = f.scope ?? pend.scopes.join(" ");
  const m = JSON.stringify({ bundles: pend.bundles });
  // Reconnecting the same account replaces its tokens instead of duplicating it.
  const existing = db.query("SELECT id, refresh_token FROM connections WHERE user_id = ? AND provider = ? AND label = ? AND kind = 'oauth'").get(pend.userId, p.id, label) as
    | { id: number; refresh_token: string | null }
    | null;
  let id: number;
  if (existing) {
    db.query("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ?, scopes = ?, meta = ?, updated = ? WHERE id = ?").run(
      seal(f.access),
      f.refresh ? seal(f.refresh) : existing.refresh_token,
      f.expiresAt,
      scopes,
      m,
      now(),
      existing.id,
    );
    id = existing.id;
  } else {
    const r = db
      .query("INSERT INTO connections (user_id, provider, kind, label, access_token, refresh_token, expires_at, scopes, meta, created, updated) VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(pend.userId, p.id, label, seal(f.access), seal(f.refresh), f.expiresAt, scopes, m, now(), now());
    id = Number(r.lastInsertRowid);
  }
  audit(pend.userId, "integration.connect", { provider: p.id, label });
  return conns.byId(pend.userId, id)!;
}

// Refresh in flight per connection, so parallel tool calls share one exchange.
const refreshing = new Map<number, Promise<ConnRow>>();
async function refresh(c: ConnRow): Promise<ConnRow> {
  const inflight = refreshing.get(c.id);
  if (inflight) return inflight;
  const run = (async () => {
    const p = requireProvider(c.provider);
    const rt = unseal(c.refresh_token);
    if (!rt) throw new HttpError(401, `the ${p.label} connection "${c.label}" has expired and cannot refresh — reconnect it on the Integrations page`);
    const tok = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: rt });
    const f = tokenFields(p, tok);
    db.query("UPDATE connections SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated = ? WHERE id = ?").run(
      seal(f.access),
      f.refresh ? seal(f.refresh) : null,
      f.expiresAt,
      now(),
      c.id,
    );
    return conns.byId(c.user_id, c.id)!;
  })();
  refreshing.set(c.id, run);
  try {
    return await run;
  } finally {
    refreshing.delete(c.id);
  }
}

async function fresh(c: ConnRow): Promise<ConnRow> {
  if (c.kind === "oauth" && c.expires_at && c.expires_at - 60_000 < now()) return refresh(c);
  return c;
}

// ------------------------------------------------------------------ public API

route("GET", "/api/integrations", ({ req }) => {
  const user = requireUser(req);
  const isAdmin = user.role === "admin";
  const mine = conns.forUser(user.id);
  return json({
    redirectUri: redirectUri(req),
    providers: PROVIDERS.map((p) => {
      const client = clientFor(p);
      return {
        id: p.id,
        label: p.label,
        description: p.description,
        configured: !!client,
        bundles: (p.bundles ?? []).map((b) => ({ id: b.id, label: b.label, default: !!b.default })),
        hosts: p.hosts,
        setupUrl: p.setupUrl,
        ...(isAdmin
          ? { client: client ? { source: client.source, clientId: client.id, hasSecret: !!client.secret } : null, envPrefix: `OPENZO_OAUTH_${p.id.toUpperCase()}_` }
          : {}),
      };
    }),
    connections: mine.map(publicConn),
  });
});

route("POST", "/api/integrations/:provider/connect", async ({ req, params }) => {
  const user = requireUser(req);
  const p = requireProvider(params[0]!);
  const client = clientFor(p);
  if (!client) throw new HttpError(409, `${p.label} is not configured — an admin must register an OAuth app first`);
  const b = await req.json().catch(() => ({})) as { bundles?: string[] };
  const chosen = (p.bundles ?? []).filter((x) => (Array.isArray(b.bundles) ? b.bundles.includes(x.id) : x.default));
  if (p.bundles?.length && !chosen.length) throw new HttpError(400, "pick at least one permission set");
  const scopes = [...new Set([...p.scopes, ...chosen.flatMap((x) => x.scopes)])];
  const nonce = randomBytes(18).toString("base64url");
  const verifier = p.pkce ? randomBytes(32).toString("base64url") : null;
  const ru = redirectUri(req);
  pending.set(nonce, { userId: user.id, provider: p.id, verifier, redirectUri: ru, scopes, bundles: chosen.map((x) => x.id), expires: now() + 10 * 60_000 });
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("client_id", client.id);
  u.searchParams.set("redirect_uri", ru);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", `${nonce}.${sign(nonce)}`);
  if (scopes.length) u.searchParams.set(p.scopeParam ?? "scope", scopes.join(p.scopeSeparator ?? " "));
  if (verifier) {
    u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    u.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(p.extraAuthorize ?? {})) u.searchParams.set(k, v);
  return json({ url: u.toString() });
});

// The provider sends the browser here. No session header can ride a top-level
// redirect, so the user is proven by the cookie when it survives, or by the web
// app finishing the connection itself.
route("GET", "/api/integrations/callback", async ({ req, url }) => {
  const back = (q: Record<string, string>) => new Response(null, { status: 302, headers: { location: `/integrations?${new URLSearchParams(q)}`, "cache-control": "no-store" } });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  let nonce: string, pend: Pending;
  try {
    [nonce, pend] = readState(state);
  } catch (e) {
    return back({ error: (e as Error).message });
  }
  if (err || !code) {
    pending.delete(nonce);
    return back({ error: url.searchParams.get("error_description") ?? err ?? "no authorization code returned" });
  }
  const who = userFrom(req);
  if (who && who.id === pend.userId) {
    try {
      const c = await completeConnect(nonce, pend, code);
      return back({ connected: c.provider });
    } catch (e) {
      return back({ error: (e as Error).message });
    }
  }
  pend.code = code;
  return back({ finish: state });
});

route("POST", "/api/integrations/finish", async ({ req }) => {
  const user = requireUser(req);
  const { state } = await body<{ state: string }>(req);
  const [nonce, pend] = readState(String(state ?? ""));
  if (pend.userId !== user.id) {
    pending.delete(nonce);
    throw new HttpError(403, "this connection was started by a different user");
  }
  if (!pend.code) throw new HttpError(400, "authorization has not completed yet");
  const c = await completeConnect(nonce, pend, pend.code);
  return json({ connection: publicConn(c) });
});

route("DELETE", "/api/integrations/connections/:id", ({ req, params }) => {
  const user = requireUser(req);
  const c = conns.byId(user.id, Number(params[0]));
  if (!c) throw new HttpError(404, "no such connection");
  db.query("DELETE FROM connections WHERE id = ?").run(c.id);
  audit(user.id, "integration.disconnect", { provider: c.provider, label: c.label });
  return json({ ok: true });
});

// API-key connections: any HTTPS API that takes a static key in a header or
// query parameter. The key is bound to the host of apiBase.
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
route("POST", "/api/integrations/apikey", async ({ req }) => {
  const user = requireUser(req);
  const b = await body<Partial<ApiKeyMeta> & { key?: string }>(req);
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "give the connection a name");
  let base: URL;
  try {
    base = new URL(String(b.apiBase ?? ""));
  } catch {
    throw new HttpError(400, "API base must be a URL like https://api.example.com");
  }
  if (base.protocol !== "https:") throw new HttpError(400, "API base must be https");
  const key = String(b.key ?? "").trim();
  if (!key) throw new HttpError(400, "paste the API key");
  const placement = b.placement === "query" ? "query" : "header";
  const header = String(b.header || "Authorization").trim();
  const param = String(b.param || "api_key").trim();
  if (placement === "header" && !HEADER_RE.test(header)) throw new HttpError(400, "invalid header name");
  if (placement === "query" && !HEADER_RE.test(param.replace(/_/g, "-"))) throw new HttpError(400, "invalid query parameter name");
  const prefix = b.prefix === undefined ? (header.toLowerCase() === "authorization" ? "Bearer " : "") : String(b.prefix).slice(0, 40);
  const m: ApiKeyMeta = { name, apiBase: base.origin + base.pathname.replace(/\/$/, ""), placement, header, prefix, param };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api";
  const r = db
    .query("INSERT INTO connections (user_id, provider, kind, label, access_token, meta, created, updated) VALUES (?, ?, 'apikey', ?, ?, ?, ?, ?)")
    .run(user.id, `key:${slug}`, name, seal(key), JSON.stringify(m), now(), now());
  audit(user.id, "integration.apikey", { name, host: base.host });
  return json({ connection: publicConn(conns.byId(user.id, Number(r.lastInsertRowid))!) });
});

// Admin: OAuth client credentials per provider. Env vars win over these.
route("PUT", "/api/integrations/:provider/client", async ({ req, params }) => {
  const admin = requireAdmin(req);
  const p = requireProvider(params[0]!);
  if (envKey(p.id, "CLIENT_ID")) throw new HttpError(409, `${p.label} is configured by environment variables on this host`);
  const b = await body<{ clientId?: string; clientSecret?: string }>(req);
  const id = String(b.clientId ?? "").trim();
  if (!id) throw new HttpError(400, "client id is required");
  const prev = db.query("SELECT client_secret FROM oauth_clients WHERE provider = ?").get(p.id) as { client_secret: string | null } | null;
  const secret = b.clientSecret ? seal(String(b.clientSecret).trim()) : prev?.client_secret ?? null;
  db.query(
    "INSERT INTO oauth_clients (provider, client_id, client_secret, updated, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret, updated = excluded.updated, updated_by = excluded.updated_by",
  ).run(p.id, id, secret, now(), admin.id);
  audit(admin.id, "integration.client", { provider: p.id });
  return json({ ok: true, client: { source: "admin", clientId: id, hasSecret: !!secret } });
});

route("DELETE", "/api/integrations/:provider/client", ({ req, params }) => {
  const admin = requireAdmin(req);
  const p = requireProvider(params[0]!);
  db.query("DELETE FROM oauth_clients WHERE provider = ?").run(p.id);
  audit(admin.id, "integration.client.remove", { provider: p.id });
  return json({ ok: true });
});

// ------------------------------------------------------------------ agent API

internalRoute("GET", "/integrations", ({ user }) =>
  json({
    connections: conns.forUser(user.id).map((c) => {
      const pc = publicConn(c);
      const p = providerById(c.provider);
      return {
        id: pc.id,
        provider: pc.provider,
        kind: pc.kind,
        label: pc.label,
        scopes: pc.scopes,
        hosts: pc.hosts,
        ...(c.kind === "apikey" ? { apiBase: pc.apiBase } : { api: p?.docs }),
      };
    }),
    available: PROVIDERS.filter((p) => clientFor(p)).map((p) => p.id),
  }),
);

function pickConnection(user: User, sel: unknown): ConnRow {
  const all = conns.forUser(user.id);
  if (!all.length) throw new HttpError(404, "no integrations are connected — the user can connect accounts on the Integrations page");
  if (typeof sel === "number" || (typeof sel === "string" && /^\d+$/.test(sel))) {
    const c = all.find((x) => x.id === Number(sel));
    if (!c) throw new HttpError(404, `no connection with id ${sel}`);
    return c;
  }
  const s = String(sel ?? "").trim().toLowerCase();
  const hits = all.filter((x) => x.provider.toLowerCase() === s || x.label.toLowerCase() === s || x.provider.toLowerCase() === `key:${s}`);
  if (hits.length === 1) return hits[0]!;
  const list = all.map((x) => `${x.id} (${x.provider}: ${x.label})`).join(", ");
  if (!hits.length) throw new HttpError(404, `no connection matches "${sel}" — connected: ${list}`);
  throw new HttpError(409, `"${sel}" matches several accounts; pass the numeric id instead: ${hits.map((x) => `${x.id} (${x.label})`).join(", ")}`);
}

const MAX_BODY = 2 * 1024 * 1024;
const MAX_SAVE = 100 * 1024 * 1024;
const PASS_HEADERS = ["content-type", "content-length", "content-disposition", "etag", "last-modified", "link", "location", "retry-after", "x-next-page", "x-total-count"];
const STRIP_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization", "content-length", "connection", "transfer-encoding"]);

async function readCapped(res: Response, cap: number): Promise<{ buf: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: new Uint8Array(new ArrayBuffer(0)), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      size = cap;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const buf = new Uint8Array(new ArrayBuffer(size));
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { buf, truncated };
}

const textual = (ct: string) => /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|[a-z.+-]*\+(json|xml)))/i.test(ct) || ct === "";

interface CallInput {
  connection: string | number;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  save_to?: string;
}

internalRoute("POST", "/integrations/request", async ({ req, user }) => {
  const input = await body<CallInput>(req);
  let c = pickConnection(user, input.connection);
  const p = c.kind === "oauth" ? requireProvider(c.provider) : null;
  const m = meta(c) as ApiKeyMeta;
  const hosts = c.kind === "apikey" ? [new URL(m.apiBase).host] : p!.hosts;

  let target: URL;
  try {
    target = new URL(String(input.url));
  } catch {
    throw new HttpError(400, "url must be an absolute URL");
  }
  if (target.protocol !== "https:" && !(p?.allowHttp && target.protocol === "http:")) throw new HttpError(400, "only https URLs are allowed");
  if (target.username || target.password) throw new HttpError(400, "credentials in the URL are not allowed");
  if (!hosts.includes(target.host)) throw new HttpError(403, `${target.host} is not an API host for this connection (allowed: ${hosts.join(", ")})`);
  for (const [k, v] of Object.entries(input.query ?? {})) target.searchParams.set(k, String(v));

  const method = String(input.method ?? "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw new HttpError(400, `method ${method} not allowed`);
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json", ...(p?.defaultHeaders ?? {}) };
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.has(lk) || (c.kind === "apikey" && lk === m.header.toLowerCase())) continue;
    headers[lk] = String(v);
  }
  let payload: string | undefined;
  if (input.body !== undefined && input.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof input.body === "string") payload = input.body;
    else {
      payload = JSON.stringify(input.body);
      headers["content-type"] ??= "application/json";
    }
  }

  const send = async (conn: ConnRow, url: URL, withAuth: boolean) => {
    const h = { ...headers };
    const u = new URL(url);
    if (withAuth) {
      const secret = unseal(conn.access_token);
      if (!secret) throw new HttpError(500, "stored credential is unreadable (host secret changed?) — reconnect this account");
      if (conn.kind === "apikey") {
        if (m.placement === "query") u.searchParams.set(m.param, secret);
        else h[m.header.toLowerCase()] = `${m.prefix}${secret}`;
      } else h.authorization = `Bearer ${secret}`;
    }
    return fetch(u, { method, headers: h, body: payload, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  };

  c = await fresh(c);
  let res = await send(c, target, true);
  if (res.status === 401 && c.kind === "oauth" && c.refresh_token) {
    c = await refresh(c);
    res = await send(c, target, true);
  }
  // Follow redirects ourselves: credentials only go to allowlisted hosts.
  let url = target;
  for (let hops = 0; hops < 4 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hops++) {
    url = new URL(res.headers.get("location")!, url);
    if (url.protocol !== "https:" && !(p?.allowHttp && url.protocol === "http:")) break;
    res = await send(c, url, hosts.includes(url.host));
  }
  db.query("UPDATE connections SET last_used = ? WHERE id = ?").run(now(), c.id);

  const outHeaders: Record<string, string> = {};
  for (const k of PASS_HEADERS) {
    const v = res.headers.get(k);
    if (v) outHeaders[k] = v;
  }
  for (const [k, v] of res.headers) if (k.startsWith("x-ratelimit")) outHeaders[k] = v;
  const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const base = { status: res.status, ok: res.ok, url: url.toString().replace(/([?&](?:key|api_key|appid|token|access_token)=)[^&]+/gi, "$1***"), headers: outHeaders };

  if (input.save_to) {
    const rel = String(input.save_to).replace(/^\/workspace(?=\/|$)/, "") || "/";
    const { buf, truncated } = await readCapped(res, MAX_SAVE);
    if (truncated) throw new HttpError(413, `response is larger than ${MAX_SAVE / 1024 / 1024} MB`);
    if (!res.ok) return json({ ...base, body: new TextDecoder().decode(buf.subarray(0, 4000)) });
    try {
      await files.write(paths(user.name).workspace, rel, new Blob([buf]));
    } catch (e) {
      if (e instanceof files.FileError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return json({ ...base, saved: `/workspace${rel.startsWith("/") ? rel : `/${rel}`}`, bytes: buf.byteLength });
  }

  const { buf, truncated } = await readCapped(res, MAX_BODY);
  if (textual(ct)) {
    const text = new TextDecoder().decode(buf);
    let parsed: unknown = text;
    if (!truncated && (ct.includes("json") || /^[\[{]/.test(text.trim()))) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
    return json({ ...base, body: parsed, ...(truncated ? { truncated: true, note: "body cut at 2 MB — use save_to to download in full" } : {}) });
  }
  return json({
    ...base,
    bodyBase64: Buffer.from(buf).toString("base64"),
    bytes: buf.byteLength,
    ...(truncated ? { truncated: true } : {}),
    note: "binary response; pass save_to to write it into the workspace instead",
  });
});

export const integrationProviders = () => PROVIDERS;
