// Zo's browser for openzo: one persistent headless Chromium per user, with its
// profile in the user's workspace (.openzo/browser-profile), so the user can
// log into sites from the web UI and the agent's `browser` tool acts with the
// same cookies. Started on demand, stopped after OPENZO_BROWSER_IDLE_MINUTES.
//
//   process  node runtime-bin/openzo-browser.mjs on the host, CDP on a probed
//            loopback port; the agent (also on the host) uses the same port.
//   gvisor   `docker exec -d` the same launcher inside the user's container:
//            CDP on 127.0.0.1:9222 for the agent, forwarded on :9223 so the
//            host reaches it at the container's bridge IP.
import { join } from "node:path";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { config, ROOT } from "./config";
import { audit, type User } from "./db";
import { HttpError, body, json, requireUser, route } from "./http";
import { internalRoute } from "./internal";
import { allocatePort, containerName, ensureDirs, ensureRuntime, keepAliveChecks, releasePort } from "./runtime";
import * as cdp from "../agent/lib/cdp.ts";

const LAUNCHER = join(ROOT, "runtime-bin/openzo-browser.mjs");
const IDLE_MS = Number(process.env.OPENZO_BROWSER_IDLE_MINUTES ?? 20) * 60_000;
const CTR_PORT = 9222;
const CTR_FORWARD = 9223;

interface Browser {
  user: string;
  hostEndpoint: string; // what the host dials
  agentEndpoint: string; // what the user's runtime dials
  proc?: ReturnType<typeof Bun.spawn>;
  port?: number;
  startedAt: number;
  lastUsed: number;
}

const browsers = new Map<string, Browser>();
const starting = new Map<string, Promise<Browser>>();

async function dockerOut(args: string[]): Promise<string> {
  const p = Bun.spawn([config.docker, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]}: ${err.trim() || out.trim()}`);
  return out.trim();
}

async function waitAlive(endpoint: string, ms: number, alive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("the browser exited during startup (see .openzo/browser.log in your workspace)");
    if (await cdp.browserAlive(endpoint)) return;
    await Bun.sleep(250);
  }
  throw new Error("the browser did not come up in time");
}

// Chromium gets a clean env: nothing of the host's secrets.
function launcherEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TZ", "OPENZO_CHROMIUM", "OPENZO_BROWSER_WIDTH", "OPENZO_BROWSER_HEIGHT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "FONTCONFIG_PATH"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

async function startProcess(user: User): Promise<Browser> {
  const p = ensureDirs(user.name);
  const port = await allocatePort();
  const fd = openSync(join(p.workspace, ".openzo", "browser.log"), "w");
  const b: Browser = {
    user: user.name,
    hostEndpoint: `http://127.0.0.1:${port}`,
    agentEndpoint: `http://127.0.0.1:${port}`,
    port,
    startedAt: Date.now(),
    lastUsed: Date.now(),
  };
  b.proc = Bun.spawn([config.nodeBin, LAUNCHER, "--workspace", p.workspace, "--port", String(port), "--die-with-parent"], {
    env: launcherEnv(),
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    onExit() {
      closeSync(fd);
      releasePort(port);
      if (browsers.get(user.name) === b) browsers.delete(user.name);
    },
  });
  try {
    await waitAlive(b.hostEndpoint, 30_000, () => b.proc!.exitCode === null);
  } catch (e) {
    b.proc.kill();
    throw e;
  }
  return b;
}

async function containerIp(name: string): Promise<string> {
  const ip = (await dockerOut(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name])).split(/\s+/)[0];
  if (!ip) throw new Error("could not find the container's address");
  return ip;
}

