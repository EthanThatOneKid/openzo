// Host configuration — every knob is an env var so the same binary runs a
// laptop (process driver, one user) and a VPS (gvisor driver, many users).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const env = (k: string, d?: string) => process.env[k]?.trim() || d;
const num = (k: string, d: number) => Number(env(k) ?? d);

export const ROOT = resolve(import.meta.dir, "..");
export const DATA = resolve(env("OPENZO_DATA", join(ROOT, "data"))!);
mkdirSync(join(DATA, "users"), { recursive: true });

// One secret signs host sessions' agent JWTs. Generated on first boot and kept
// in the data dir so restarts don't invalidate running runtimes.
function loadSecret(): string {
  const fromEnv = env("OPENZO_SECRET");
  if (fromEnv) return fromEnv;
  const p = join(DATA, "secret");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const s = randomBytes(32).toString("base64url");
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}

export type DriverName = "process" | "gvisor";
export type SignupMode = "open" | "invite" | "closed";

export const config = {
  port: num("OPENZO_PORT", 8080),
  host: env("OPENZO_HOST", "127.0.0.1")!,
  publicUrl: env("OPENZO_PUBLIC_URL"),
  secret: loadSecret(),
  driver: (env("OPENZO_DRIVER", "process") as DriverName),
  signup: (env("OPENZO_SIGNUP", "invite") as SignupMode),
  // Built agent server (eve build output). The process driver runs it with node.
  agentServer: resolve(env("OPENZO_AGENT_SERVER", join(ROOT, ".output/server/index.mjs"))!),
  nodeBin: env("OPENZO_NODE", "node")!,
  webDist: resolve(env("OPENZO_WEB_DIST", join(ROOT, "web/dist"))!),
  portBase: num("OPENZO_PORT_BASE", 25400),
  portSpan: num("OPENZO_PORT_SPAN", 1000),
  idleMinutes: num("OPENZO_IDLE_MINUTES", 30),
  maxRuntimes: num("OPENZO_MAX_RUNTIMES", 50),
  sessionDays: num("OPENZO_SESSION_DAYS", 30),
  // gvisor driver
  docker: env("OPENZO_DOCKER", "docker")!,
  image: env("OPENZO_AGENT_IMAGE", "openzo-agent:latest")!,
  ociRuntime: env("OPENZO_OCI_RUNTIME", "runsc")!,
  network: env("OPENZO_DOCKER_NETWORK", "openzo")!,
  memory: env("OPENZO_USER_MEMORY", "2g")!,
  cpus: env("OPENZO_USER_CPUS", "1")!,
  pids: num("OPENZO_USER_PIDS", 512),
  // Host-wide model defaults applied when a user has not chosen a lane.
  defaultLane: env("OPENZO_DEFAULT_LANE", "free")!,
  // SearXNG the host can reach (e.g. http://127.0.0.1:8888). Process-driver
  // runtimes use it directly; gVisor runtimes reach it only through the
  // internal listener below, the one host port their bridge may talk to.
  searxngUrl: env("OPENZO_SEARXNG_URL"),
  internalHost: env("OPENZO_INTERNAL_HOST"),
  internalPort: num("OPENZO_INTERNAL_PORT", 8091),
  trustProxy: env("OPENZO_TRUST_PROXY") === "1",
};

export function userDir(name: string) {
  return join(DATA, "users", name);
}
