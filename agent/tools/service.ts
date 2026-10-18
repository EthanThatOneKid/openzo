// Sites & services: the agent's handle on openzo's hosting (host/services.ts).
// Covers what Zo spreads over zo.space routes, Zo Sites and user services.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi } from "../lib/host-api";

export default defineTool({
  description: [
    "Host websites and long-running services from the user's workspace, with public URLs.",
    "Kinds: `static` serves a workspace folder as a website (index.html, clean URLs like /about → about.html, 404.html, `spa: true` for single-page apps).",
    "`process` runs `command` with bash in the sandbox and keeps it up (restarts on crash); it MUST listen on 0.0.0.0:$PORT (the PORT env var) — pass `port` only if the app cannot read $PORT.",
    "Every user has a static service named `space` rooted at /workspace/space — their personal site (Zo Space). Put pages there; for API routes run a `process` service.",
    "Actions: list, upsert (create or update; omitted fields keep their value), restart, logs, delete. Returns URLs: /s/<user>/<name>/ always, plus a subdomain and custom domains when configured.",
    "Sites behind the /s/<user>/<name>/ path must use relative asset URLs (or read the X-Forwarded-Prefix header). After creating a process service, check `logs` and fetch the URL to confirm it works.",
  ].join(" "),
  inputSchema: z.object({
    action: z.enum(["list", "upsert", "restart", "logs", "delete"]),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional().describe("Service name (lowercase, dashes). Required except for list."),
    kind: z.enum(["static", "process"]).optional(),
    root: z.string().optional().describe("static: folder to serve, relative to /workspace. process: working directory relative to /workspace."),
    command: z.string().optional().describe("process: shell command, e.g. `bun run server.ts` or `python3 -m http.server $PORT`."),
    port: z.number().int().min(1024).max(65535).nullable().optional(),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for a process service."),
    spa: z.boolean().optional(),
    public: z.boolean().optional().describe("true (default) = anyone with the link; false = only the owner, signed in."),
    enabled: z.boolean().optional(),
    domains: z.array(z.string()).optional().describe("Custom domains (the user must point DNS at the openzo server)."),
  }),
  async execute(input) {
    if (input.action === "list") return hostApi("GET", "/services");
    if (!input.name) throw new Error("name is required");
    return hostApi("POST", "/services", input);
  },
});