async function startContainer(user: User): Promise<Browser> {
  await ensureRuntime(user);
  const name = containerName(user.name);
  const ip = await containerIp(name);
  const b: Browser = {
    user: user.name,
    hostEndpoint: `http://${ip}:${CTR_FORWARD}`,
    agentEndpoint: `http://127.0.0.1:${CTR_PORT}`,
    startedAt: Date.now(),
    lastUsed: Date.now(),
  };
  // Adopt a browser left running across a host restart.
  if (await cdp.browserAlive(b.hostEndpoint)) return b;
  await dockerOut([
    "exec", "-d", name, "sh", "-c",
    `exec node /app-bin/openzo-browser.mjs --workspace /workspace --port ${CTR_PORT} --forward ${CTR_FORWARD} >> /workspace/.openzo/browser.log 2>&1`,
  ]).catch(async () => {
    // .openzo may not exist yet in a fresh workspace.
    await dockerOut(["exec", name, "mkdir", "-p", "/workspace/.openzo"]);
    await dockerOut(["exec", "-d", name, "sh", "-c", `exec node /app-bin/openzo-browser.mjs --workspace /workspace --port ${CTR_PORT} --forward ${CTR_FORWARD} >> /workspace/.openzo/browser.log 2>&1`]);
  });
  await waitAlive(b.hostEndpoint, 30_000);
  return b;
}

export async function ensureBrowser(user: User): Promise<Browser> {
  const have = browsers.get(user.name);
  if (have) {
    have.lastUsed = Date.now();
    if (await cdp.browserAlive(have.hostEndpoint)) return have;
    await stopBrowser(user.name);
  }
  const inflight = starting.get(user.name);
  if (inflight) return inflight;
  mkdirSync(join(ensureDirs(user.name).workspace, ".openzo"), { recursive: true });
  const p = (config.driver === "gvisor" ? startContainer(user) : startProcess(user))
    .then((b) => {
      browsers.set(user.name, b);
      audit(user.id, "browser.start", { driver: config.driver });
      return b;
    })
    .finally(() => starting.delete(user.name));
  starting.set(user.name, p);
  return p;
}

export async function stopBrowser(name: string): Promise<void> {
  const b = browsers.get(name);
  if (!b) return;
  browsers.delete(name);
  await cdp.closeBrowser(b.hostEndpoint).catch(() => {});
  if (b.proc && b.proc.exitCode === null) {
    const done = await Promise.race([b.proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!done) b.proc.kill("SIGKILL");
  } else if (config.driver === "gvisor") {
    await dockerOut(["exec", containerName(name), "pkill", "-f", "openzo-browser.mjs"]).catch(() => {});
  }
}

function running(name: string): Browser | undefined {
  const b = browsers.get(name);
  if (b) b.lastUsed = Date.now();
  return b;
}

// A user's container stays up while their browser is in use.
keepAliveChecks.push((name) => {
  const b = browsers.get(name);
  return !!b && Date.now() - b.lastUsed < IDLE_MS;
});

setInterval(() => {
  for (const b of [...browsers.values()]) {
    if (Date.now() - b.lastUsed >= IDLE_MS) void stopBrowser(b.user).then(() => audit(null, "browser.idle-stop", { user: b.user }));
  }
}, 60_000).unref?.();

export async function shutdownBrowsers() {
  await Promise.all([...browsers.keys()].map((n) => stopBrowser(n)));
}

// ------------------------------------------------------------------ routes

async function withPage<T>(b: Browser, tab: string | undefined, fn: (s: cdp.CdpSession, t: cdp.Tab) => Promise<T>): Promise<T> {
  const { session, tab: t } = await cdp.CdpSession.page(b.hostEndpoint, tab);
  try {
    return await fn(session, t);
  } finally {
    session.close();
  }
}

route("GET", "/api/browser", async ({ req }) => {
  const user = requireUser(req);
  const b = running(user.name);
  if (!b) return json({ state: "stopped", tabs: [] });
  try {
    const tabs = await cdp.listTabs(b.hostEndpoint);
    return json({ state: "running", startedAt: b.startedAt, tabs, active: tabs[0]?.id ?? null });
  } catch {
    await stopBrowser(user.name);
    return json({ state: "stopped", tabs: [] });
  }
});

route("POST", "/api/browser/start", async ({ req }) => {
  const user = requireUser(req);
  const b = await ensureBrowser(user);
  const tabs = await cdp.listTabs(b.hostEndpoint);
  return json({ state: "running", startedAt: b.startedAt, tabs, active: tabs[0]?.id ?? null });
});

route("POST", "/api/browser/stop", async ({ req }) => {
  const user = requireUser(req);
  await stopBrowser(user.name);
  audit(user.id, "browser.stop");
  return json({ state: "stopped", tabs: [] });
});

const num = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
};

