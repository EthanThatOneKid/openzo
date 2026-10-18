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
  { id: "automations", name: "Automations", status: "working", detail: "Cron schedules that start a conversation with a prompt. Results land in your conversation list." },
  { id: "models", name: "Bring your own model", status: "working", detail: "OpenAI, Anthropic, OpenRouter, Groq, Ollama, Vercel AI Gateway, any OpenAI-compatible endpoint, or the keyless free lane." },
  { id: "web-search", name: "Web search", status: "partial", detail: "SearXNG, Brave, Tavily or Exa when configured; DuckDuckGo otherwise (often blocked from datacenter IPs)." },
  { id: "persona", name: "Persona & rules", status: "working", detail: "Custom instructions added to every conversation, set in Settings." },
  { id: "multi-user", name: "Multiple users", status: "working", detail: "Accounts, invites, admin panel, one isolated runtime per user." },
  { id: "space", name: "Zo Space (personal website)", status: "stub", detail: "Zo's managed hosting edge is closed. Ask the agent to build a site in your workspace and serve it from the terminal, or put it behind your own reverse proxy." },
  { id: "sites", name: "Sites & services hosting", status: "stub", detail: "No public URL provisioning or custom domains. Services can run inside your runtime but are not exposed publicly." },
  { id: "integrations", name: "Integrations (Gmail, Calendar, Notion…)", status: "stub", detail: "Zo's integrations ride Pipedream OAuth on Zo's account. Add your own API keys as secrets in Settings and have the agent call the APIs directly." },
  { id: "channels", name: "SMS, email, Telegram, Discord", status: "stub", detail: "Zo-operated phone numbers and inboxes are not available. eve ships Discord/Telegram channels; wiring them needs bot tokens and is not built yet." },
  { id: "media", name: "Image, video & speech generation", status: "stub", detail: "These tools run on Zo's metered media gateway. They return with OPENZO_CLOUD_TOOLS on a Zo-protocol gateway (see the guide)." },
  { id: "browser", name: "Zo's browser", status: "stub", detail: "No hosted browser sessions. The agent can install and drive a headless browser inside its runtime." },
  { id: "billing", name: "Credits & billing", status: "stub", detail: "None — you pay your model provider directly." },
];
