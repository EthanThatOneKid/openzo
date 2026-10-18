#!/usr/bin/env node
// openzo's per-user browser: one headless Chromium with a persistent profile
// in the user's workspace, driven over the Chrome DevTools Protocol by both
// the web UI (through the host) and the agent's `browser` tool. Same profile,
// so a login made in the UI is the agent's login too.
//
//   node openzo-browser.mjs --workspace <dir> --port <cdp port>
//                           [--forward <port>] [--die-with-parent]
//
// --forward (or OPENZO_BROWSER_FORWARD) also listens on 0.0.0.0:<port> and
// pipes to the loopback CDP port: inside a gVisor container that is how the
// host reaches CDP by container IP. Plain Node, zero dependencies.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const workspace = arg("workspace", process.env.OPENZO_WORKSPACE || "/workspace");
const port = Number(arg("port", process.env.OPENZO_BROWSER_PORT || "9222"));
const forward = Number(arg("forward", process.env.OPENZO_BROWSER_FORWARD || "0"));
const width = Number(process.env.OPENZO_BROWSER_WIDTH || 1280);
const height = Number(process.env.OPENZO_BROWSER_HEIGHT || 800);

function findChromium() {
  const env = process.env.OPENZO_CHROMIUM;
  if (env && existsSync(env)) return env;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Playwright's downloaded builds, newest first.
  for (const home of [...new Set([homedir(), process.env.HOME, "/root"].filter(Boolean))]) {
    const pw = join(home, ".cache/ms-playwright");
    if (!existsSync(pw)) continue;
    const dirs = readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = join(pw, d, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const bin = findChromium();
if (!bin) {
  console.error("[openzo-browser] no Chromium found: set OPENZO_CHROMIUM or install chromium");
  process.exit(3);
}

const root = join(workspace, ".openzo");
const profile = join(root, "browser-profile");
mkdirSync(profile, { recursive: true });
// A crash leaves Singleton* locks behind and Chromium then refuses the profile.
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profile, f), { force: true });
writeFileSync(join(root, "browser.pid"), String(process.pid));

const chrome = spawn(
  bin,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--password-store=basic",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
// Chromium is chatty on stderr (dbus, inotify); keep only fatal lines.
chrome.stderr.on("data", (d) => {
  const s = String(d);
  if (/FATAL|Check failed/i.test(s)) process.stderr.write(s);
});
console.log(`[openzo-browser] ${bin} pid ${chrome.pid}, CDP 127.0.0.1:${port}, profile ${profile}`);

let fwd = null;
if (forward > 0) {
  fwd = createServer((client) => {
    const up = connect({ host: "127.0.0.1", port });
    client.pipe(up).pipe(client);
    const done = () => (client.destroy(), up.destroy());
    client.on("error", done);
    up.on("error", done);
  });
  fwd.listen(forward, "0.0.0.0", () => console.log(`[openzo-browser] forwarding 0.0.0.0:${forward} -> 127.0.0.1:${port}`));
}

function shutdown(code = 0) {
  fwd?.close();
  if (chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    setTimeout(() => chrome.kill("SIGKILL"), 4000).unref();
  }
  rmSync(join(root, "browser.pid"), { force: true });
  setTimeout(() => process.exit(code), 100).unref();
}

chrome.on("exit", (code) => {
  console.log(`[openzo-browser] chromium exited (${code})`);
  shutdown(code ?? 0);
});
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// The process driver spawns us from the host; if the host dies, so do we.
if (flag("die-with-parent")) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) shutdown(0);
  }, 3000).unref();
}
