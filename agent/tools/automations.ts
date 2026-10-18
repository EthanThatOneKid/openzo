// Scheduled automations (host/automations.ts) — Zo's create_automation /
// edit_automation / delete_automation / list_automations.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi } from "../lib/host-api";

export default defineTool({
  description: [
    "List, create, update, delete or run the user's scheduled automations. An automation starts a fresh conversation with `prompt` on a cron schedule (5 fields: minute hour day-of-month month day-of-week, or @hourly/@daily/@weekly/@monthly) in time zone `tz` (IANA, e.g. Asia/Singapore).",
    "Write the prompt self-contained: the run has no memory of this chat. `deliver` sends the run's final answer to the user: '' = only the conversation list, 'auto' = preferred channel, or telegram/email/discord/slack/ntfy/sms/webhook.",
    "Each run is a full agent turn and costs model usage; confirm with the user before schedules more frequent than hourly.",
  ].join(" "),
  inputSchema: z.object({
    action: z.enum(["list", "create", "update", "delete", "run"]),
    id: z.number().int().optional().describe("Automation id (update/delete/run)."),
    name: z.string().max(120).optional(),
    cron: z.string().optional(),
    tz: z.string().optional(),
    prompt: z.string().max(20000).optional(),
    enabled: z.boolean().optional(),
    deliver: z.string().optional(),
  }),
  async execute(input) {
    if (input.action === "list") return hostApi("GET", "/automations");
    return hostApi("POST", "/automations", input);
  },
});
