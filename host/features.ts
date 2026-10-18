// What a hosted Zo Computer has, and what openzo does with each. The UI reads
// this to render real pages for what works and an honest stub for what doesn't.
export type FeatureStatus = "working" | "partial" | "stub";

export interface Feature {
  id: string;
  name: string;
  status: FeatureStatus;
  detail: string;
}

export const FEATURES: Feature[] = [
  { id: "chat", name: "Chat with your agent", status: "working", detail: "eve agent with Zo's stdlib tools (bash, read, write, edit, glob, grep, tasks, webfetch, web search, look) and a fast subagent. Conversations persist and resume." },
  { id: "files", name: "Files", status: "working", detail: "Your persistent workspace: browse, upload, download, edit text, rename, delete. The agent works on the same files." },
  { id: "terminal", name: "Terminal", status: "working", detail: "A real shell in your workspace — on the host (process driver) or inside your gVisor container (gvisor driver)." },
  { id: "automations", name: "Automations", status: "working", detail: "Cron schedules that start a conversation with a prompt, created in the UI or by the agent. Results land in your conversation list and, optionally, on any channel." },
  { id: "models", name: "Bring your own model", status: "working", detail: "OpenAI, Anthropic, OpenRouter, Groq, Ollama, Vercel AI Gateway, any OpenAI-compatible endpoint, or the keyless free lane." },
  { id: "web-search", name: "Web search", status: "partial", detail: "SearXNG, Brave, Tavily or Exa when configured; DuckDuckGo otherwise (often blocked from datacenter IPs)." },
  { id: "persona", name: "Personas & rules", status: "working", detail: "Any number of personas (one active) and conditional rules, fetched at the start of every conversation. The agent saves rules itself when you ask it to remember something (manage_profile)." },
  { id: "multi-user", name: "Multiple users", status: "working", detail: "Accounts, invites, admin panel, one isolated runtime per user." },
  { id: "space", name: "Space (personal website)", status: "working", detail: "Every user has a Space: the workspace folder space/ served as a public site at /s/<user>/space/ (and <space>-<user>.<OPENZO_SITES_DOMAIN> with a wildcard domain). Pages are plain files; for API routes run a service." },
  { id: "sites", name: "Sites & services hosting", status: "working", detail: "Static sites and supervised long-running services (restart on crash, logs) from the workspace, reverse-proxied with websockets, public or owner-only, with custom domains and automatic HTTPS through Caddy on-demand TLS. The agent hosts things with its service tool." },
  { id: "integrations", name: "Integrations (Gmail, Calendar, Notion…)", status: "partial", detail: "Real OAuth with your own OAuth apps: Google (Gmail, Calendar, Drive, Sheets, Tasks), GitHub, Notion, Linear, Spotify, Slack, Microsoft (Outlook, OneDrive) and Discord, plus API-key connections for anything else. An admin registers each OAuth app once; the agent calls the APIs through the host, which holds the tokens. No Pipedream-style prebuilt actions — the agent uses the raw APIs." },
  { id: "channels", name: "Telegram, email, SMS, Discord, Slack, push", status: "working", detail: "Your own accounts instead of Zo's numbers: chat with your agent from a Telegram bot (two-way, long-polling, no public URL needed); messages and automation results to Telegram, email (admin SMTP), Discord/Slack webhooks, ntfy push, SMS via your Twilio number, or any webhook. Inbound email and SMS are not built." },
  { id: "skills", name: "Skills", status: "working", detail: "Skills/<slug>/SKILL.md in the workspace, listed to the agent at the start of every conversation; install from Zo's public skills registry on the Skills page." },
  { id: "api", name: "API & access tokens", status: "working", detail: "Personal access tokens and POST /api/ask (alias /zo/ask) with conversation_id and output_format, the same shape as Zo's API." },
  { id: "media", name: "Image, speech, transcription & video", status: "partial", detail: "generate_image, edit_image, generate_speech, transcribe_audio, transcribe_video and generate_video, configured in Settings → Media. Images: any OpenAI-compatible API, or keyless Pollinations (generate only, no edit). Speech: OpenAI-compatible, or local piper/espeak-ng. Transcription: OpenAI/Groq-compatible, or local faster-whisper. Video only with your own fal.ai or Replicate key — there is no free video lane." },
  { id: "browser", name: "Zo's browser", status: "working", detail: "A persistent headless Chromium per user (profile in your workspace). Watch and drive it on the Browser page — live screenshots, click, type, tabs — and log into sites there: the agent's browser tool uses the same session. Stops after 20 min idle. Screenshot-based view, not a streamed video; no file downloads or extensions." },
  { id: "maps-x", name: "Maps & X search", status: "partial", detail: "maps_search uses keyless OpenStreetMap (names, addresses, coordinates), or Google Places with GOOGLE_MAPS_API_KEY in your secrets. x_search needs your own X_BEARER_TOKEN — X has no keyless search." },
  { id: "billing", name: "Credits & billing", status: "stub", detail: "None — you pay your model provider directly." },
];
