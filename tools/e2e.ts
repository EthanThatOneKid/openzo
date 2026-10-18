// End-to-end check of a live openzo host. Boots its own host on a throwaway
// data dir (process driver, mock model lane), then drives the public API like
// the web app does. `--real` additionally runs one turn on the keyless free
// lane (needs internet).
//
//   bun tools/e2e.ts [--real] [--keep] [--gvisor-fake]
//
// --gvisor-fake runs the gvisor driver against tools/fake-docker.sh, which
// records every docker invocation and runs "containers" as local processes:
// it proves the driver's control flow and argv, not gVisor's isolation.
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REAL = process.argv.includes("--real");
const KEEP = process.argv.includes("--keep");
const FAKE_GVISOR = process.argv.includes("--gvisor-fake");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "openzo-e2e-"));
const FAKE_STATE = join(DATA, "fake-docker");
const driverEnv: Record<string, string> = FAKE_GVISOR
  ? {
      OPENZO_DRIVER: "gvisor",
      OPENZO_DOCKER: join(ROOT, "tools/fake-docker.sh"),
      FAKE_DOCKER_STATE: FAKE_STATE,
      FAKE_DOCKER_AGENT: join(ROOT, ".output/server/index.mjs"),
    }
  : {};

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

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, raw?: BodyInit) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : raw,
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  }
}

async function waitTurn(c: Client, id: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await c.req("GET", `/api/conversations/${id}`);
    const types: string[] = (r.json?.events ?? []).map((e: any) => e.type);
    if (types.includes("session.waiting") || types.includes("turn.completed") || types.includes("session.failed")) return r.json;
    await Bun.sleep(700);
  }
  return null;
}

