// Personas and rules (host/profile.ts) — Zo's create_rule / edit_rule /
// create_persona family in one tool.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi } from "../lib/host-api";

export default defineTool({
  description: [
    "Read or change the user's personas and standing rules. Rules are instructions (optionally with a condition) applied to every future conversation — use them when the user says 'remember…', 'always…', 'never…'.",
    "Personas are named prompts; one can be active. Changes apply from the next conversation. Action `list` returns everything with ids.",
  ].join(" "),
  inputSchema: z.object({
    action: z.enum(["list", "create", "update", "delete", "activate"]),
    kind: z.enum(["rule", "persona"]).optional(),
    id: z.number().int().optional(),
    instruction: z.string().max(4000).optional().describe("rule: what to do"),
    condition: z.string().max(1000).optional().describe("rule: when it applies (empty = always)"),
    enabled: z.boolean().optional(),
    name: z.string().max(80).optional().describe("persona name"),
    prompt: z.string().max(20000).optional().describe("persona prompt"),
  }),
  async execute(input) {
    if (input.action === "list") return hostApi("GET", "/profile");
    if (!input.kind) throw new Error("kind is required");
    return hostApi("POST", "/profile", input);
  },
});
