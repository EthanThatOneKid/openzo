// Skills in the user's workspace (Skills/<slug>/SKILL.md), listed at the start
// of each conversation so the agent knows what packaged workflows exist —
// Zo's model. The bodies are read on demand, never inlined.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { workspaceRoot } from "../lib/host-sandbox";

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  let key = "";
  for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[(key = kv[1]!)] = kv[2]!.replace(/^["'](.*)["']$/, "$1").trim();
    else if (key && /^\s+\S/.test(line) && !/^\s+[\w-]+:/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

export default defineDynamic({
  events: {
    "session.started": () => {
      const dir = join(workspaceRoot(), "Skills");
      const lines: string[] = [];
      if (existsSync(dir)) {
        for (const slug of readdirSync(dir).sort()) {
          const md = join(dir, slug, "SKILL.md");
          if (!existsSync(md)) continue;
          const fm = frontmatter(readFileSync(md, "utf8"));
          lines.push(`- **${fm.name || slug}** — ${(fm.description || "").slice(0, 300)} (\`/workspace/Skills/${slug}/SKILL.md\`)`);
          if (lines.length >= 60) break;
        }
      }
      const body = [
        "## Skills",
        "",
        "Skills are packaged workflows in `/workspace/Skills/<slug>/` (SKILL.md + optional scripts/, references/, assets/), in the agentskills.io format.",
        "When a request matches a skill, read its SKILL.md first and follow it. To create a skill, write `/workspace/Skills/<slug>/SKILL.md` with frontmatter `name` (= slug) and `description`.",
        "",
        lines.length ? `Installed skills:\n\n${lines.join("\n")}` : "No skills are installed yet.",
      ].join("\n");
      return defineInstructions({ markdown: body });
    },
  },
});
