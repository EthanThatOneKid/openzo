// openzo's sandbox backend: real bash on a real directory.
//
// eve's local ladder is Docker → microsandbox → just-bash. On a VPS running
// openzo, the user's whole runtime already lives inside a gVisor container,
// so a second container per session buys nothing and just-bash (a JS shell
// with no real binaries) costs everything. This backend runs commands on the
// host the agent process is on, rooted at OPENZO_WORKSPACE:
//
//   gvisor driver  → OPENZO_WORKSPACE=/workspace inside the user's runsc
//                    container; gVisor is the isolation boundary.
//   process driver → OPENZO_WORKSPACE=<data>/users/<name>/workspace on the
//                    host; no isolation — single-user / trusted local use.
//
// Every durable session of one user shares the same workspace (Zo's model:
// one persistent home across conversations). eve's nominal namespace is
// /workspace; when the real root differs, absolute /workspace paths in file
// operations and commands are mapped onto it.
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxSession,
} from "eve/sandbox";

const NOMINAL = "/workspace";
const BACKEND_NAME = "openzo-host";

export function workspaceRoot(): string {
  return resolve(process.env.OPENZO_WORKSPACE?.trim() || NOMINAL);
}

function realPath(root: string, p: string): string {
  if (p === NOMINAL || p.startsWith(`${NOMINAL}/`)) return join(root, p.slice(NOMINAL.length));
  if (isAbsolute(p)) return p;
  return join(root, p);
}

// Map `/workspace` tokens in a shell command onto the real root. Only a
// token-boundary match is rewritten, so `/workspace-old` or `foo/workspace`
// are left alone. A no-op inside the container where the root IS /workspace.
function rewriteCommand(root: string, command: string): string {
  if (root === NOMINAL) return command;
  return command.replace(/(^|[\s'"=:(;|&<>])\/workspace(?=$|[\s/'");|&<>])/g, `$1${root}`);
}

const children = new Set<ChildProcess>();

function shell(root: string, options: { command: string; workingDirectory?: string; env?: Record<string, string> }) {
  const cwd = options.workingDirectory ? realPath(root, options.workingDirectory) : root;
  const child = spawn("bash", ["-lc", rewriteCommand(root, options.command)], {
    cwd,
    env: { ...process.env, ...options.env, OPENZO_WORKSPACE: root, PWD: cwd },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  const exited = new Promise<number>((done) => {
    child.on("error", () => done(127));
    child.on("close", (code, signal) => {
      children.delete(child);
      done(code ?? (signal ? 128 + 9 : 1));
    });
  });
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  return { child, exited, kill };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

function createSession(root: string, id: string): SandboxSession {
  return {
    id,
    resolvePath: (p: string) => (p.startsWith("/") ? p : `${NOMINAL}/${p}`.replace(/\/+$/, "")),
    async setNetworkPolicy(policy) {
      if (policy === "allow-all") return;
      throw new Error(
        "openzo-host sandbox: egress policy is enforced by the container runtime (gVisor network), not per call",
      );
    },
    async run(options) {
      const { child, exited, kill } = shell(root, options);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (b: Buffer) => out.push(b));
      child.stderr?.on("data", (b: Buffer) => err.push(b));
      const onAbort = () => kill();
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const exitCode = await exited;
      options.abortSignal?.removeEventListener("abort", onAbort);
      return {
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
    },
    async spawn(options) {
      const { child, exited, kill } = shell(root, options);
      options.abortSignal?.addEventListener("abort", kill, { once: true });
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        wait: async () => ({ exitCode: await exited }),
        kill: async () => kill(),
      };
    },
    async readFile({ path }) {
      const p = realPath(root, path);
      if (!(await exists(p))) return null;
      return Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
    },
    async readBinaryFile({ path }) {
      return readFile(realPath(root, path)).then(
        (b) => new Uint8Array(b),
        () => null,
      );
    },
    async readTextFile({ path, encoding, startLine, endLine }) {
      const text = await readFile(realPath(root, path), (encoding as BufferEncoding) ?? "utf8").catch(() => null);
      if (text === null || (startLine === undefined && endLine === undefined)) return text;
      const lines = text.split("\n");
      return lines.slice(Math.max(0, (startLine ?? 1) - 1), endLine ?? lines.length).join("\n");
    },
    async writeFile({ path, content }) {
      const p = realPath(root, path);
      await mkdir(dirname(p), { recursive: true });
      await pipeline(Readable.fromWeb(content as never), createWriteStream(p));
    },
    async writeBinaryFile({ path, content }) {
      const p = realPath(root, path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    },
    async writeTextFile({ path, content, encoding }) {
      const p = realPath(root, path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, (encoding as BufferEncoding) ?? "utf8");
    },
    async removePath({ path, force, recursive }) {
      await rm(realPath(root, path), { force: force ?? false, recursive: recursive ?? false });
    },
  } satisfies SandboxSession;
}

export function hostSandbox(): SandboxBackend {
  return {
    name: BACKEND_NAME,
    async prewarm({ bootstrap, seedFiles }) {
      const root = workspaceRoot();
      await mkdir(root, { recursive: true });
      for (const seed of seedFiles) {
        const p = realPath(root, seed.path);
        if (await exists(p)) continue;
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, seed.content);
      }
      if (bootstrap) {
        const session = createSession(root, "template");
        await bootstrap({ use: async () => session } as never);
      }
      return { reused: false };
    },
    async create({ sessionKey }) {
      const root = workspaceRoot();
      await mkdir(root, { recursive: true });
      const session = createSession(root, sessionKey);
      const handle: SandboxBackendHandle = {
        session,
        useSessionFn: async () => session,
        captureState: async () => ({ backendName: BACKEND_NAME, metadata: { root }, sessionKey }),
        shutdown: async () => {
          for (const child of children) {
            if (child.pid !== undefined) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }
          }
        },
      };
      return handle;
    },
  };
}

