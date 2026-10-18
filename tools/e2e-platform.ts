// End-to-end check of openzo's platform layer: sites & services (Zo Space,
// Sites, user services), channels (Telegram two-way, email over SMTP,
// Discord/Slack/ntfy/webhook), the ask API + access tokens, personas & rules,
// skills, automations with delivery, and the runtime → host internal API as
// the agent's tools use it (driven through the mock model's [mock:tool …]).
//
//   bun tools/e2e-platform.ts [--keep]
//
// Every external service is a local mock: a fake Telegram Bot API, a fake
// SMTP server, and webhook receivers. Needs a built agent (npm run build:agent).
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";

const ROOT = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
// --gvisor-fake: the gvisor driver against tools/fake-docker.sh (control flow
// and argv only; "containers" are local processes sharing this network, so
// services get explicit ports here instead of the container's own 8000).
const FAKE_GVISOR = process.argv.includes("--gvisor-fake");
const PORT = 19000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "openzo-e2e-platform-"));
const driverEnv: Record<string, string> = FAKE_GVISOR
  ? {
      OPENZO_DRIVER: "gvisor",
      OPENZO_DOCKER: join(ROOT, "tools/fake-docker.sh"),
      FAKE_DOCKER_STATE: join(DATA, "fake-docker"),
      FAKE_DOCKER_AGENT: join(ROOT, ".output/server/index.mjs"),
      // The bridge-gateway listener runtimes reach the host through.
      OPENZO_INTERNAL_HOST: "127.0.0.1",
      OPENZO_INTERNAL_PORT: String(PORT + 700),
    }
  : {};
const svcPort = (n: number) => (FAKE_GVISOR ? { port: PORT + 500 + n } : {});

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
async function until<T>(fn: () => T | Promise<T>, ms = 30_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(250);
  }
  return undefined;
}

// ---------------------------------------------------------------- mocks

const hooks: { path: string; body: string; headers: Record<string, string> }[] = [];
const tg = { updates: [] as any[], sent: [] as any[], docs: 0, nextId: 1 };
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const m = /^\/botTESTTOKEN\/(\w+)$/.exec(url.pathname);
    if (m) {
      const method = m[1]!;
      const ct = req.headers.get("content-type") ?? "";
      const b: any = ct.includes("json") ? await req.json().catch(() => ({})) : {};
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, username: "openzo_test_bot" } });
      if (method === "getUpdates") {
        const offset = b.offset ?? 0;
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && !tg.updates.some((u) => u.update_id >= offset)) await Bun.sleep(50);
        return Response.json({ ok: true, result: tg.updates.filter((u) => u.update_id >= offset) });
      }
      if (method === "sendMessage") {
        tg.sent.push(b);
        return Response.json({ ok: true, result: {} });
      }
      if (method === "sendDocument") {
        tg.docs++;
        return Response.json({ ok: true, result: {} });
      }
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.startsWith("/botBADTOKEN/")) return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
    hooks.push({ path: url.pathname, body: await req.text(), headers: Object.fromEntries(req.headers) });
    return new Response("ok");
  },
});
const MOCK = `http://127.0.0.1:${mock.port}`;
const tgSay = (text: string) => tg.updates.push({ update_id: tg.nextId++, message: { chat: { id: 4242 }, text } });