route("POST", "/api/browser/action", async ({ req }) => {
  const user = requireUser(req);
  const a = await body<Record<string, any>>(req);
  const b = await ensureBrowser(user);
  const tab = typeof a.tab === "string" && a.tab ? a.tab : undefined;
  let result: unknown = null;
  switch (a.action) {
    case "goto":
      if (typeof a.url !== "string" || !a.url.trim()) throw new HttpError(400, "url required");
      await withPage(b, tab, (s) => cdp.navigate(s, a.url));
      break;
    case "click":
      await withPage(b, tab, (s) => cdp.clickAt(s, num(a.x, "x"), num(a.y, "y"), a.button ?? "left"));
      break;
    case "type":
      if (typeof a.text !== "string") throw new HttpError(400, "text required");
      await withPage(b, tab, (s) => cdp.typeText(s, a.text));
      break;
    case "press":
      if (typeof a.key !== "string" || !a.key) throw new HttpError(400, "key required");
      await withPage(b, tab, (s) => cdp.pressKey(s, a.key));
      break;
    case "scroll":
      await withPage(b, tab, (s) => cdp.scroll(s, Number(a.dx ?? 0), Number(a.dy ?? 0), a.x === undefined ? undefined : num(a.x, "x"), a.y === undefined ? undefined : num(a.y, "y")));
      break;
    case "back":
    case "forward":
      result = await withPage(b, tab, (s) => cdp.history(s, a.action));
      break;
    case "reload":
      await withPage(b, tab, (s) => cdp.reload(s));
      break;
    case "newtab": {
      const t = await cdp.newTab(b.hostEndpoint, a.url ? cdp.normalizeUrl(String(a.url)) : "about:blank");
      await cdp.activateTab(b.hostEndpoint, t.id);
      result = t;
      break;
    }
    case "activate":
      if (!tab) throw new HttpError(400, "tab required");
      await cdp.activateTab(b.hostEndpoint, tab);
      break;
    case "closetab": {
      if (!tab) throw new HttpError(400, "tab required");
      await cdp.closeTab(b.hostEndpoint, tab);
      if ((await cdp.listTabs(b.hostEndpoint)).length === 0) await cdp.newTab(b.hostEndpoint);
      break;
    }
    default:
      throw new HttpError(400, `unknown action: ${a.action}`);
  }
  const tabs = await cdp.listTabs(b.hostEndpoint);
  return json({ ok: true, result, tabs, active: tabs[0]?.id ?? null });
});

route("GET", "/api/browser/screenshot", async ({ req, url }) => {
  const user = requireUser(req);
  const b = running(user.name);
  if (!b) throw new HttpError(409, "the browser is not running");
  const tab = url.searchParams.get("tab") || undefined;
  const quality = Math.min(95, Math.max(20, Number(url.searchParams.get("q") ?? 70) || 70));
  const img = await withPage(b, tab, (s) => cdp.screenshot(s, "jpeg", quality));
  return new Response(img, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
});

// The agent's tools ask for the endpoint they should dial; starting the
// browser if needed is the host's job, so the runtime never spawns Chromium
// itself (in gvisor it would be the same container either way).
internalRoute("POST", "/browser/ensure", async ({ user }) => {
  const b = await ensureBrowser(user);
  return json({ endpoint: b.agentEndpoint, driver: config.driver });
});
