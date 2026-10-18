# openzo guide

openzo is a self-hosted Zo Computer: a personal AI agent with a real shell, a persistent workspace, a terminal and scheduled automations, served from your own machine to one person or a whole team. It is assembled from the open parts of Zo's stack — **eve** (the agent framework Zo's agent layer is built on) and **@zocomputer/agent-sdk** (Zo's own tool library) — plus a control plane written for openzo that does what Zo's closed cloud does: accounts, one isolated runtime per user, files, terminal, automations and an admin panel.

- [1. What you get](#1-what-you-get)
- [2. Run it locally](#2-run-it-locally)
- [3. Use it](#3-use-it)
- [4. Host it on a VPS (multi-user, gVisor)](#4-host-it-on-a-vps-multi-user-gvisor)
- [5. Configuration reference](#5-configuration-reference)
- [6. Models](#6-models)
- [7. Security model](#7-security-model)
- [8. Operating it](#8-operating-it)
- [9. What is stubbed, and why](#9-what-is-stubbed-and-why)
- [10. Architecture](#10-architecture)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. What you get

| Feature | Status |
|---|---|
| Chat with an agent that runs bash, reads/writes/edits files, searches and fetches the web, looks at images, delegates to a fast subagent | working |
| Persistent per-user workspace, browsable in the Files page (upload, download, edit, rename, delete) | working |
| Terminal in your workspace (a real PTY over a websocket) | working |
| Automations: cron + prompt, created by you or the agent; results in your conversation list and optionally on any channel | working |
| Conversations that persist and resume, with full history replay | working |
| Bring your own model: OpenAI, Anthropic, OpenRouter, Groq, Ollama, Vercel AI Gateway, any OpenAI-compatible server, or a keyless free lane | working |
| Personas (several, one active), conditional rules the agent can save itself, and secrets (env vars for the agent) | working |
| **Space & sites**: a personal site per user, static sites and supervised services from the workspace, public or private, custom domains with automatic HTTPS | working |
| **Channels**: chat with your agent from Telegram; messages and automation results to Telegram, email, Discord, Slack, ntfy push, SMS (your Twilio) or any webhook | working |
| **Skills**: `Skills/<slug>/SKILL.md` packages, install from Zo's public registry | working |
| **API**: personal access tokens and `POST /api/ask` (alias `/zo/ask`), the shape of Zo's API | working |
| Maps (OpenStreetMap keyless, Google Places with a key) and X search (your X API token) | working with the noted limits |
| Multiple users: setup wizard, invites, admin panel, audit log | working |
| One gVisor container per user on a VPS | built and tested against a recording fake `docker`; see §4 |
| Web search | SearXNG / Brave / Tavily / Exa; DuckDuckGo fallback |
| Media: generate/edit images, text-to-speech, transcribe audio and video, generate video | working (images free via Pollinations; edit and video need your own provider key) — see *Media* in §3 |
| Browser: a persistent Chromium per user that you and the agent share (log in once, the agent browses as you) | working |
| Integrations: Google (Gmail, Calendar, Drive, Sheets, Tasks), GitHub, Notion, Linear, Spotify, Slack, Microsoft (Outlook, OneDrive), Discord over real OAuth with your own OAuth apps, plus API-key connections | working (raw APIs, no prebuilt actions) |
| Inbound email/SMS, Zo's 1000-app Pipedream catalogue, credits | not here — see §9 |

## 2. Run it locally

You need **Node 24+** and **Bun 1.3+**.

```bash
# get the code: the release tarball from the openzo site, or your own git copy
tar xzf openzo-0.3.0.tar.gz && cd openzo
./start-local.sh
```

`start-local.sh` installs dependencies, builds the agent server (`eve build`) and the web app, then starts the host on **http://127.0.0.1:8080** with the `process` driver. Open it, create your admin account, and start chatting. Nothing needs a key: new accounts start on the free model lane.

What runs:

- `bun host/server.ts` — the openzo host (UI, API, auth).
- one `node .output/server/index.mjs` per signed-in user — that user's agent runtime, started on the first message and stopped after 30 idle minutes.

Your data lives in `./data` (`OPENZO_DATA` to move it): `openzo.db` (SQLite) and `users/<name>/{workspace,state}`.

> The `process` driver gives users **no isolation** from each other or from your machine — the agent's bash runs as your OS user, in that user's workspace directory. It is meant for you alone, or people you would hand your laptop to. Use the `gvisor` driver for anyone else.

### Developing

```bash
npm run dev:agent                 # eve dev on :4444 with the mock model (agent only)
bun --watch host/server.ts        # host on :8080
cd web && npx vite                # UI with hot reload on :5173, proxying /api and /eve to :8080
bash tools/check.sh               # the gate: typecheck, build, shellcheck, 60+ e2e checks on both drivers
```

## 3. Use it

**Home** is the chat. The agent works in `/workspace`, which is the same directory you see under **Files** and land in under **Terminal**. Ask it to build things, analyse files you upload, research, write code and run it. Tool calls show as compact cards; click one to see its input and output. Attach files with the paperclip (or paste them): they are saved to `/workspace/uploads` and the agent is told the path.

The **Stop** button cancels the turn on the server, not just in your browser. Conversations are listed in the sidebar; reopening one replays it from the runtime and continues where it left off.

**Automations**: a name, a cron schedule (with presets and a time zone), a prompt, and where to send the result. On schedule, the host starts a fresh conversation with that prompt in your runtime; with *Send the result to* set, the run's final answer also goes to that channel (or your preferred one). **Run now** fires one immediately. The agent can create, change and run automations too (*every weekday at 8, email me a digest of…*) with its `automations` tool.

**Settings**:

- *Model* — provider, base URL, key, main/fast/vision model ids, context window. Saving restarts your runtime with the new lane.
- *Web search* — SearXNG URL or Brave/Tavily/Exa keys.
- *Media* — the image, speech, transcription and video backends (see *Media* below).
- *Quick instructions* — a free-text persona and rules added to every conversation (kept for simple setups).
- *Personas & rules* tab — several named personas with one active, and rules with an optional condition (*When I ask for code: use TypeScript*). They are fetched at the start of every conversation, so edits apply immediately. When you tell the agent to remember something, it saves a rule here itself (`manage_profile`).
- *Channels* tab — see *Channels* below.
- *Access tokens* tab — see *API* below.
- *Secrets* — env vars your agent and its shell can read (e.g. `GITHUB_TOKEN`). Write-only once saved.
- *Account & runtime* — change password, see runtime state, restart it, read its log.

**Browser**: your own Chromium, running headless next to your workspace with a persistent profile in `/workspace/.openzo/browser-profile`. Press **Start browser**, type an address, and drive it from the live view — click the picture to click the page, click it once and type to send keys (Enter, Tab, arrows and Ctrl-combos included), scroll with the wheel, open and close tabs. **Log into sites here**: the agent's `browser` tool drives the very same browser (open, snapshot, click, type, press, scroll, back/forward, screenshot, eval, tabs), so it acts with your cookies. Watch the live view while it works. The browser stops after 20 minutes without use (`OPENZO_BROWSER_IDLE_MINUTES`); logins survive a stop because the profile is on disk. The view is a ~1 frame/s screenshot, not a video stream; downloads, extensions and file pickers are not wired. Anyone who can read your workspace can read that profile — treat it like a logged-in laptop.

The process driver uses the first Chromium it finds: `OPENZO_CHROMIUM`, then `chromium`/`chromium-browser`/`google-chrome` in `/usr/bin`, then Playwright's `~/.cache/ms-playwright/chromium-*`. The gvisor image ships Debian's `chromium`; the host starts it in your container with `docker exec` and reaches its DevTools port at the container's bridge address (ICC is off, so other users' containers cannot).

### Space & sites

**Space & sites** in the sidebar is Zo Space, Zo Sites and user services in one place.

- **Your Space** is the folder `space/` in your workspace, served as your personal site at `/s/<you>/space/` — plain HTML/CSS/JS, clean URLs (`/about` serves `about.html`), `404.html` for misses. It's public by default. Edit the files, or ask the agent: *make my space a portfolio with my three latest projects*.
- **Static sites**: any workspace folder, served the same way at `/s/<you>/<name>/`. Turn on *Single-page app* for React/Vue routers.
- **Services**: any command that listens on `$PORT` — a Bun/Hono API, a Python app, a Discord bot, a dashboard. The host runs it in your sandbox (your gVisor container on a VPS), restarts it if it crashes (backing off, and giving up after 5 crashes in 2 minutes), keeps its log (the scroll icon), and reverse-proxies HTTP **and websockets** to it. Your openzo session cookie is stripped before the request reaches your app.
- **Private** sites and services only open for you, signed in to openzo. On their own hostnames a one-minute ticket from the main origin is exchanged for a site cookie.
- **Custom domains**: attach `blog.example.com`, point its DNS at the server, and the bundled Caddy issues a certificate on first request (it asks openzo first, so only attached domains get certificates).
- **Subdomains**: with `OPENZO_SITES_DOMAIN=sites.example.com` and a wildcard DNS record `*.sites.example.com`, every site is also served at `https://<name>-<you>.sites.example.com/` — better for apps that use absolute paths. Sites under `/s/<you>/<name>/` should use relative asset URLs (they receive `X-Forwarded-Prefix`).

The agent hosts things with its `service` tool, so *build a little API that returns my todo list and host it* ends with a URL. It is told not to leave servers running from bash, which would die with the turn.

### Channels

**Settings → Channels** connects your own accounts instead of Zo's numbers:

| Channel | Direction | You provide |
|---|---|---|
| Telegram | **two-way**: chat with your agent, and receive messages | a bot token from @BotFather; then send the pairing code shown on the page to your bot |
| Email | to you | your address (the admin sets up outgoing SMTP: `OPENZO_SMTP_URL`) |
| Discord | to you (files attached) | a channel webhook URL |
| Slack | to you | an incoming-webhook URL |
| ntfy | push to your phone | an ntfy topic URL (ntfy.sh or self-hosted), optional token |
| SMS | to you | your Twilio account SID, auth token, From and To numbers |
| Webhook | to anything | a URL; openzo POSTs `{user, title, text, ts}` with an optional `X-Openzo-Secret` |

Telegram needs no public URL: the host long-polls the bot, so it works on a laptop too. Only the paired chat can talk to your agent; strangers are ignored. Each Telegram chat is one ongoing conversation (it shows in your list); send `/new` to start another. Photos, voice notes and documents you send land in `/workspace/Telegram/` and the agent is told the path. **Send test** on each card checks the setup. The agent messages you with `send_message` (only when you asked, an automation says so, or something you told it to watch for happens), and automations can deliver their results to any channel.

### Skills

**Skills** are Zo's packaged workflows in the [agentskills.io](https://agentskills.io/specification) format: `Skills/<slug>/SKILL.md` (frontmatter `name` + `description`, then instructions) plus optional `scripts/`, `references/`, `assets/`. The agent sees the list of installed skills at the start of every conversation and reads a skill's `SKILL.md` when a request matches. The **Skills** page lists yours and browses Zo's public registry (`OPENZO_SKILLS_REGISTRY` to point elsewhere) — **Install** unpacks a skill into your workspace. Ask the agent to *turn what we just did into a skill* to write your own.

### API

**Settings → Access tokens** issues personal tokens (`oz_…`, shown once, revocable). Every `/api` endpoint accepts them as `Authorization: Bearer`, and `POST /api/ask` (also at `/zo/ask`, so scripts written for Zo's API port by changing the base URL and token) runs a full agent turn:

```bash
curl https://zo.example.com/api/ask \
  -H "Authorization: Bearer oz_…" -H "Content-Type: application/json" \
  -d '{"input": "What changed in my workspace today?"}'
# → {"output": "...", "conversation_id": "wrun_…"}
```

Pass `conversation_id` to continue that conversation, and `output_format` (a JSON schema) to get a JSON object back. Streaming responses are not implemented — the call returns when the turn ends.

### Media

Ask in chat: *draw a lighthouse at dusk*, *read this paragraph aloud*, *transcribe uploads/meeting.m4a*, *make subtitles for talk.mp4*. The agent has Zo's media tools — `generate_image`, `edit_image`, `generate_speech`, `transcribe_audio`, `transcribe_video`, `generate_video` — which save into your workspace (`Images/`, `Audio/`, `Videos/` unless told otherwise; transcripts land next to the source as `<name>.transcript.txt`, plus `.srt`/`.vtt`/`.json` on request) and return the path. The tool card in chat previews images, audio and video inline.

Each lane is chosen in **Settings → Media**. *Auto* reuses your model preset's key where that provider has the API, else falls back to the free/local lane:

| Lane | Auto with OpenAI preset | Auto otherwise | Other choices |
|---|---|---|---|
| Images | OpenAI `gpt-image-1` | Pollinations `flux` (keyless, public, generate only) | any OpenAI-compatible `/images/generations` + `/images/edits` |
| Speech | OpenAI `gpt-4o-mini-tts` | local `piper` (first voice found), then `espeak-ng` | any OpenAI-compatible `/audio/speech`; force piper or espeak |
| Transcription | OpenAI `whisper-1` (Groq preset: `whisper-large-v3-turbo`) | local `faster-whisper` (`base`) | any OpenAI-compatible `/audio/transcriptions` |
| Video | — | off | fal.ai (`fal-ai/ltx-video`) or Replicate (`minimax/video-01`) with your key |

Notes: **edit_image does not work on the free lane** — Pollinations can only edit images it can fetch from a public URL, and your workspace is private; the tool says so. **There is no free video lane**; without a fal.ai/Replicate key `generate_video` explains how to add one. Video goes through `ffmpeg` to pull the audio track; remote transcription APIs cap uploads at 25 MB, so bigger files are squeezed to 16 kHz mono MP3 first. Prompts sent to Pollinations are public-ish — use a keyed provider for anything private.

Local backends: the runtime image ships `ffmpeg`, `espeak-ng`, `piper` with the `en_US-lessac-medium` voice in `/opt/piper-voices`, and `faster-whisper` only when built with `--build-arg WITH_WHISPER=1` (it is ~300 MB). On the process driver they come from the host: piper voices (`*.onnx` + `*.onnx.json` from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)) are looked up in `OPENZO_PIPER_VOICES`, `/opt/piper-voices`, `/usr/share/piper-voices`, `~/.local/share/piper-voices` and `/workspace/.piper-voices`; local transcription runs `OPENZO_WHISPER_PYTHON` (default `python3`) with `faster_whisper` importable, and downloads its model from Hugging Face on first use.

### Integrations

**Integrations** in the sidebar connects your own accounts so the agent can work with them: *summarise my unread mail*, *what's on my calendar tomorrow*, *open an issue for this bug*, *add these rows to my Notion database*. Press **Connect** on a card, pick what the agent may use (Google: Gmail, Calendar, Drive, Sheets, Tasks; Microsoft: Outlook mail, Calendar, OneDrive), sign in at the provider, and you're back with the account listed. You can connect several accounts per provider and disconnect any of them.

The agent gets two tools: `list_connections` (what is connected, which API hosts each may call) and `call_integration` (an HTTP request made on a connection). It uses the providers' real APIs — `gmail.googleapis.com/gmail/v1/users/me/…`, `www.googleapis.com/calendar/v3`, `api.github.com`, `api.notion.com/v1`, `api.linear.app/graphql`, `graph.microsoft.com/v1.0` and so on. Tokens stay on the host, which refreshes them when they expire; responses come back as JSON/text (cut at 2 MB) or are saved into the workspace with `save_to`.

**API keys**: for services without OAuth (OpenWeather, Airtable, Todoist, your own APIs), **Add key** stores a key bound to one HTTPS API base, sent as a header (e.g. `Authorization: Bearer …`) or a query parameter (e.g. `appid=`).

**Setting up a provider (admins).** Each provider needs one OAuth app that every user on the server connects through. Register it at the provider with the **redirect URI** shown on the Integrations page — `<your origin>/api/integrations/callback`, e.g. `https://zo.example.com/api/integrations/callback` (set `OPENZO_PUBLIC_URL` so it doesn't depend on how you reached the page). Then press the gear on the card and paste the client id and secret, or set `OPENZO_OAUTH_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` on the host (env wins over the UI).

- *Google* — [Cloud console](https://console.cloud.google.com/apis/credentials): create a project, enable the Gmail, Calendar, Drive, Sheets and Tasks APIs you want, configure the OAuth consent screen (add yourself as a test user while it's in *Testing* — test-mode refresh tokens expire after 7 days; publish the app to stop that), then *Create credentials → OAuth client ID → Web application* with the redirect URI. Gmail and Drive full-access scopes are *restricted*: fine for your own users in Testing or an internal Workspace app, verification needed for a public one.
- *GitHub* — [Settings → Developer settings → OAuth Apps → New](https://github.com/settings/applications/new): homepage = your origin, callback URL = the redirect URI. Generate a client secret.
- *Notion* — [Integrations](https://www.notion.so/profile/integrations): new *public* integration, redirect URI as above. Users pick which pages to share during consent.
- *Linear* — Settings → API → OAuth applications. *Spotify* — [developer dashboard](https://developer.spotify.com/dashboard) (apps start in development mode: add each user's Spotify email under *User management*). *Slack* — [api.slack.com/apps](https://api.slack.com/apps), add the redirect URL under *OAuth & Permissions*; openzo asks for **user** scopes so the agent acts as you. *Microsoft* — Entra ID → App registrations → *Web* platform redirect URI, accounts in any directory + personal; create a client secret. *Discord* — developer portal → OAuth2 → redirects.

Not in openzo: Zo's Pipedream catalogue of 1000+ apps and its prebuilt actions — the agent calls the raw APIs, which it is generally good at.

**Admin** (admins only): users with runtime state, disk use and last activity; add, disable, promote, reset password, delete (optionally purging files); stop a runtime; create single-use invite links; audit log; system health.

## 4. Host it on a VPS (multi-user, gVisor)

### Why gVisor

Every user's agent can run arbitrary commands — that is the point. On a shared server each user therefore gets their own container, and the container runs under **gVisor** (`runsc`): a user-space kernel that intercepts the container's system calls, so a kernel exploit inside a user's runtime hits gVisor, not your host kernel. Containers are also on a bridge where they cannot talk to each other, to the host, or to any private or link-local address (which includes cloud metadata endpoints). They can reach the public internet and one host port: the search proxy.

### Requirements

- A VPS with Debian 12+ or Ubuntu 22.04+, root access, **2 vCPU / 4 GB RAM minimum** (each active runtime is ~300 MB idle; size for your concurrent users), 20 GB+ disk.
- A domain name with an A/AAAA record pointing at the VPS (for automatic HTTPS).
- Ports 80 and 443 open.

gVisor's default `systrap` platform works on ordinary VPSes; no nested virtualisation is required.

### Install

```bash
# copy the release tarball to the server (or git clone your copy), then:
scp openzo-0.3.0.tar.gz root@your-vps:
ssh root@your-vps
tar xzf openzo-0.3.0.tar.gz && cd openzo
OPENZO_DOMAIN=zo.example.com bash deploy/install.sh
```

`bash tools/pack.sh` builds that tarball from a checkout (no `node_modules`, builds or data).

The installer is idempotent. It:

1. installs Docker, gVisor (`runsc` from gVisor's apt repository, registered as a Docker runtime and smoke-tested with `hello-world`), Node 24, Bun and Caddy;
2. copies the code to `/opt/openzo`, builds the agent server and web app, and builds the per-user runtime image `openzo-agent:latest` (`deploy/Dockerfile.agent`: Node 24, Bun, Python 3, git, ripgrep, build tools);
3. writes `/etc/openzo/openzo.env` from `deploy/openzo.env.example` (mode 0600);
4. creates the `openzo` Docker network (`172.30.0.0/24`, inter-container traffic disabled) and installs `openzo-firewall.service`, which applies the egress rules from `deploy/firewall.sh`;
5. starts SearXNG on `127.0.0.1:8888` with JSON output enabled;
6. installs Caddy with `deploy/Caddyfile` (automatic Let's Encrypt, streaming-safe proxying);
7. installs and starts `openzo.service`, then checks `/api/health`.

Open `https://zo.example.com` and create the admin account. The first account is created through the setup screen and becomes admin; after that, sign-up follows `OPENZO_SIGNUP` (default `invite`: share invite links from Admin → Invites).

### What a user's runtime looks like

```
docker run -d --name openzo-u-<user> --runtime runsc --network openzo \
  --memory 2g --cpus 1 --pids-limit 512 \
  --security-opt no-new-privileges --cap-drop NET_RAW \
  -p 127.0.0.1::3000 \
  -v /var/lib/openzo/users/<user>/workspace:/workspace \
  -v /var/lib/openzo/users/<user>/state:/state \
  --env-file /var/lib/openzo/users/<user>/state/.runtime.env \
  openzo-agent:latest
```

Started on the user's first request, stopped after `OPENZO_IDLE_MINUTES`, recreated when they change settings (env is fixed at creation). Keys travel in a 0600 env file, never on a command line. The terminal is `docker exec -it -w /workspace openzo-u-<user> bash -l`.

### Single-user VPS without Docker

Set `OPENZO_DRIVER=process`, skip Docker/gVisor, and run `bun host/server.ts` under systemd behind Caddy. Same caveat as local: no isolation between accounts.

### Manual install (other distros)

Install Docker, `runsc` (<https://gvisor.dev/docs/user_guide/install/>, then `runsc install` and restart Docker), Node 24, Bun and a TLS proxy. Then from the checkout: `npm ci && (cd web && npm ci) && npm run build && docker build -f deploy/Dockerfile.agent -t openzo-agent:latest .`, run `deploy/firewall.sh`, copy `deploy/openzo.env.example` to `/etc/openzo/openzo.env`, and run `bun host/server.ts` with that environment.

## 5. Configuration reference

All configuration is environment variables (read from `/etc/openzo/openzo.env` on a VPS).

| Variable | Default | Meaning |
|---|---|---|
| `OPENZO_HOST` / `OPENZO_PORT` | `127.0.0.1` / `8080` | Where the host listens. Keep it on loopback behind a TLS proxy. |
| `OPENZO_PUBLIC_URL` | — | Public origin; an `https://` value marks cookies `Secure`. |
| `OPENZO_TRUST_PROXY` | off | `1` to trust `X-Forwarded-For/Proto` from your reverse proxy. |
| `OPENZO_DATA` | `./data` | SQLite database, host secret, user workspaces and runtime state. |
| `OPENZO_SECRET` | generated | Signs the JWTs the host sends to runtimes. Stored in `$OPENZO_DATA/secret` if unset. |
| `OPENZO_DRIVER` | `process` | `process` (no isolation) or `gvisor` (container per user). |
| `OPENZO_SIGNUP` | `invite` | `open`, `invite` or `closed`. |
| `OPENZO_DEFAULT_LANE` | `free` | Model preset for users who haven't chosen one (`free`, `mock`, `openai`, …). |
| `OPENZO_IDLE_MINUTES` | `30` | Stop a runtime after this long without use. |
| `OPENZO_MAX_RUNTIMES` | `50` | Concurrent runtimes; the least recently used is stopped to make room. |
| `OPENZO_SESSION_DAYS` | `30` | Browser session lifetime. |
| `OPENZO_PORT_BASE` / `OPENZO_PORT_SPAN` | `25400` / `1000` | Port range for process-driver runtimes (each port is probed before use). |
| `OPENZO_AGENT_SERVER` | `.output/server/index.mjs` | Built agent server for the process driver. |
| `OPENZO_WEB_DIST` | `web/dist` | Built UI. |
| `OPENZO_DOCKER` | `docker` | Docker CLI (gvisor driver). |
| `OPENZO_AGENT_IMAGE` | `openzo-agent:latest` | Runtime image. |
| `OPENZO_OCI_RUNTIME` | `runsc` | OCI runtime; `runc` disables gVisor (not recommended). |
| `OPENZO_DOCKER_NETWORK` | `openzo` | Bridge the runtimes join. |
| `OPENZO_USER_MEMORY` / `OPENZO_USER_CPUS` / `OPENZO_USER_PIDS` | `2g` / `1` / `512` | Per-runtime limits. |
| `OPENZO_SEARXNG_URL` | — | SearXNG the host can reach; given to process runtimes directly. |
| `OPENZO_PIPER_VOICES` | — | Extra dirs (colon-separated) of piper voices for local speech; passed to process runtimes. |
| `OPENZO_WHISPER_PYTHON` | `python3` | Python with `faster_whisper` for local transcription; passed to process runtimes. |
| `OPENZO_INTERNAL_HOST` / `OPENZO_INTERNAL_PORT` | — / `8091` | Bridge-gateway listener for gVisor runtimes: the runtime API (`/internal/*`, per-user token) and the SearXNG proxy — the one host port containers may reach. |
| `OPENZO_OAUTH_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` | — | OAuth app for an integration (`GOOGLE`, `GITHUB`, `NOTION`, `LINEAR`, `SPOTIFY`, `SLACK`, `MICROSOFT`, `DISCORD`). Overrides what an admin saved in the UI. See §3 *Integrations*. |
| `OPENZO_ALLOW_HOST_PORTS` | — | Extra host ports containers may reach on the gateway (e.g. `11434` for Ollama). |
| `OPENZO_SITES_DOMAIN` | — | Wildcard domain for sites: `<name>-<user>.<domain>`. Needs `*.<domain>` DNS; Caddy issues certificates on demand. |
| `OPENZO_MAX_SERVICES` | `10` | Sites + services per user. |
| `OPENZO_SMTP_URL` / `OPENZO_SMTP_FROM` | — | Outgoing mail for the email channel: `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587` (STARTTLS); `?tls=off` for a local relay. `FROM` like `openzo <zo@example.com>`. |
| `OPENZO_SKILLS_REGISTRY` | Zo's public registry | Skills manifest URL (`{tarball_url, archive_root, skills[]}`). |
| `OPENZO_BROWSER_IDLE_MINUTES` | `20` | Stop a user's browser after this long unused. |

Admin CLI (run on the server, with the same environment):

```bash
bun host/cli.ts create-user <name> <password> [admin]
bun host/cli.ts reset-password <name> <password>
bun host/cli.ts invite [days] [admin]
bun host/cli.ts list
```

## 6. Models

Each user picks a lane in Settings → Model; the host turns it into env for that user's runtime:

| Preset | Notes |
|---|---|
| Free (Pollinations) | Keyless community endpoint serving gpt-oss-20b with tool calls. Rate-limited and public — fine for trying openzo, not for private data. |
| OpenAI / OpenRouter / Groq | Key + model id. |
| Anthropic | Through Anthropic's OpenAI-compatible endpoint (`claude-sonnet-5-5` main, `claude-haiku-5-5` fast by default). |
| Ollama / custom | Any OpenAI-compatible server. The model must support tool calling. On a gVisor host, `127.0.0.1` is rewritten to the bridge gateway; bind Ollama to it and add its port to `OPENZO_ALLOW_HOST_PORTS`. |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` + catalog slugs. |
| Mock | Scripted, offline. `[mock:bash <command>]` in a message makes it call the real bash tool — the e2e suite uses this. |

With no lane at all, the agent answers every message with setup instructions instead of failing.

## 7. Security model

- **Accounts**: argon2id password hashes; random 256-bit session tokens stored hashed; `HttpOnly`, `SameSite=Lax` cookies (`Secure` behind HTTPS); state-changing requests with a foreign `Origin` are refused; 10 failed logins per IP per 15 minutes.
- **Host ↔ runtime**: every request to a runtime carries a short-lived HS256 JWT (issuer `openzo-host`, audience `openzo-agent`, subject = username) signed with the host secret. Runtimes accept nothing else — not even loopback — so on the process driver one user's runtime port is useless to another local process.
- **Files**: every path is resolved inside the user's workspace and re-checked after resolving symlinks; the workspace root cannot be deleted or overwritten. Raw files are served with `Content-Security-Policy: sandbox` and `nosniff`.
- **Isolation (gvisor driver)**: gVisor syscall interception; per-user container with memory/CPU/PID limits, `no-new-privileges`, `NET_RAW` dropped; no inter-container traffic; no access to private ranges, the host, or metadata endpoints; runtimes published on loopback only.
- **Isolation (process driver)**: none between users. Single-user only.
- **Integrations**: OAuth tokens, API keys and OAuth client secrets are stored AES-256-GCM-encrypted under a key derived from `OPENZO_SECRET` (rotating it means users reconnect). They never reach the runtime: the agent asks the host to make a request, and the host checks the URL against the connection's API host allowlist (https only), adds the credential, and follows redirects itself so credentials never leave the allowlist. The OAuth `state` is HMAC-signed, single-use, expires in 10 minutes and carries a PKCE verifier kept on the host; the callback only completes for the user who started it.
- **Runtime → host**: the agent's host-backed tools (service, send_message, automations, manage_profile, integrations, browser) call the host's internal API with a token that is an HMAC of the username under the host secret, handed to the runtime at boot. A runtime can only act as its own user; nothing else can mint one.
- **Sites**: static files are served from inside the site's folder only (no dotfiles, no traversal); services run as the user's sandbox, never as the host; openzo's own session cookies are stripped before requests reach a user's app; private sites need the owner's session; Caddy only gets certificates for attached domains (`/api/sites/tls-ask`).
- **Channels**: bot tokens, webhook URLs and Twilio tokens are stored with the user's settings and returned only masked. Telegram ignores every chat but the paired one.
- **Secrets**: keys are stored in the host database in plain text (it is your server) and returned to the UI only masked. Back up and protect `$OPENZO_DATA`.

What is **not** covered: per-user disk quotas (monitor in Admin), egress allow-listing beyond the private-range block, and audit of what the agent does inside a runtime (only host-level actions are audited).

## 8. Operating it

```bash
journalctl -u openzo -f                       # host log
docker ps --filter label=openzo.user          # running runtimes
docker logs openzo-u-<user>                   # a runtime's log (also in Settings → Account & runtime)
bash /opt/openzo/deploy/update.sh             # pull, rebuild, recreate runtimes; data untouched
bash /opt/openzo/deploy/backup.sh /backups    # SQLite online backup + workspaces → tar.gz
```

Restore: stop `openzo`, unpack the archive into `OPENZO_DATA` (`openzo.db`, `secret`, `users/`), start `openzo`.

## 9. What is stubbed, and why

Everything hosted Zo has is here in self-hosted form, except what only Zo's own infrastructure can provide:

| Hosted Zo feature | Why it's not here | What to do instead |
|---|---|---|
| Zo-owned phone number and inbox (texting or emailing your agent) | Zo operates them | Chat over Telegram (two-way); SMS and email are outbound only |
| Pipedream's 1000+ app catalogue and prebuilt actions | Zo's Pipedream account | Real OAuth for the big providers, API-key connections for anything else; the agent calls the raw APIs |
| Zo's media gateway models | metered by Zo | Your own OpenAI-compatible / fal.ai / Replicate keys, or the free and local lanes |
| Credits and billing | — | You pay your model provider directly |
| MCP server endpoint for external clients, streaming `/api/ask` | not built yet | The ask API (blocking) |

## 10. Architecture

```
browser ──HTTPS──▶ Caddy ──▶ openzo host (Bun, :8080)
                               │  /api/*   accounts, settings, files, automations, admin
                               │  /api/terminal  websocket → PTY (host bash, or docker exec)
                               │  /eve/*   proxy, adds the user's JWT
                               │  /s/<user>/<site>/, custom domains, *.OPENZO_SITES_DOMAIN → sites
                               │  /internal/*  runtime → host API (per-user token)
                               │  web/dist the UI
                               │  supervisor: user services, browsers, Telegram pollers, cron
                               ▼
                 per-user runtime (eve agent server, .output/server)
                   process driver: node on 127.0.0.1:<port>, cwd users/<u>/state
                   gvisor driver:  runsc container, /workspace + /state mounted
                               │
                               └─ host sandbox backend: real bash on /workspace
```

- `agent/` — the eve agent: `agent.ts` (model lane from `lib/models.ts`), `sandbox.ts` → `lib/host-sandbox.ts` (a custom `SandboxBackend`: real bash and files on the user's workspace instead of eve's Docker/microsandbox/just-bash ladder — inside a gVisor container a second sandbox would buy nothing), `tools/` (Zo's stdlib file tools + self-hosted `web_search`), `subagents/task_fast`, `channels/eve.ts` (JWT-only auth), `instructions/` (Zo's instruction stack + the user's persona/rules, resolved per session).
- `host/` — the control plane: `server.ts` (routes, proxy, websocket, static), `http.ts` (route table, guards), `internal.ts` (runtime → host API), `runtime.ts` (drivers, idle reaper, port probing), `services.ts` (Space, sites, supervised services, site proxy, domains), `channels.ts` + `smtp.ts` (Telegram/email/Discord/Slack/ntfy/SMS/webhook), `profile.ts` (personas, rules), `skills.ts`, `api.ts` (tokens, ask), `integrations.ts`, `browser.ts`, `auth.ts`, `db.ts`, `settings.ts` (presets → env), `files.ts`, `automations.ts` (cron with time zones, delivery), `agent-client.ts` (turns and history from the eve stream), `features.ts`, `cli.ts`.
- `web/` — React 19 + Tailwind 4 + shadcn UI: chat (eve's `useEveAgent`), files, terminal (xterm.js), automations, settings, admin, stub pages.
- `deploy/` — installer, runtime image, firewall, systemd units, Caddy, update and backup scripts.
- `tools/` — `check.sh` (the gate), `e2e.ts` (core end-to-end suite), `e2e-platform.ts` (sites, channels, API, personas, skills, automations — with mock Telegram/SMTP/webhooks), `e2e-browser.ts`, `e2e-integrations.ts` (mock OAuth provider), `e2e-media.ts`, `fake-docker.sh` (gvisor driver test double).

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "runtime exited during startup" | Read Settings → Account & runtime → Show log. On the process driver, check `OPENZO_AGENT_SERVER` exists (`npx eve build`). |
| Runtime starts then every message fails | The model lane: wrong key, model id, or a model without tool calling. Switch to the free or mock lane to confirm the stack works. |
| `docker has no 'runsc' runtime registered` (Admin → system) | `runsc install && systemctl restart docker`. |
| Web search errors with "bot-walled" | DuckDuckGo blocks datacenter IPs. Set `OPENZO_SEARXNG_URL` (the installer does) or a Brave/Tavily/Exa key. |
| Streaming replies arrive all at once | A proxy is buffering. Use the shipped Caddyfile (`flush_interval -1`), or `proxy_buffering off` on nginx. |
| Terminal connects then closes immediately (gvisor) | The container failed to start; check `docker logs openzo-u-<user>`. |
| UI loads but assets 404 on deep links | Rebuild the UI (`cd web && npx vite build`); it must be built with `base: "/"`. |
