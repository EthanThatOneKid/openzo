// Per-user agent runtimes. One eve server per user, started on demand, reaped
// when idle. Two drivers behind one interface:
//
//   process  node .output/server/index.mjs on the host, one port per user.
//            No isolation between users — single-user or trusted use.
//   gvisor   docker run --runtime=runsc openzo-agent, one container per user,
//            workspace + state bind-mounted, published on 127.0.0.1 only.
//            gVisor's user-space kernel is the boundary between tenants.
import { mkdirSync, openSync, writeFileSync, closeSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { config, userDir } from "./config";
import { audit, users, type User } from "./db";
import { runtimeEnv } from "./settings";
import { internalBase, runtimeToken } from "./internal";

export type RuntimeState = "stopped" | "starting" | "running" | "error";

interface Runtime {
  user: string;
  state: RuntimeState;
  url?: string;
  port?: number;
  pid?: number;
  proc?: ReturnType<typeof Bun.spawn>;
  startedAt?: number;
  lastUsed: number;
  error?: string;
  starting?: Promise<string>;
}

const runtimes = new Map<string, Runtime>();
const usedPorts = new Set<number>();
export const releasePort = (port: number) => usedPorts.delete(port);

// Other modules (services, browser) register a check here so the reaper never
// stops a container that is hosting something the user expects to stay up.
export const keepAliveChecks: ((name: string) => boolean)[] = [];

export function paths(name: string) {
  const root = userDir(name);
  return { root, workspace: join(root, "workspace"), state: join(root, "state"), log: join(root, "runtime.log") };
}

export function ensureDirs(name: string) {
  const p = paths(name);
  mkdirSync(p.workspace, { recursive: true });
  mkdirSync(p.state, { recursive: true });
  return p;
}

// A port counts as free only if nothing answers on it AND we can bind it:
// under gVisor a bind can succeed on a port another process already serves.
export async function portFree(port: number): Promise<boolean> {
  const answered = await new Promise<boolean>((done) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(300);
    sock.once("connect", () => (sock.destroy(), done(true)));
    sock.once("timeout", () => (sock.destroy(), done(false)));
    sock.once("error", () => done(false));
  });
  if (answered) return false;
  return new Promise<boolean>((done) => {
    const srv = createServer();
    srv.once("error", () => done(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
  });
}

export async function allocatePort(): Promise<number> {
  for (let i = 0; i < config.portSpan; i++) {
    const port = config.portBase + i;
    if (usedPorts.has(port)) continue;
    usedPorts.add(port);
    if (await portFree(port)) return port;
    usedPorts.delete(port);
  }
  throw new Error("no free runtime ports");
}

function rotateLog(log: string) {
  if (existsSync(log) && statSync(log).size > 0) renameSync(log, `${log}.1`);
}

async function waitHealthy(url: string, timeoutMs = 60_000, alive?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (alive && !alive()) throw new Error("runtime exited during startup (see runtime log)");
    try {
      const res = await fetch(`${url}/eve/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastErr = `health ${res.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    await Bun.sleep(400);
  }
  throw new Error(`runtime did not become healthy: ${lastErr}`);
}

function baseEnv(user: User, containerized: boolean): Record<string, string> {
  return {
    ...runtimeEnv(user, { containerized }),
    OPENZO_AGENT_SECRET: config.secret,
    OPENZO_HOST_API: internalBase(containerized),
    OPENZO_RUNTIME_TOKEN: `${user.name}.${runtimeToken(user.name)}`,
    EVE_LOG_LEVEL: process.env.EVE_LOG_LEVEL ?? "warn",
  };
}

// ---------------------------------------------------------------- process

async function startProcess(user: User, rt: Runtime): Promise<string> {
  const p = ensureDirs(user.name);
  const port = await allocatePort();
  rotateLog(p.log);
  const fd = openSync(p.log, "a");
  const passthrough: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"]) {
    if (process.env[k]) passthrough[k] = process.env[k]!;
  }
  const proc = Bun.spawn([config.nodeBin, config.agentServer], {
    cwd: p.state,
    env: {
      ...passthrough,
      ...baseEnv(user, false),
      HOME: p.workspace,
      OPENZO_WORKSPACE: p.workspace,
      PORT: String(port),
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
      NODE_ENV: "production",
    },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    onExit(_p, code) {
      closeSync(fd);
      usedPorts.delete(port);
      if (runtimes.get(user.name) === rt && rt.state !== "stopped") {
        rt.state = code === 0 ? "stopped" : "error";
        rt.error = code === 0 ? undefined : `exited with code ${code}`;
        rt.url = undefined;
      }
    },
  });
  rt.proc = proc;
  rt.pid = proc.pid;
  rt.port = port;
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(url, 60_000, () => proc.exitCode === null);
  return url;
}

// ---------------------------------------------------------------- gvisor

async function docker(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn([config.docker, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`docker ${args[0]}: ${err.trim() || out.trim()}`);
  return code === 0 ? out.trim() : "";
}

export const containerName = (name: string) => `openzo-u-${name}`;

async function startContainer(user: User, rt: Runtime): Promise<string> {
  const p = ensureDirs(user.name);
  const name = containerName(user.name);
  if (!(await docker(["network", "inspect", "-f", "{{.Name}}", config.network], { allowFail: true }))) {
    await docker(["network", "create", config.network], { allowFail: true });
  }
  const status = await docker(["inspect", "-f", "{{.State.Status}}", name], { allowFail: true });
  if (status === "running") {
    // already up (host restarted) — just find its port
  } else if (status) {
    await docker(["start", name]);
  } else {
    // Env goes through a 0600 file in the user's state dir so keys never show
    // up in `ps` or `docker inspect` argv.
    const envFile = join(p.state, ".runtime.env");
    const env = baseEnv(user, true);
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}`)
        .join("\n"),
      { mode: 0o600 },
    );
    await docker([
      "run", "-d",
      "--name", name,
      "--runtime", config.ociRuntime,
      "--network", config.network,
      "--hostname", user.name,
      "--memory", config.memory,
      "--cpus", config.cpus,
      "--pids-limit", String(config.pids),
      "--security-opt", "no-new-privileges",
      "--cap-drop", "NET_RAW",
      // host.docker.internal points at the openzo bridge gateway, the only
      // host address the firewall lets containers reach (see deploy/firewall.sh).
      "--add-host", `host.docker.internal:${config.internalHost ?? "host-gateway"}`,
      "--label", `openzo.user=${user.name}`,
      "-p", "127.0.0.1::3000",
      "-v", `${p.workspace}:/workspace`,
      "-v", `${p.state}:/state`,
      "--env-file", envFile,
      config.image,
    ]);
  }
  const mapping = await docker(["port", name, "3000/tcp"]);
  const hostPort = mapping.split("\n")[0]!.split(":").pop();
  const url = `http://127.0.0.1:${hostPort}`;
  await waitHealthy(url, 90_000);
  return url;
}

// ---------------------------------------------------------------- manager

function entry(name: string): Runtime {
  let rt = runtimes.get(name);
  if (!rt) {
    rt = { user: name, state: "stopped", lastUsed: Date.now() };
    runtimes.set(name, rt);
  }
  return rt;
}

export async function ensureRuntime(user: User): Promise<string> {
  const rt = entry(user.name);
  rt.lastUsed = Date.now();
  if (rt.state === "running" && rt.url) return rt.url;
  if (rt.starting) return rt.starting;
  const running = [...runtimes.values()].filter((r) => r.state === "running" || r.state === "starting").length;
  if (running >= config.maxRuntimes) {
    await reapIdle(0, 1);
  }
  rt.state = "starting";
  rt.error = undefined;
  rt.starting = (config.driver === "gvisor" ? startContainer(user, rt) : startProcess(user, rt))
    .then((url) => {
      rt.url = url;
      rt.state = "running";
      rt.startedAt = Date.now();
      audit(user.id, "runtime.start", { driver: config.driver });
      return url;
    })
    .catch((e) => {
      rt.state = "error";
      rt.error = String(e?.message ?? e);
      rt.proc?.kill();
      throw e;
    })
    .finally(() => {
      rt.starting = undefined;
    });
  return rt.starting;
}

export function touch(name: string) {
  const rt = runtimes.get(name);
  if (rt) rt.lastUsed = Date.now();
}

export async function stopRuntime(name: string, opts: { remove?: boolean } = {}) {
  const rt = runtimes.get(name);
  if (rt) rt.state = "stopped";
  if (config.driver === "gvisor") {
    const c = containerName(name);
    // A settings change must recreate the container (env is fixed at create).
    await docker(opts.remove ? ["rm", "-f", c] : ["stop", "-t", "10", c], { allowFail: true });
  } else if (rt?.proc && rt.proc.exitCode === null) {
    rt.proc.kill("SIGTERM");
    const killed = await Promise.race([rt.proc.exited.then(() => true), Bun.sleep(8000).then(() => false)]);
    if (!killed) rt.proc.kill("SIGKILL");
  }
  if (rt) {
    rt.url = undefined;
    rt.proc = undefined;
  }
}

export async function restartRuntime(user: User) {
  await stopRuntime(user.name, { remove: true });
}

export function runtimeStatus(name: string) {
  const rt = runtimes.get(name);
  return {
    state: rt?.state ?? "stopped",
    driver: config.driver,
    startedAt: rt?.startedAt ?? null,
    lastUsed: rt?.lastUsed ?? null,
    error: rt?.error ?? null,
  };
}

export function allRuntimes() {
  return [...runtimes.values()].map((r) => ({ user: r.user, ...runtimeStatus(r.user) }));
}

async function reapIdle(idleMs = config.idleMinutes * 60_000, limit = Infinity) {
  const candidates = [...runtimes.values()]
    .filter((r) => r.state === "running" && Date.now() - r.lastUsed >= idleMs)
    .filter((r) => !(config.driver === "gvisor" && keepAliveChecks.some((k) => k(r.user))))
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, limit);
  for (const r of candidates) {
    await stopRuntime(r.user);
    const u = users.byName(r.user);
    audit(u?.id ?? null, "runtime.idle-stop", { user: r.user });
  }
}

setInterval(() => void reapIdle().catch(() => {}), 60_000).unref?.();

export async function shutdownAll() {
  await Promise.all([...runtimes.keys()].map((n) => stopRuntime(n)));
}

export async function driverCheck(): Promise<{ ok: boolean; detail: string }> {
  if (config.driver === "process") {
    return existsSync(config.agentServer)
      ? { ok: true, detail: `process driver, agent at ${config.agentServer}` }
      : { ok: false, detail: `agent build missing: ${config.agentServer} (run npm run build)` };
  }
  try {
    const info = await docker(["info", "--format", "{{json .Runtimes}}"]);
    if (!info.includes(config.ociRuntime)) return { ok: false, detail: `docker has no '${config.ociRuntime}' runtime registered` };
    const img = await docker(["image", "inspect", "-f", "{{.Id}}", config.image], { allowFail: true });
    if (!img) return { ok: false, detail: `image ${config.image} not built (deploy/build-image.sh)` };
    return { ok: true, detail: `gvisor driver, runtime ${config.ociRuntime}, image ${config.image}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Terminal command for a user: a login shell in their workspace, on the host
// (process driver) or inside their container (gvisor driver).
export function shellCommand(name: string): { cmd: string[]; cwd?: string; env?: Record<string, string> } {
  if (config.driver === "gvisor") {
    return { cmd: [config.docker, "exec", "-it", "-w", "/workspace", "-e", "TERM=xterm-256color", containerName(name), "bash", "-l"] };
  }
  const p = ensureDirs(name);
  return { cmd: ["bash", "-l"], cwd: p.workspace, env: { HOME: p.workspace, TERM: "xterm-256color" } };
}
