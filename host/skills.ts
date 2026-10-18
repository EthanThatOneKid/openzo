// Skills — Zo's packaged, repeatable workflows (agentskills.io format): a
// folder under the user's workspace `Skills/<slug>/` with a SKILL.md whose
// frontmatter carries name + description. The agent sees the list at the
// start of every conversation (agent/instructions/zz-skills.ts) and reads a
// skill's SKILL.md when a request matches. Skills install from Zo's public
// registry (the same manifest hosted Zo uses) or are written by the agent.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { audit } from "./db";
import { HttpError, body, json, requireUser, route } from "./http";
import { paths } from "./runtime";

const REGISTRY = process.env.OPENZO_SKILLS_REGISTRY ?? "https://raw.githubusercontent.com/zocomputer/skills/main/manifest.json";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      out[key] = kv[2]!.replace(/^["'](.*)["']$/, "$1").trim();
    } else if (key && /^\s+\S/.test(line) && !/^\s+[\w-]+:/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

export function listSkills(user: string) {
  const dir = join(paths(user).workspace, "Skills");
  if (!existsSync(dir)) return [];
  const out: { slug: string; name: string; description: string; path: string }[] = [];
  for (const slug of readdirSync(dir).sort()) {
    const md = join(dir, slug, "SKILL.md");
    if (!existsSync(md)) continue;
    const fm = parseFrontmatter(readFileSync(md, "utf8"));
    out.push({ slug, name: fm.name || slug, description: fm.description || "", path: `/Skills/${slug}/SKILL.md` });
  }
  return out;
}

let cache: { at: number; data: any } | null = null;
async function registry() {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `skills registry answered ${res.status}`);
  cache = { at: Date.now(), data: await res.json() };
  return cache.data;
}

route("GET", "/api/skills", ({ req }) => json({ skills: listSkills(requireUser(req).name) }));

route("GET", "/api/skills/registry", async ({ req }) => {
  requireUser(req);
  const r = await registry();
  return json({
    skills: (r.skills ?? []).map((s: any) => ({ slug: s.slug, name: s.metadata?.["display-name"] ?? s.name, description: s.description, category: s.metadata?.category ?? "", author: s.metadata?.author ?? "", homepage: s.metadata?.homepage ?? null })),
  });
});

route("POST", "/api/skills/install", async ({ req }) => {
  const u = requireUser(req);
  const b = await body<{ slug?: string }>(req);
  const slug = String(b.slug ?? "");
  if (!SLUG.test(slug)) throw new HttpError(400, "bad skill slug");
  const r = await registry();
  const entry = (r.skills ?? []).find((s: any) => s.slug === slug);
  if (!entry) throw new HttpError(404, "no such skill in the registry");
  const skillsDir = join(paths(u.name).workspace, "Skills");
  mkdirSync(skillsDir, { recursive: true });
  let dest = join(skillsDir, slug);
  for (let i = 2; existsSync(dest); i++) dest = join(skillsDir, `${slug}-${i}`);
  const tmp = mkdtempSync(join(tmpdir(), "openzo-skill-"));
  try {
    const tgz = await fetch(r.tarball_url, { signal: AbortSignal.timeout(120_000) });
    if (!tgz.ok || !tgz.body) throw new HttpError(502, `registry tarball answered ${tgz.status}`);
    await Bun.write(join(tmp, "a.tgz"), new Uint8Array(await tgz.arrayBuffer()));
    const member = `${r.archive_root}/${entry.path}`;
    const strip = member.split("/").length;
    const proc = Bun.spawn(["tar", "-xzf", join(tmp, "a.tgz"), "-C", tmp, member], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new HttpError(502, `extract failed: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
    const src = join(tmp, member);
    if (!existsSync(join(src, "SKILL.md"))) throw new HttpError(502, "skill has no SKILL.md");
    const cp = Bun.spawn(["cp", "-r", src, dest]);
    if ((await cp.exited) !== 0) throw new HttpError(500, "copy failed");
    void strip;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  audit(u.id, "skill.install", { slug });
  return json({ ok: true, installed: dest.slice(dest.lastIndexOf(sep) + 1) });
});

route("DELETE", "/api/skills/:slug", ({ req, params }) => {
  const u = requireUser(req);
  const slug = params[0]!;
  if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, "bad skill slug");
  const root = join(paths(u.name).workspace, "Skills");
  const dir = resolve(root, slug);
  if (!dir.startsWith(root + sep) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(404, "no such skill");
  rmSync(dir, { recursive: true, force: true });
  audit(u.id, "skill.delete", { slug });
  return json({ ok: true });
});
