// End-to-end check of openzo's browser (host/browser.ts + runtime-bin launcher
// + agent/lib/cdp.ts + agent/tools/browser.ts). Boots its own host on a
// throwaway data dir (process driver), serves a tiny test page, and drives the
// browser through the user API, the internal (runtime) API and the agent tool.
// Needs a Chromium (OPENZO_CHROMIUM, /usr/bin/chromium, or Playwright's).
//
//   bun tools/e2e-browser.ts [--keep]
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cdp from "../agent/lib/cdp.ts";

const ROOT = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "openzo-e2e-browser-"));

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

// The test page: a fixed-position button and a form at known coordinates.
const page = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/two") return new Response("<title>second page</title><p>two</p>", { headers: { "content-type": "text/html" } });
    return new Response(
      `<!doctype html><title>openzo test</title>
<body style="margin:0">
<button id="go" style="position:fixed;left:100px;top:100px;width:200px;height:80px" onclick="document.title='clicked'">Press me</button>
<form id="f" style="position:fixed;left:100px;top:300px" onsubmit="event.preventDefault();document.title='typed:'+document.getElementById('q').value">
  <input id="q" aria-label="Query box" style="width:300px;height:40px">
</form>
<button id="agent" style="position:fixed;left:500px;top:100px;width:200px;height:80px" onclick="document.title='agent clicked'">Agent button</button>
<a href="/two" style="position:fixed;left:500px;top:300px">to page two</a>
<div style="height:3000px"></div>
</body>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const PAGE = `http://127.0.0.1:${page.port}/`;

const host = Bun.spawn(["bun", join(ROOT, "host/server.ts")], {
  env: { ...process.env, OPENZO_DATA: DATA, OPENZO_PORT: String(PORT), OPENZO_DEFAULT_LANE: "mock", OPENZO_SIGNUP: "invite", OPENZO_PORT_BASE: String(PORT + 100) },
  stdout: "pipe",
  stderr: "pipe",
});

let cookie = "";
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, buf, type: res.headers.get("content-type") ?? "" };
}

