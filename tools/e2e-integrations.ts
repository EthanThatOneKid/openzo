// End-to-end check of integrations: boots a host on a throwaway data dir plus
// a mock OAuth provider (authorize/token/userinfo/API) and drives the whole
// flow — admin client config, connect with PKCE, callback, finish, the agent's
// internal request lane (allowlist, token injection, refresh), API-key
// connections, and that no credential ever leaves the host.
//
//   bun tools/e2e-integrations.ts [--keep]
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "openzo-e2e-int-"));
const SECRET = "e2e-integrations-secret";
const CLIENT_ID = "mock-client";
const CLIENT_SECRET = "mock-secret-XYZ";

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ------------------------------------------------------------ mock provider
const codes = new Map<string, { challenge: string; redirect: string; scope: string; email: string }>();
const valid = new Set<string>();
const refreshTokens = new Map<string, string>(); // refresh → email
const emails = new Map<string, string>(); // access → email
const seen: { path: string; host: string; auth: string | null; headers: Record<string, string>; query: string; body: string }[] = [];
let tokenCalls: { grant: string; basic: string | null }[] = [];
let n = 0;

const mock = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== CLIENT_ID) return new Response("bad client", { status: 400 });
      const code = `code-${++n}`;
      codes.set(code, { challenge: q.get("code_challenge") ?? "", redirect: q.get("redirect_uri")!, scope: q.get("scope") ?? "", email: q.get("login_hint") ?? "tester@example.com" });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (url.pathname === "/token") {
      const f = new URLSearchParams(await req.text());
      tokenCalls.push({ grant: f.get("grant_type")!, basic: auth });
      if (auth !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`) return Response.json({ error: "invalid_client" }, { status: 401 });
      let email: string;
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code")!);
        codes.delete(f.get("code")!);
        if (!c) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (c.redirect !== f.get("redirect_uri")) return Response.json({ error: "redirect_uri mismatch" }, { status: 400 });
        const ch = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (ch !== c.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE failed" }, { status: 400 });
        email = c.email;
      } else if (f.get("grant_type") === "refresh_token") {
        const e = refreshTokens.get(f.get("refresh_token")!);
        if (!e) return Response.json({ error: "invalid_grant" }, { status: 400 });
        email = e;
      } else return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      const at = `at-${++n}`;
      const rt = `rt-${n}`;
      valid.add(at);
      emails.set(at, email);
      refreshTokens.set(rt, email);
      return Response.json({ access_token: at, refresh_token: rt, expires_in: 3600, token_type: "Bearer", scope: "base alpha" });
    }
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (url.pathname === "/userinfo") {
      if (!bearer || !valid.has(bearer)) return new Response("no", { status: 401 });
      return Response.json({ email: emails.get(bearer) });
    }
    if (url.pathname.startsWith("/api/")) {
      seen.push({ path: url.pathname, host: url.host, auth, headers: Object.fromEntries(req.headers), query: url.search, body: await req.text() });
      if (url.pathname === "/api/elsewhere") return Response.json({ host: url.host, auth });
      if (!bearer || !valid.has(bearer)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/echo") return Response.json({ token: bearer, method: req.method, query: url.search, body: seen.at(-1)!.body, dflt: req.headers.get("x-test-default") });
      if (url.pathname === "/api/bounce") return new Response(null, { status: 302, headers: { location: `http://localhost:${mock.port}/api/elsewhere` } });
      if (url.pathname === "/api/file") return new Response(new Uint8Array([0, 1, 2, 3, 250, 251]), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/api/big") return new Response("x".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const MOCK = `http://127.0.0.1:${mock.port}`;

// ------------------------------------------------------------ host
const host = Bun.spawn(["bun", join(ROOT, "host/server.ts")], {
  env: {
    ...process.env,
    OPENZO_DATA: DATA,
    OPENZO_PORT: String(PORT),
    OPENZO_DEFAULT_LANE: "mock",
    OPENZO_SIGNUP: "invite",
    OPENZO_PORT_BASE: String(PORT + 100),
    OPENZO_SECRET: SECRET,
    OPENZO_OAUTH_TEST_PROVIDER: MOCK,
  },
  stdout: "pipe",
  stderr: "pipe",
});

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(path.startsWith("http") ? path : BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, location: res.headers.get("location") };
  }
}

const runtimeHeader = (name: string) => `${name}.${createHmac("sha256", SECRET).update(`runtime:${name}`).digest("base64url")}`;
async function internal(name: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/internal${path}`, {
    method,
    headers: { "x-openzo-runtime": runtimeHeader(name), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// Drive the provider's consent screen: authorize → callback (with or without the user's cookie).
async function authorize(c: Client | null, authUrl: string, extra = "") {
  const a = await fetch(authUrl + extra, { redirect: "manual" });
  const cb = a.headers.get("location")!;
  const r = await (c ?? new Client()).req("GET", cb);
  return { callbackUrl: cb, ...r };
}

try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(200);
  }
  console.log(`openzo integrations e2e — host ${BASE}, mock ${MOCK}, data ${DATA}`);

  const admin = new Client();
  check("admin created", (await admin.req("POST", "/api/setup", { name: "boss", password: "correct-horse-1" })).status === 200);
  const inv = await admin.req("POST", "/api/admin/invites", { days: 1 });
  const alice = new Client();
  check("alice signed up", (await alice.req("POST", "/api/signup", { name: "alice", password: "correct-horse-4", invite: inv.json.code })).status === 200);

  // Catalogue.
  let cat = await admin.req("GET", "/api/integrations");
  check("catalogue lists real providers", ["google", "github", "notion", "linear", "spotify", "slack", "microsoft", "discord"].every((id) => cat.json.providers.some((p: any) => p.id === id)), cat.text.slice(0, 200));
  const tp = () => cat.json.providers.find((p: any) => p.id === "testoauth");
  check("test provider present under env", !!tp());
  check("unconfigured provider reported as such", tp()?.configured === false);
  check("redirect URI is origin + /api/integrations/callback", cat.json.redirectUri === `${BASE}/api/integrations/callback`, cat.json.redirectUri);
  check("connect refused while unconfigured", (await admin.req("POST", "/api/integrations/testoauth/connect", {})).status === 409);

  // Admin config.
  check("non-admin cannot set OAuth client", (await alice.req("PUT", "/api/integrations/testoauth/client", { clientId: "x", clientSecret: "y" })).status === 403);
  const setc = await admin.req("PUT", "/api/integrations/testoauth/client", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  check("admin sets OAuth client", setc.status === 200 && setc.json.client.hasSecret === true, setc.text);
  check("client secret never echoed", !setc.text.includes(CLIENT_SECRET));
  cat = await admin.req("GET", "/api/integrations");
  check("provider now configured", tp()?.configured === true && tp()?.client?.clientId === CLIENT_ID);
  check("catalogue never contains client secret", !cat.text.includes(CLIENT_SECRET));
  const aliceCat = await alice.req("GET", "/api/integrations");
  check("non-admin sees no client details", !aliceCat.text.includes(CLIENT_ID) && aliceCat.json.providers.find((p: any) => p.id === "testoauth").configured === true);
  const db = new Database(join(DATA, "openzo.db"));
  const storedSecret = (db.query("SELECT client_secret FROM oauth_clients WHERE provider='testoauth'").get() as any)?.client_secret as string;
  check("client secret encrypted at rest", storedSecret?.startsWith("v1:") && !storedSecret.includes(CLIENT_SECRET));
  check("re-save without secret keeps it", (await admin.req("PUT", "/api/integrations/testoauth/client", { clientId: CLIENT_ID })).json?.client?.hasSecret === true);

  // Connect with PKCE + state.
  const con = await admin.req("POST", "/api/integrations/testoauth/connect", {});
  const au = new URL(con.json.url);
  check("authorize URL points at provider", au.origin === MOCK && au.pathname === "/authorize", con.json.url);
  check("authorize URL carries signed state", /^[\w-]+\.[\w-]+$/.test(au.searchParams.get("state") ?? ""));
  check("authorize URL carries S256 PKCE challenge", au.searchParams.get("code_challenge_method") === "S256" && (au.searchParams.get("code_challenge") ?? "").length >= 43);
  check("authorize URL carries default bundle scopes", au.searchParams.get("scope") === "base alpha", au.searchParams.get("scope") ?? "");
  check("authorize URL carries extra params", au.searchParams.get("access_type") === "offline");
  check("authorize URL redirect_uri", au.searchParams.get("redirect_uri") === `${BASE}/api/integrations/callback`);
  const con2 = await admin.req("POST", "/api/integrations/testoauth/connect", { bundles: ["alpha", "beta"] });
  check("chosen bundles widen scopes", new URL(con2.json.url).searchParams.get("scope") === "base alpha beta");
  check("empty bundle choice refused", (await admin.req("POST", "/api/integrations/testoauth/connect", { bundles: [] })).status === 400);

  const cb = await authorize(admin, con.json.url);
  check("callback with session finishes and redirects", cb.status === 302 && cb.location === "/integrations?connected=testoauth", `${cb.status} ${cb.location}`);
  check("token exchange used Basic client auth", tokenCalls.at(-1)?.grant === "authorization_code" && tokenCalls.at(-1)?.basic?.startsWith("Basic "));
  let list = await admin.req("GET", "/api/integrations");
  const conn1 = list.json.connections.find((c: any) => c.provider === "testoauth");
  check("connection stored with userinfo label", conn1?.label === "tester@example.com" && conn1?.refreshable === true, JSON.stringify(list.json.connections));
  check("connection scopes recorded", conn1?.scopes.join(" ") === "base alpha");
  check("tokens never in /api/integrations", !/\bat-\d+|\brt-\d+/.test(list.text));
  const row = db.query("SELECT access_token, refresh_token FROM connections WHERE id = ?").get(conn1.id) as any;
  check("tokens encrypted at rest", row.access_token.startsWith("v1:") && row.refresh_token.startsWith("v1:"));
  check("state is single-use", (await new Client().req("GET", cb.callbackUrl)).location?.includes("error=") === true);
  check("tampered state refused", (await new Client().req("GET", `/api/integrations/callback?code=x&state=${encodeURIComponent(au.searchParams.get("state")!.replace(/.$/, "A"))}`)).location?.includes("error=") === true);
  check("provider error returned to page", (await new Client().req("GET", `/api/integrations/callback?error=access_denied&state=${encodeURIComponent(new URL((await admin.req("POST", "/api/integrations/testoauth/connect", {})).json.url).searchParams.get("state")!)}`)).location?.includes("error=access_denied") === true);

  // Cookie-less callback (auth proxy strips cookies): web app finishes with its session.
  const con3 = await admin.req("POST", "/api/integrations/testoauth/connect", {});
  const cb3 = await authorize(null, con3.json.url, "&login_hint=second@example.com");
  const finishState = new URLSearchParams(cb3.location!.split("?")[1]).get("finish");
  check("cookie-less callback defers to finish", cb3.status === 302 && !!finishState, cb3.location ?? "");
  check("another user cannot finish it", (await alice.req("POST", "/api/integrations/finish", { state: finishState })).status === 403);
  check("refused finish is burnt", (await admin.req("POST", "/api/integrations/finish", { state: finishState })).status === 400);
  const con4 = await admin.req("POST", "/api/integrations/testoauth/connect", {});
  const cb4 = await authorize(null, con4.json.url, "&login_hint=second@example.com");
  const fin = await admin.req("POST", "/api/integrations/finish", { state: new URLSearchParams(cb4.location!.split("?")[1]).get("finish") });
  check("owner finishes connection", fin.status === 200 && fin.json.connection.label === "second@example.com", fin.text);
  list = await admin.req("GET", "/api/integrations");
  check("multiple accounts per provider", list.json.connections.filter((c: any) => c.provider === "testoauth").length === 2);
  const reconnect = await admin.req("POST", "/api/integrations/testoauth/connect", {});
  await authorize(admin, reconnect.json.url);
  list = await admin.req("GET", "/api/integrations");
  check("reconnecting same account replaces, not duplicates", list.json.connections.filter((c: any) => c.provider === "testoauth").length === 2);
  check("alice sees none of boss's connections", (await alice.req("GET", "/api/integrations")).json.connections.length === 0);

  // Agent lane.
  check("internal API refuses bad runtime token", (await fetch(`${BASE}/internal/integrations`, { headers: { "x-openzo-runtime": "boss.nope" } })).status === 401);
  const il = await internal("boss", "GET", "/integrations");
  check("agent lists connections with hosts", il.status === 200 && il.json.connections.length === 2 && il.json.connections[0].hosts.includes(`127.0.0.1:${mock.port}`), il.text);
  check("agent listing has no tokens", !/\bat-\d+|\brt-\d+|v1:/.test(il.text));
  const ambiguous = await internal("boss", "POST", "/integrations/request", { connection: "testoauth", url: `${MOCK}/api/echo` });
  check("ambiguous provider asks for id", ambiguous.status === 409, ambiguous.text);
  const id1 = conn1.id;
  const echo = await internal("boss", "POST", "/integrations/request", { connection: id1, method: "POST", url: `${MOCK}/api/echo`, query: { a: 1 }, body: { hi: "there" }, headers: { Authorization: "Bearer evil", "x-extra": "1" } });
  const lastSeen = seen.at(-1)!;
  check("request reaches the API", echo.status === 200 && echo.json.status === 200, echo.text);
  check("bearer token injected (agent's Authorization ignored)", /^Bearer at-\d+$/.test(lastSeen.auth ?? "") && lastSeen.auth !== "Bearer evil");
  check("provider default header added", echo.json.body?.dflt === "yes");
  check("query + JSON body forwarded", echo.json.body?.query === "?a=1" && echo.json.body?.body === '{"hi":"there"}');
  check("label selects connection", (await internal("boss", "POST", "/integrations/request", { connection: "second@example.com", url: `${MOCK}/api/echo` })).json?.status === 200);
  const blocked = await internal("boss", "POST", "/integrations/request", { connection: id1, url: "https://example.com/steal" });
  check("non-allowlisted host blocked", blocked.status === 403, blocked.text);
  check("other-host-same-port blocked", (await internal("boss", "POST", "/integrations/request", { connection: id1, url: `http://localhost:${mock.port}/api/echo` })).status === 403);
  const nBefore = seen.length;
  const bounce = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/bounce` });
  check("redirect off-allowlist followed without credentials", bounce.json?.body?.host === `localhost:${mock.port}` && bounce.json?.body?.auth === null && seen.length === nBefore + 2, bounce.text);
  check("alice cannot use boss's connection", (await internal("alice", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/echo` })).status === 404);
  const bin = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/file` });
  check("binary returned as base64", bin.json?.bodyBase64 === Buffer.from([0, 1, 2, 3, 250, 251]).toString("base64"));
  const saved = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/file`, save_to: "/workspace/dl/file.bin" });
  const savedPath = join(DATA, "users/boss/workspace/dl/file.bin");
  check("save_to writes into the workspace", saved.json?.saved === "/workspace/dl/file.bin" && existsSync(savedPath) && readFileSync(savedPath).length === 6, saved.text);
  check("save_to cannot escape workspace", (await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/file`, save_to: "/workspace/../../escape.bin" })).status >= 400);
  const big = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/big` });
  check("large body capped at 2 MB", big.json?.truncated === true && big.json.body.length === 2 * 1024 * 1024);

  // Refresh: expire the token, call again.
  const before = (seen.findLast((s) => s.path === "/api/echo")!.auth ?? "").slice(7);
  db.query("UPDATE connections SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id1);
  const refreshesBefore = tokenCalls.filter((t) => t.grant === "refresh_token").length;
  const r2 = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/echo` });
  const after = (seen.at(-1)!.auth ?? "").slice(7);
  check("expired token refreshed before the call", r2.json?.status === 200 && after !== before && tokenCalls.filter((t) => t.grant === "refresh_token").length === refreshesBefore + 1, `${before} → ${after}`);
  const exp = (db.query("SELECT expires_at FROM connections WHERE id = ?").get(id1) as any).expires_at;
  check("new expiry stored", exp > Date.now() + 3000_000);
  // Revoked token (provider 401) triggers refresh + retry.
  valid.delete(after);
  const r3 = await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/echo` });
  check("401 triggers refresh and retry", r3.json?.status === 200 && (seen.at(-1)!.auth ?? "").slice(7) !== after, r3.text);

  // API-key connections.
  check("API key needs https base", (await alice.req("POST", "/api/integrations/apikey", { name: "Weather", apiBase: "http://api.openweathermap.org", key: "k" })).status === 400);
  const ak = await alice.req("POST", "/api/integrations/apikey", { name: "OpenWeather", apiBase: "https://api.openweathermap.org", placement: "query", param: "appid", key: "owm-secret-key-123" });
  check("API-key connection created", ak.status === 200 && ak.json.connection.provider === "key:openweather" && ak.json.connection.hosts[0] === "api.openweathermap.org", ak.text);
  const aliceList = await alice.req("GET", "/api/integrations");
  check("API key never returned", !aliceList.text.includes("owm-secret-key-123") && !ak.text.includes("owm-secret-key-123"));
  const ail = await internal("alice", "GET", "/integrations");
  check("agent sees API-key connection without key", ail.json.connections[0]?.apiBase === "https://api.openweathermap.org" && !ail.text.includes("owm-secret"));
  check("API-key host allowlist enforced", (await internal("alice", "POST", "/integrations/request", { connection: "openweather", url: "https://evil.example/x" })).status === 403);

  // Disconnect.
  check("cannot delete another user's connection", (await alice.req("DELETE", `/api/integrations/connections/${id1}`)).status === 404);
  check("disconnect", (await admin.req("DELETE", `/api/integrations/connections/${id1}`)).status === 200);
  check("disconnected connection unusable", (await internal("boss", "POST", "/integrations/request", { connection: id1, url: `${MOCK}/api/echo` })).status === 404);

  const features = await admin.req("GET", "/api/features");
  check("features entry no longer a stub", features.json.features.find((f: any) => f.id === "integrations")?.status !== "stub");
} catch (e) {
  fail++;
  console.log(`  FAIL harness threw: ${(e as Error).stack}`);
} finally {
  host.kill();
  mock.stop(true);
  await host.exited;
  if (fail) {
    const err = await new Response(host.stderr).text();
    if (err.trim()) console.log(`--- host stderr ---\n${err.slice(-3000)}`);
  }
  if (!KEEP) rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