const mails: string[] = [];
const smtp = createServer((sock) => {
  let data = false;
  let buf = "";
  sock.write("220 mock ESMTP\r\n");
  sock.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while (data ? (i = buf.indexOf("\r\n.\r\n")) >= 0 : (i = buf.indexOf("\r\n")) >= 0) {
      if (data) {
        mails.push(buf.slice(0, i));
        buf = buf.slice(i + 5);
        data = false;
        sock.write("250 queued\r\n");
        continue;
      }
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write("250-mock\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (/^AUTH PLAIN/i.test(line)) sock.write("235 ok\r\n");
      else if (/^DATA/i.test(line)) {
        data = true;
        sock.write("354 go\r\n");
      } else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
const SMTP_PORT = (smtp.address() as any).port;

// ---------------------------------------------------------------- host

const host = Bun.spawn(["bun", join(ROOT, "host/server.ts")], {
  env: {
    ...process.env,
    ...driverEnv,
    OPENZO_DATA: DATA,
    OPENZO_PORT: String(PORT),
    OPENZO_DEFAULT_LANE: "mock",
    OPENZO_SIGNUP: "invite",
    OPENZO_PORT_BASE: String(PORT + 100),
    OPENZO_TELEGRAM_API: MOCK,
    OPENZO_SMTP_URL: `smtp://zo%40example.com:pw@127.0.0.1:${SMTP_PORT}?tls=off`,
    OPENZO_SMTP_FROM: "openzo <zo@example.com>",
    OPENZO_SKILLS_REGISTRY: `${MOCK}/no-registry`,
  },
  stdout: KEEP ? "inherit" : "pipe",
  stderr: KEEP ? "inherit" : "pipe",
});

let token = "";
const api = async (method: string, path: string, body?: unknown, auth = token) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(auth ? { "x-openzo-session": auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
};

try {
  await until(() => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false), 15_000);
  console.log(`openzo platform e2e — host ${BASE}, data ${DATA}${FAKE_GVISOR ? ", driver gvisor (fake docker)" : ""}`);
  const setup = await api("POST", "/api/setup", { name: "zan", password: "correct-horse-9" }, "");
  token = setup.json?.token;
  check("admin created", setup.status === 200 && !!token, setup.text);
  const ws = join(DATA, "users/zan/workspace");

  // ------------------------------------------------ sites & services
  const sites = await api("GET", "/api/sites");
  const space = sites.json?.services?.find((s: any) => s.name === "space");
  check("every user gets a Space", space?.kind === "static" && space.public === true);
  const spacePage = await fetch(`${BASE}/s/zan/space/`);
  check("Space serves its starter page publicly", spacePage.status === 200 && (await spacePage.text()).includes("zan's space"));
  writeFileSync(join(ws, "space/about.html"), "<h1>about me</h1>");
  check("Space clean URLs (/about → about.html)", (await (await fetch(`${BASE}/s/zan/space/about`)).text()).includes("about me"));
  check("dotfiles are never served", (await fetch(`${BASE}/s/zan/space/.env`)).status === 404);
  check("path traversal refused", (await fetch(`${BASE}/s/zan/space/..%2f..%2fsecret`)).status === 404);

  mkdirSync(join(ws, "api"), { recursive: true });
  writeFileSync(
    join(ws, "api/server.ts"),
    `Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch(req, srv) { const u = new URL(req.url); if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no"); return Response.json({ path: u.pathname, prefix: req.headers.get("x-forwarded-prefix"), cookie: req.headers.get("cookie") }); }, websocket: { message(ws, m) { ws.send("echo:" + m); } } });`,
  );
  const created = await api("POST", "/api/sites", { name: "api", kind: "process", command: "bun server.ts", root: "api", ...svcPort(1) });
  check("process service created", created.status === 200 && created.json.service.state === "running", created.text);
  const hit = await until(async () => {
    const r = await fetch(`${BASE}/s/zan/api/hello?x=1`, { headers: { cookie: "oz_session=SHOULD-NOT-LEAK; mine=1" } });
    return r.ok ? r.json() : null;
  }, 15_000);
  check("process service reverse-proxied", (hit as any)?.path === "/hello" && (hit as any)?.prefix === "/s/zan/api", JSON.stringify(hit));
  check("openzo session cookie stripped before the app", (hit as any)?.cookie === "mine=1", JSON.stringify(hit));
  const echo = await new Promise<string>((done) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/s/zan/api/ws`);
    w.onopen = () => w.send("ping");
    w.onmessage = (e) => (done(String(e.data)), w.close());
    w.onerror = () => done("error");
    setTimeout(() => done("timeout"), 5000);
  });
  check("websockets pass through to the service", echo === "echo:ping", echo);
  await api("PATCH", "/api/sites/api", { public: false });
  await Bun.sleep(1500);
  check("private service refuses anonymous visitors", (await fetch(`${BASE}/s/zan/api/x`)).status === 403);
  check("private service admits its owner", (await fetch(`${BASE}/s/zan/api/x`, { headers: { "x-openzo-session": token } })).status === 200);
  const dom = await api("PATCH", "/api/sites/api", { domains: ["app.example.test"] });
  check("custom domain attached", dom.json?.service?.urls?.includes("https://app.example.test/"), dom.text);
  check("TLS ask approves attached domains only", (await api("GET", "/api/sites/tls-ask?domain=app.example.test")).status === 200 && (await api("GET", "/api/sites/tls-ask?domain=evil.test")).status === 404);
  const redirect = await fetch(`${BASE}/anything`, { headers: { host: "app.example.test" }, redirect: "manual" });
  check("private custom domain redirects to sign-in", redirect.status === 302 && redirect.headers.get("location")!.includes("/api/sites/auth"));
  const ticketLoc = (await api("GET", `/api/sites/auth?return=${encodeURIComponent("http://app.example.test/page")}`)).headers.get("location") ?? "";
  const exch = await fetch(`${BASE}${ticketLoc.replace("http://app.example.test", "")}`, { headers: { host: "app.example.test" }, redirect: "manual" });
  const siteCookie = (exch.headers.get("set-cookie") ?? "").split(";")[0];
  const viaDomain = await fetch(`${BASE}/page`, { headers: { host: "app.example.test", cookie: siteCookie } });
  check("ticket → site cookie → owner sees private site on its domain", viaDomain.status === 200 && ((await viaDomain.json()) as any).path === "/page");
  check("domain already taken is refused", (await api("POST", "/api/sites", { name: "dup", kind: "static", domains: ["app.example.test"] })).status === 409);

  writeFileSync(join(ws, "api/crash.sh"), "echo boom; exit 3");
  await api("POST", "/api/sites", { name: "crashy", kind: "process", command: "bash crash.sh", root: "api", ...svcPort(2) });
  const crashed = await until(async () => ((await api("GET", "/api/sites")).json.services.find((s: any) => s.name === "crashy")?.state === "crashed" ? true : null), 40_000);
  check("crash loop detected and stopped", crashed);
  check("service log captured", (await api("GET", "/api/sites/crashy/log")).text.includes("boom"));
  check("delete stops and removes", (await api("DELETE", "/api/sites/crashy")).status === 200);
  check("the Space cannot be deleted", (await api("DELETE", "/api/sites/space")).status === 400);

  // ------------------------------------------------ internal API
  const secret = readFileSync(join(DATA, "secret"), "utf8").trim();
  const rt = `zan.${createHmac("sha256", secret).update("runtime:zan").digest("base64url")}`;
  check("internal API accepts the runtime token", (await fetch(`${BASE}/internal/whoami`, { headers: { "x-openzo-runtime": rt } })).status === 200);
  check("internal API refuses forged tokens", (await fetch(`${BASE}/internal/whoami`, { headers: { "x-openzo-runtime": "zan.forged" } })).status === 401);

  // ------------------------------------------------ channels
  const badTg = await api("PUT", "/api/channels", { telegram: { botToken: "BADTOKEN" } });
  check("bad Telegram token rejected", badTg.status === 400);
  const ch = await api("PUT", "/api/channels", {
    preferred: "discord",
    telegram: { botToken: "TESTTOKEN", chat: true },
    email: { address: "me@example.com" },
    discord: { webhookUrl: `${MOCK}/discord` },
    slack: { webhookUrl: `${MOCK}/slack` },
    ntfy: { topicUrl: `${MOCK}/ntfy/zan` },
    webhook: { url: `${MOCK}/hook`, secret: "s3cret" },
  });
  check("channels saved; secrets masked", ch.status === 200 && ch.json.config.discord.webhookUrl.startsWith("••••") && !ch.text.includes("TESTTOKEN"), ch.text.slice(0, 300));
  const code = ch.json?.telegram?.pairCode;
  check("Telegram bot verified + pairing code issued", ch.json?.telegram?.bot === "openzo_test_bot" && typeof code === "string");
  tgSay("hello?");
  check("unpaired chat is told to pair", await until(() => tg.sent.some((m) => /isn't paired/.test(m.text))));
  tgSay(`/start ${code}`);
  check("pairing by code", await until(async () => (await api("GET", "/api/channels")).json.telegram.paired));
  for (const c of ["email", "discord", "slack", "ntfy", "webhook", "telegram"]) {
    const t = await api("POST", "/api/channels/test", { channel: c });
    check(`test message via ${c}`, t.status === 200, t.text);
  }
  check("email reached SMTP with subject", mails.some((m) => m.includes("Subject: openzo test") && m.includes("To: me@example.com")));
  check("webhook carries its secret header", hooks.some((h) => h.path === "/hook" && h.headers["x-openzo-secret"] === "s3cret"));
  check("ntfy got the text", hooks.some((h) => h.path === "/ntfy/zan" && h.body.includes("Test message")));

  // Telegram → agent → Telegram (mock model runs a real bash tool)
  const before = tg.sent.length;
  tgSay("[mock:bash echo telegram-turn-ok > /workspace/tg.txt && echo done]");
  const reply = await until(() => tg.sent.slice(before).find((m) => /Command finished/.test(m.text)), 90_000);
  check("Telegram message runs an agent turn and replies", !!reply, JSON.stringify(tg.sent.slice(before)).slice(0, 300));
  check("…which really ran in the workspace", existsSync(join(ws, "tg.txt")));
  const convs = await api("GET", "/api/conversations");
  check("Telegram conversation recorded", convs.json.conversations.some((c: any) => c.source === "telegram"));

  // agent tool → host: send_message with an attachment
  writeFileSync(join(ws, "report.txt"), "quarterly numbers");
  const beforeHooks = hooks.length;
  const sm = await api("POST", "/eve/v1/session", { message: `[mock:tool send_message {"text":"from the agent","channel":"discord","files":["/workspace/report.txt"]}]` });
  check("agent turn with send_message started", !!sm.json?.sessionId, sm.text);
  check("send_message tool delivered to Discord with the file", await until(() => hooks.slice(beforeHooks).some((h) => h.path === "/discord" && h.body.includes("quarterly numbers")), 60_000));

  // agent tool → host: service
  const sv = await api("POST", "/eve/v1/session", { message: `[mock:tool service {"action":"upsert","name":"notes","kind":"static","root":"notes"}]` });
  check("agent created a static site", !!sv.json?.sessionId && !!(await until(async () => (await api("GET", "/api/sites")).json.services.some((s: any) => s.name === "notes"), 60_000)));

  // ------------------------------------------------ personas & rules
  await api("POST", "/api/personas", { name: "Terse", prompt: "Answer in one line.", active: true });
  const prof = await api("POST", "/api/rules", { condition: "the user asks about money", instruction: "Use SGD." });
  check("persona + rule stored", prof.json?.activePersona?.name === "Terse" && prof.json?.rules?.[0]?.instruction === "Use SGD.");
  const rem = await api("POST", "/eve/v1/session", { message: `[mock:tool manage_profile {"action":"create","kind":"rule","instruction":"Reply in British English."}]` });
  check("agent saved a rule with manage_profile", !!rem.json?.sessionId && !!(await until(async () => (await api("GET", "/api/profile")).json.rules.some((r: any) => r.instruction === "Reply in British English."), 60_000)));

  // ------------------------------------------------ ask API + tokens
  const tok = await api("POST", "/api/tokens", { name: "script" });
  check("access token issued", typeof tok.json?.token === "string" && tok.json.token.startsWith("oz_"));
  const ask = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.json.token}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "[mock:bash echo 6x7=$((6*7))]" }),
  });
  const askJson = (await ask.json()) as any;
  check("POST /api/ask with a bearer token returns the answer", ask.status === 200 && String(askJson.output).includes("42"), JSON.stringify(askJson).slice(0, 300));
  const ask2 = await fetch(`${BASE}/zo/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.json.token}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "[mock:bash echo second]", conversation_id: askJson.conversation_id }),
  });
  const ask2Json = (await ask2.json()) as any;
  check("/zo/ask alias continues the same conversation", ask2.status === 200 && ask2Json.conversation_id === askJson.conversation_id && String(ask2Json.output).includes("second"), JSON.stringify(ask2Json).slice(0, 300));
  const listed = await api("GET", "/api/tokens");
  check("tokens listed without secrets", listed.json.tokens.length === 1 && !listed.text.includes(tok.json.token.slice(3)));
  await api("DELETE", `/api/tokens/${listed.json.tokens[0].id}`);
  check("revoked token refused", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tok.json.token}` } })).status === 401);

  // ------------------------------------------------ automations with delivery
  const au = await api("POST", "/api/automations", { name: "nightly", cron: "0 3 * * *", tz: "Asia/Singapore", prompt: "[mock:bash echo automation-ran]", deliver: "webhook" });
  check("automation with delivery created", au.status === 200 && au.json.automation.deliver === "webhook", au.text);
  const hb = hooks.length;
  await api("POST", `/api/automations/${au.json.automation.id}/run`);
  check("automation result delivered to the channel", await until(() => hooks.slice(hb).some((h) => h.path === "/hook" && h.body.includes("automation-ran")), 90_000));
  const ag = await api("POST", "/eve/v1/session", { message: `[mock:tool automations {"action":"create","name":"from-agent","cron":"@daily","prompt":"say hi"}]` });
  check("agent created an automation", !!ag.json?.sessionId && !!(await until(async () => (await api("GET", "/api/automations")).json.automations.some((a: any) => a.name === "from-agent"), 60_000)));

  // ------------------------------------------------ skills
  mkdirSync(join(ws, "Skills/hello-skill"), { recursive: true });
  writeFileSync(join(ws, "Skills/hello-skill/SKILL.md"), "---\nname: hello-skill\ndescription: Says hello\n  in two lines.\n---\n\nBody");
  const sk = await api("GET", "/api/skills");
  check("workspace skills listed with frontmatter", sk.json?.skills?.[0]?.name === "hello-skill" && sk.json.skills[0].description === "Says hello in two lines.", sk.text);
  check("skill removed", (await api("DELETE", "/api/skills/hello-skill")).status === 200 && !existsSync(join(ws, "Skills/hello-skill")));
} catch (e) {
  fail++;
  console.log(`  FAIL harness error — ${(e as Error)?.stack ?? e}`);
} finally {
  host.kill("SIGTERM");
  await Promise.race([host.exited, Bun.sleep(15_000)]);
  mock.stop(true);
  smtp.close();
  if (!KEEP) rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