const title = async () => (await req("GET", "/api/browser")).json?.tabs?.[0]?.title;
async function until(fn: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(150);
  }
  return false;
}

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(200);
  }
  console.log(`openzo browser e2e — host ${BASE}, data ${DATA}, page ${PAGE}`);
  const setup = await req("POST", "/api/setup", { name: "boss", password: "correct-horse-1" });
  check("admin created", setup.status === 200, setup.text);

  check("browser API needs a session", (await fetch(`${BASE}/api/browser`)).status === 401);
  const st0 = await req("GET", "/api/browser");
  check("browser starts stopped", st0.json?.state === "stopped", st0.text);
  const start = await req("POST", "/api/browser/start");
  check("browser starts", start.status === 200 && start.json.state === "running" && start.json.tabs.length >= 1, start.text);
  check("profile lives in the workspace", existsSync(join(DATA, "users/boss/workspace/.openzo/browser-profile")));

  const go = await req("POST", "/api/browser/action", { action: "goto", url: PAGE });
  check("navigate", go.status === 200 && go.json.tabs[0].url === PAGE, go.text);
  check("page title read", (await title()) === "openzo test");

  const shot = await req("GET", "/api/browser/screenshot");
  check("screenshot is a JPEG", shot.status === 200 && shot.type === "image/jpeg" && shot.buf[0] === 0xff && shot.buf[1] === 0xd8, `${shot.status} ${shot.type}`);
  check("screenshot is a real frame (>2 KB)", shot.buf.length > 2000, String(shot.buf.length));

  await req("POST", "/api/browser/action", { action: "click", x: 200, y: 140 });
  check("click by coordinates hits the button", await until(async () => (await title()) === "clicked"), await title());

  await req("POST", "/api/browser/action", { action: "click", x: 250, y: 320 });
  await req("POST", "/api/browser/action", { action: "type", text: "hello world" });
  await req("POST", "/api/browser/action", { action: "press", key: "Enter" });
  check("type + Enter submits the form", await until(async () => (await title()) === "typed:hello world"), await title());

  const scr = await req("POST", "/api/browser/action", { action: "scroll", dy: 500 });
  check("scroll accepted", scr.status === 200, scr.text);
  check("unknown action refused", (await req("POST", "/api/browser/action", { action: "explode" })).status === 400);

  // Internal API: the runtime's view of the same browser.
  const secret = readFileSync(join(DATA, "secret"), "utf8").trim();
  const token = `boss.${createHmac("sha256", secret).update("runtime:boss").digest("base64url")}`;
  const bad = await fetch(`${BASE}/internal/browser/ensure`, { method: "POST", headers: { "x-openzo-runtime": "boss.nope" } });
  check("internal ensure refuses a bad runtime token", bad.status === 401);
  const ens = await fetch(`${BASE}/internal/browser/ensure`, { method: "POST", headers: { "x-openzo-runtime": token } }).then((r) => r.json() as any);
  check("internal ensure returns a CDP endpoint", typeof ens.endpoint === "string" && ens.endpoint.startsWith("http://127.0.0.1:"), JSON.stringify(ens));

  // The agent's CDP lib against that endpoint: snapshot, click by index.
  const ep: string = ens.endpoint;
  {
    const { session: s } = await cdp.CdpSession.page(ep);
    const snap = await cdp.snapshot(s);
    check("snapshot sees the page text", snap.text.includes("Press me") && snap.url === PAGE, snap.text.slice(0, 100));
    const btn = snap.elements.find((e) => e.label === "Agent button");
    const box = snap.elements.find((e) => e.label === "Query box");
    check("snapshot lists interactive elements with labels", !!btn && !!box && box.value === "hello world", JSON.stringify(snap.elements));
    const pt = await cdp.locate(s, { index: btn!.i });
    await cdp.clickAt(s, pt.x, pt.y);
    check("agent lib clicks by snapshot index", await until(async () => (await cdp.evaluate<string>(s, "document.title")) === "agent clicked"));
    check("the UI sees what the agent did (same browser)", (await title()) === "agent clicked");
    s.close();
  }

  // The agent tool itself, wired to this host.
  process.env.OPENZO_HOST_API = `${BASE}/internal`;
  process.env.OPENZO_RUNTIME_TOKEN = token;
  process.env.OPENZO_WORKSPACE = join(DATA, "users/boss/workspace");
  try {
    const tool: any = (await import("../agent/tools/browser.ts")).default;
    const exec = tool.execute ?? tool.definition?.execute ?? tool.config?.execute;
    if (typeof exec !== "function") throw new Error(`tool shape: ${Object.keys(tool)}`);
    const run = (input: any) => exec(input, {});
    const o = await run({ action: "open", url: PAGE });
    check("tool: open", o?.title === "openzo test", JSON.stringify(o));
    const sn = await run({ action: "snapshot" });
    const link = sn.elements.find((e: any) => e.tag === "a");
    check("tool: snapshot", !!link && sn.elements.length >= 4, JSON.stringify(sn).slice(0, 200));
    const c = await run({ action: "click", index: link.i });
    check("tool: click a link navigates", await until(async () => (await title()) === "second page"), JSON.stringify(c));
    const back = await run({ action: "back" });
    check("tool: back", back.moved === true && back.url === PAGE, JSON.stringify(back));
    const t = await run({ action: "type", selector: "#q", text: "from agent", submit: true });
    check("tool: type into a selector and submit", t.title === "typed:from agent", JSON.stringify(t));
    const sc = await run({ action: "screenshot" });
    const onDisk = join(DATA, "users/boss/workspace", sc.path.replace(/^\/workspace\//, ""));
    check("tool: screenshot saved as PNG under /workspace/.openzo/browser", sc.path.startsWith("/workspace/.openzo/browser/") && existsSync(onDisk) && readFileSync(onDisk)[1] === 0x50, JSON.stringify(sc));
    const ev = await run({ action: "eval", expression: "1 + 41" });
    check("tool: eval", ev.value === "42", JSON.stringify(ev));
    const tabs0 = (await run({ action: "tabs" })).tabs.length;
    await run({ action: "open", url: `${PAGE}two`, new_tab: true });
    const tabs1 = await run({ action: "tabs" });
    check("tool: new tab", tabs1.tabs.length === tabs0 + 1 && tabs1.tabs[0].title === "second page", JSON.stringify(tabs1));
    await run({ action: "close_tab", tab: tabs1.tabs[0].id });
    check("tool: close tab", (await run({ action: "tabs" })).tabs.length === tabs0);
  } catch (e) {
    check("agent tool runs", false, String((e as Error)?.stack ?? e));
  }

  // Logins persist: a cookie set now survives a browser restart (same profile).
  {
    const { session: s } = await cdp.CdpSession.page(ep);
    await cdp.evaluate(s, `document.cookie = "oz_login=yes; max-age=86400; path=/"`);
    s.close();
  }
  const stop = await req("POST", "/api/browser/stop");
  check("browser stops", stop.json?.state === "stopped" && (await req("GET", "/api/browser")).json.state === "stopped");
  check("CDP port closed after stop", await until(async () => !(await cdp.browserAlive(ep)), 8000));
  await req("POST", "/api/browser/start");
  await req("POST", "/api/browser/action", { action: "goto", url: PAGE });
  const ens2 = await fetch(`${BASE}/internal/browser/ensure`, { method: "POST", headers: { "x-openzo-runtime": token } }).then((r) => r.json() as any);
  {
    const { session: s } = await cdp.CdpSession.page(ens2.endpoint);
    const c = await cdp.evaluate<string>(s, "document.cookie");
    check("cookie survives a browser restart (persistent profile)", c.includes("oz_login=yes"), c);
    s.close();
  }
  await req("POST", "/api/browser/stop");
} catch (e) {
  check("no exception", false, String((e as Error)?.stack ?? e));
} finally {
  host.kill("SIGTERM");
  await Promise.race([host.exited, Bun.sleep(8000)]);
  page.stop(true);
  if (fail > 0) {
    const err = await new Response(host.stderr).text().catch(() => "");
    if (err.trim()) console.log(`--- host stderr ---\n${err.slice(-3000)}`);
  }
  if (!KEEP) rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
