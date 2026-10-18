// Message the user outside the chat — Zo's send_email_to_user /
// send_sms_to_user / Telegram / Discord, over whatever the user set up in
// openzo Settings → Channels (host/channels.ts).
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi } from "../lib/host-api";

export default defineTool({
  description: [
    "Send a message to the user (the person you work for) outside this chat: Telegram, email, Discord, Slack, ntfy push, SMS or a webhook — whichever they set up in Settings → Channels.",
    "Only send when the user asked for it, an automation's instructions say to, or something they asked you to watch for happened. Omit `channel` to use their preferred channel.",
    "Attach workspace files with `files` (paths under /workspace; Telegram, email and Discord carry them).",
  ].join(" "),
  inputSchema: z.object({
    text: z.string().min(1).max(20000).describe("The message body (plain text / light markdown)."),
    title: z.string().max(200).optional().describe("Subject line / heading."),
    channel: z.enum(["auto", "telegram", "email", "discord", "slack", "ntfy", "sms", "webhook"]).optional(),
    files: z.array(z.string()).max(10).optional().describe("Workspace file paths to attach, e.g. /workspace/report.pdf"),
  }),
  async execute(input) {
    return hostApi("POST", "/notify", input);
  },
});
