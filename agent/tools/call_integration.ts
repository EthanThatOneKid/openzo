// An HTTP request made on one of the user's connected accounts. The host checks
// the URL against the connection's API host allowlist, adds the credential
// (refreshing expired OAuth tokens) and returns the response. The agent never
// sees a token.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { hostApi, hostApiAvailable } from "../lib/host-api";

export default defineTool({
  description: `Call a connected service's API as the user. Pick the connection by numeric id (from list_connections) or by provider name ("google", "github", …) when there is only one account. Authentication is added for you — never send an Authorization header. Only https URLs on the connection's API hosts are allowed.

Common endpoints:
- Gmail: GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=10, then GET .../messages/{id}?format=metadata|full; send: POST .../messages/send {raw: base64url RFC 2822}.
- Google Calendar: GET https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=<RFC3339>&singleEvents=true&orderBy=startTime; POST same path to create.
- Google Drive: GET https://www.googleapis.com/drive/v3/files?q=name contains 'x'&fields=files(id,name,mimeType); download GET .../files/{id}?alt=media with save_to; Google Docs: GET .../files/{id}/export?mimeType=text/plain.
- Google Sheets: GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/Sheet1!A1:D20. Tasks: https://tasks.googleapis.com/tasks/v1/users/@me/lists.
- GitHub: https://api.github.com (/user/repos, /repos/{owner}/{repo}/issues, /search/issues?q=...), GraphQL POST https://api.github.com/graphql.
- Notion: POST https://api.notion.com/v1/search {query}; GET /v1/blocks/{id}/children; POST /v1/databases/{id}/query (Notion-Version is added for you).
- Linear: POST https://api.linear.app/graphql {query, variables}.
- Spotify: https://api.spotify.com/v1 (/me/player/currently-playing, /me/playlists, /search?q=&type=track).
- Slack: https://slack.com/api/<method> (conversations.list, conversations.history?channel=, chat.postMessage {channel,text}); check "ok" in the body.
- Microsoft Graph: https://graph.microsoft.com/v1.0 (/me/messages, /me/sendMail, /me/events, /me/drive/root/children).
- Discord: https://discord.com/api/v10/users/@me, /users/@me/guilds.
- API-key connections: any path under their apiBase.

Bodies: pass an object for JSON. Text/JSON responses come back as "body" (cut at 2 MB); binary as base64 — prefer save_to (a /workspace path) for files.`,
  inputSchema: z.object({
    connection: z.union([z.number().int(), z.string().min(1)]).describe("Connection id, or provider/account name when unambiguous."),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("HTTP method (default GET)."),
    url: z.string().url().describe("Absolute https URL on one of the connection's API hosts."),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters to add to the URL."),
    headers: z.record(z.string(), z.string()).optional().describe("Extra request headers (no Authorization)."),
    body: z.unknown().optional().describe("Request body: an object is sent as JSON, a string as-is."),
    save_to: z.string().optional().describe("Write the response body to this workspace path (e.g. /workspace/downloads/report.pdf) instead of returning it."),
  }),
  async execute(input) {
    if (!hostApiAvailable()) return { error: "integrations need the openzo host" };
    try {
      return await hostApi("POST", "/integrations/request", input, 60_000);
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
});
