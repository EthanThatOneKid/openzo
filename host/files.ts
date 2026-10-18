// Workspace file API. Every path is resolved inside the user's workspace and
// re-checked after realpath, so `..` and symlinks cannot escape it.
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export class FileError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function inside(root: string, rel: string): Promise<string> {
  const clean = (rel || "/").replace(/\\/g, "/");
  const target = resolve(root, `.${clean.startsWith("/") ? clean : `/${clean}`}`);
  if (target !== root && !target.startsWith(root + sep)) throw new FileError(400, "path escapes workspace");
  // Resolve symlinks on the deepest existing ancestor.
  let probe = target;
  while (probe !== root) {
    try {
      const real = await realpath(probe);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new FileError(400, "path escapes workspace");
      break;
    } catch (e) {
      if (e instanceof FileError) throw e;
      probe = dirname(probe);
    }
  }
  return target;
}

export interface Entry {
  name: string;
  path: string;
  type: "file" | "dir" | "link";
  size: number;
  mtime: number;
}

export async function list(root: string, rel: string, showHidden = false): Promise<Entry[]> {
  const dir = await inside(root, rel);
  const names = await readdir(dir).catch(() => {
    throw new FileError(404, "not a directory");
  });
  const out: Entry[] = [];
  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = await lstat(full).catch(() => null);
    if (!st) continue;
    out.push({
      name,
      path: `/${relative(root, full).split(sep).join("/")}`,
      type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file",
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export async function fileFor(root: string, rel: string) {
  const p = await inside(root, rel);
  const st = await stat(p).catch(() => null);
  if (!st || !st.isFile()) throw new FileError(404, "file not found");
  return { path: p, size: st.size, name: basename(p) };
}

export async function write(root: string, rel: string, body: Blob | string) {
  const p = await inside(root, rel);
  if (p === root) throw new FileError(400, "cannot write the workspace root");
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, typeof body === "string" ? body : new Uint8Array(await body.arrayBuffer()));
}

export async function makeDir(root: string, rel: string) {
  await mkdir(await inside(root, rel), { recursive: true });
}

export async function move(root: string, from: string, to: string) {
  const a = await inside(root, from);
  const b = await inside(root, to);
  if (a === root || b === root) throw new FileError(400, "cannot move the workspace root");
  await mkdir(dirname(b), { recursive: true });
  await rename(a, b);
}

export async function remove(root: string, rel: string) {
  const p = await inside(root, rel);
  if (p === root) throw new FileError(400, "cannot delete the workspace root");
  await rm(p, { recursive: true, force: true });
}

export async function usage(root: string): Promise<number> {
  const proc = Bun.spawn(["du", "-sb", root], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return Number(out.split(/\s/)[0]) || 0;
}
