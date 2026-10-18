// The user's connected accounts (Google, GitHub, Notion, Linear, Spotify,
// Slack, Microsoft, Discord, API-key services). Credentials stay on the openzo
// host; call_integration makes requests through it.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi, hostApiAvailable } from "../lib/host-api";

export default defineTool({
  description:
    "List the user's connected integrations (OAuth accounts and API-key services): id, provider, account label, granted scopes, the API hosts each connection may call, and a short API reference. Call this before call_integration. If something the user wants is not connected, tell them to connect it on the Integrations page.",
  inputSchema: z.object({}),
  async execute() {
    if (!hostApiAvailable()) return { error: "integrations need the openzo host" };
    return hostApi("GET", "/integrations");
  },
});