const host = Bun.spawn(["bun", join(ROOT, "host/server.ts")], {
  env: { ...process.env, ...driverEnv, OPENZO_DATA: DATA, OPENZO_PORT: String(PORT), OPENZO_DEFAULT_LANE: "mock", OPENZO_SIGNUP: "invite", OPENZO_PORT_BASE: String(PORT + 100) },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(200);
  }
  console.log(`openzo e2e — host ${BASE}, data ${DATA}${FAKE_GVISOR ? ", driver gvisor (fake docker)" : ""}`);

  const anon = new Client();
  const h = await anon.req("GET", "/api/health");
  check("health ok", h.status === 200 && h.json.ok, h.text);
  const b = await anon.req("GET", "/api/bootstrap");
  check("fresh server needs setup", b.json.needsSetup === true);
  check("unauthenticated API refused", (await anon.req("GET", "/api/settings")).status === 401);
  check("unauthenticated eve proxy refused", (await anon.req("POST", "/eve/v1/session", { message: "x" })).status === 401);

  const admin = new Client();
  check("short password rejected", (await admin.req("POST", "/api/setup", { name: "boss", password: "short" })).status === 400);
  const setup = await admin.req("POST", "/api/setup", { name: "boss", password: "correct-horse-1" });
  check("admin created by setup", setup.status === 200 && setup.json.user.role === "admin", setup.text);
  check("setup is one-shot", (await anon.req("POST", "/api/setup", { name: "evil", password: "correct-horse-2" })).status === 409);
  check("signup without invite refused", (await anon.req("POST", "/api/signup", { name: "nobody", password: "correct-horse-3" })).status === 403);

  const inv = await admin.req("POST", "/api/admin/invites", { days: 1 });
  check("invite created", typeof inv.json?.code === "string");
  const alice = new Client();
  const su = await alice.req("POST", "/api/signup", { name: "alice", password: "correct-horse-4", invite: inv.json.code });
  check("signup with invite", su.status === 200 && su.json.user.role === "user", su.text);
  check("invite is single-use", (await new Client().req("POST", "/api/signup", { name: "mallory", password: "correct-horse-5", invite: inv.json.code })).status === 403);
  check("non-admin refused from admin API", (await alice.req("GET", "/api/admin/overview")).status === 403);

  // Session carriers that survive auth proxies which strip cookies.
  const tokLogin = await new Client().req("POST", "/api/login", { name: "alice", password: "correct-horse-4" });
  check("login returns a session token", typeof tokLogin.json?.token === "string");
  const viaHeader = await fetch(`${BASE}/api/me`, { headers: { "x-openzo-session": tokLogin.json.token } });
  check("X-Openzo-Session header authenticates", viaHeader.status === 200);
  const viaQuery = await fetch(`${BASE}/api/me?oz_token=${encodeURIComponent(tokLogin.json.token)}`);
  check("oz_token query authenticates", viaQuery.status === 200);
  check("garbage header token refused", (await fetch(`${BASE}/api/me`, { headers: { "x-openzo-session": "nope" } })).status === 401);

  const badLogin = await new Client().req("POST", "/api/login", { name: "alice", password: "wrong" });
  check("wrong password refused", badLogin.status === 401);

  // A real tool call through the mock lane, per user.
  const s1 = await admin.req("POST", "/eve/v1/session", { message: "[mock:bash echo boss-secret > /workspace/mine.txt && pwd]" });
  check("admin turn accepted", s1.status < 300 && !!s1.json?.sessionId, `${s1.status} ${s1.text}`);
  const t1 = s1.json?.sessionId ? await waitTurn(admin, s1.json.sessionId) : null;
  const result1 = t1?.events?.find((e: any) => e.type === "action.result");
  check("admin bash ran in its workspace", result1?.data?.result?.output?.exitCode === 0, JSON.stringify(result1?.data?.result?.output ?? null).slice(0, 200));
  check("file landed in admin workspace on disk", existsSync(join(DATA, "users/boss/workspace/mine.txt")));

  const s2 = await alice.req("POST", "/eve/v1/session", { message: "[mock:bash cat /workspace/mine.txt; ls /workspace; echo alice > /workspace/alice.txt]" });
  const t2 = s2.json?.sessionId ? await waitTurn(alice, s2.json.sessionId) : null;
  const out2 = t2?.events?.find((e: any) => e.type === "action.result")?.data?.result?.output;
  check("alice turn ran", out2 && typeof out2.stdout === "string", JSON.stringify(out2 ?? null).slice(0, 200));
  check("alice cannot see admin's file via /workspace", out2 && !String(out2.stdout).includes("boss-secret"));
  check("alice's file in alice's workspace only", existsSync(join(DATA, "users/alice/workspace/alice.txt")) && !existsSync(join(DATA, "users/boss/workspace/alice.txt")));

  // Conversations are per user.
  const list = await alice.req("GET", "/api/conversations");
  check("alice lists only her conversation", list.json.conversations.length === 1 && list.json.conversations[0].id === s2.json.sessionId);
  check("alice cannot open admin's conversation", (await alice.req("GET", `/api/conversations/${s1.json.sessionId}`)).status === 404);
  check("conversation replays with a continuation token", typeof t2?.session?.continuationToken === "string");

  // Follow-up turn on the same session.
  const follow = await alice.req("POST", `/eve/v1/session/${encodeURIComponent(s2.json.sessionId)}`, {
    message: "[mock:bash wc -l /workspace/alice.txt]",
    continuationToken: t2?.session?.continuationToken,
  });
  check("follow-up turn accepted", follow.status < 300, follow.text.slice(0, 200));

  // Files API + path escapes.
  const put = await alice.req("PUT", "/api/files/raw?path=/notes/today.md", undefined, "# hello");
  check("file write", put.status === 200);
  const get = await alice.req("GET", "/api/files/raw?path=/notes/today.md");
  check("file read back", get.text === "# hello");
  const ls = await alice.req("GET", "/api/files?path=/");
  check("directory listing", ls.json.entries.some((e: any) => e.name === "notes" && e.type === "dir"));
  check("path traversal refused", (await alice.req("GET", "/api/files/raw?path=/../boss/workspace/mine.txt")).status !== 200);
  check("absolute escape refused", (await alice.req("GET", "/api/files/raw?path=/../../../../etc/passwd")).status !== 200);
  await alice.req("POST", "/eve/v1/session", { message: "[mock:bash ln -s /etc /workspace/etc-link]" });
  await Bun.sleep(2500);
  check("symlink escape refused", (await alice.req("GET", "/api/files/raw?path=/etc-link/passwd")).status !== 200);
  check("move", (await alice.req("POST", "/api/files/move", { from: "/notes/today.md", to: "/notes/renamed.md" })).status === 200);
  check("delete", (await alice.req("DELETE", "/api/files?path=/notes")).status === 200);
  check("cannot delete workspace root", (await alice.req("DELETE", "/api/files?path=/")).status === 400);

  // Settings: masking + restart.
  const set = await alice.req("PUT", "/api/settings", { model: { preset: "openai", apiKey: "sk-test-123456789", model: "gpt-x" }, persona: "Be brief.", secrets: [{ name: "MY_TOKEN", value: "tok-abcdef" }, { name: "OPENZO_SECRET", value: "nope" }] });
  check("settings saved", set.status === 200, set.text);
  check("api key masked on read", set.json?.settings?.model?.apiKey?.startsWith("••••") && !set.text.includes("sk-test-123456789"));
  check("reserved env names rejected", !set.text.includes("OPENZO_SECRET"));
  const keep = await alice.req("PUT", "/api/settings", { model: { preset: "mock", apiKey: set.json.settings.model.apiKey } });
  check("masked key round-trips unchanged", keep.status === 200);
  const raw = JSON.parse((await import("bun:sqlite").then(({ Database }) => new Database(join(DATA, "openzo.db")).query("SELECT settings FROM users WHERE name='alice'").get() as any)).settings);
  check("stored key is the original", raw.model.apiKey === "sk-test-123456789");

  // Automations.
  check("bad cron rejected", (await alice.req("POST", "/api/automations", { name: "x", cron: "99 * * * *", prompt: "hi" })).status === 400);
  const auto = await alice.req("POST", "/api/automations", { name: "digest", cron: "0 9 * * 1-5", tz: "Asia/Singapore", prompt: "[mock:bash date > /workspace/ran.txt]" });
  check("automation created with next run", auto.status === 200 && auto.json.automation.next_run > Date.now(), auto.text);
  await alice.req("POST", `/api/automations/${auto.json.automation.id}/run`);
  let ran = false;
  for (let i = 0; i < 40 && !ran; i++) {
    await Bun.sleep(500);
    ran = existsSync(join(DATA, "users/alice/workspace/ran.txt"));
  }
  check("automation run-now executed the prompt", ran);
  const autos = await alice.req("GET", "/api/automations");
  check("automation run recorded", ["running", "ok"].includes(autos.json.automations[0].last_status), autos.json.automations[0].last_status);

  // Terminal websocket.
  const termOut = await new Promise<string>((done) => {
    let buf = "";
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/terminal`, { headers: { cookie: alice.cookie } } as any);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "echo term-$((6*7))\n" })), 300);
    ws.onmessage = (e) => {
      buf += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      if (buf.includes("term-42")) {
        ws.close();
        done(buf);
      }
    };
    ws.onerror = () => done(buf);
    setTimeout(() => (ws.close(), done(buf)), 8000);
  });
  check("terminal runs commands", termOut.includes("term-42"));

  if (FAKE_GVISOR) {
    const calls = readFileSync(join(FAKE_STATE, "calls.log"), "utf8");
    const runLine = calls.split("\n").find((l) => l.startsWith("run ") && l.includes("openzo-u-boss")) ?? "";
    check("gvisor: container per user", runLine.includes("--name openzo-u-boss") && calls.includes("--name openzo-u-alice"));
    check("gvisor: runs under runsc", runLine.includes("--runtime runsc"));
    check("gvisor: isolated network", runLine.includes("--network openzo"));
    check("gvisor: resource limits", runLine.includes("--memory 2g") && runLine.includes("--cpus 1") && runLine.includes("--pids-limit 512"));
    check("gvisor: no-new-privileges + NET_RAW dropped", runLine.includes("--security-opt no-new-privileges") && runLine.includes("--cap-drop NET_RAW"));
    check("gvisor: published on loopback only", runLine.includes("-p 127.0.0.1::3000"));
    check("gvisor: workspace + state bind-mounted", /-v \S+\/users\/boss\/workspace:\/workspace/.test(runLine) && /-v \S+\/users\/boss\/state:\/state/.test(runLine));
    check("gvisor: secrets never in docker argv", !calls.includes("sk-test") && !calls.includes("tok-abcdef") && !calls.includes("OPENZO_AGENT_SECRET="));
    const envFile = join(DATA, "users/boss/state/.runtime.env");
    check("gvisor: env file is 0600", existsSync(envFile) && (statSync(envFile).mode & 0o777) === 0o600);
    check("gvisor: settings change recreates the container", calls.includes("rm -f openzo-u-alice"));
    check("gvisor: terminal execs into the container", /exec -it -w \/workspace .*openzo-u-alice bash -l/.test(calls));
  }

  // Admin.
  const ov = await admin.req("GET", "/api/admin/overview");
  check("admin overview lists both users", ov.json.users.length === 2);
  const aliceRow = ov.json.users.find((u: any) => u.name === "alice");
  check("disable user", (await admin.req("PATCH", `/api/admin/users/${aliceRow.id}`, { disabled: true })).status === 200);
  check("disabled user's session is dead", (await alice.req("GET", "/api/settings")).status === 401);
  check("admin cannot disable self", (await admin.req("PATCH", `/api/admin/users/${setup.json.user.id}`, { disabled: true })).status === 400);
  check("delete user + purge", (await admin.req("DELETE", `/api/admin/users/${aliceRow.id}?purge=1`)).status === 200 && !existsSync(join(DATA, "users/alice")));
  check("audit log records actions", (await admin.req("GET", "/api/admin/audit")).json.audit.length > 5);

  // Origin check.
  const cross = await fetch(`${BASE}/api/automations`, { method: "POST", headers: { cookie: admin.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check("cross-origin POST refused", cross.status === 403);

  // Static UI.
  const ui = await fetch(`${BASE}/files/deep/link`);
  check("SPA deep link serves index.html", ui.status === 200 && (await ui.text()).includes('<div id="root">'));
  check("missing asset is a 404, not index.html", (await fetch(`${BASE}/assets/nope.js`)).status === 404);

  if (REAL) {
    await admin.req("PUT", "/api/settings", { model: { preset: "free" } });
    const r = await admin.req("POST", "/eve/v1/session", { message: "Use bash to compute 17*23 with python3 and reply with only the number." });
    const t = r.json?.sessionId ? await waitTurn(admin, r.json.sessionId, 180_000) : null;
    const final = t?.events?.filter((e: any) => e.type === "message.completed").pop()?.data?.message ?? "";
    check("real model (free lane) answered", /391/.test(final), final.slice(0, 200));
  }
} catch (e) {
  fail++;
  console.log(`  FAIL crashed — ${e}`);
} finally {
  host.kill("SIGTERM");
  await Promise.race([host.exited, Bun.sleep(10_000)]);
  if (!KEEP) rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
