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
| Automations: cron + prompt, results land in your conversation list | working |
| Conversations that persist and resume, with full history replay | working |
| Bring your own model: OpenAI, Anthropic, OpenRouter, Groq, Ollama, Vercel AI Gateway, any OpenAI-compatible server, or a keyless free lane | working |
| Persona, rules and secrets (env vars for the agent) per user | working |
| Multiple users: setup wizard, invites, admin panel, audit log | working |
| One gVisor container per user on a VPS | built and tested against a recording fake `docker`; see §4 |
| Web search | SearXNG / Brave / Tavily / Exa; DuckDuckGo fallback |
| Zo Space, site hosting, Gmail/Calendar/Notion integrations, SMS/email/Telegram, image/video/speech generation, hosted browser, credits | stubbed — see §9 |

## 2. Run it locally

You need **Node 24+** and **Bun 1.3+**.

```bash
# get the code: the release tarball from the openzo site, or your own git copy
tar xzf openzo-0.2.0.tar.gz && cd openzo
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

**Automations**: a name, a cron schedule (with presets and a time zone), and a prompt. On schedule, the host starts a fresh conversation with that prompt in your runtime. **Run now** fires one immediately. Each run appears in your conversation list with a clock icon.

**Settings**:

- *Model* — provider, base URL, key, main/fast/vision model ids, context window. Saving restarts your runtime with the new lane.
- *Web search* — SearXNG URL or Brave/Tavily/Exa keys.
- *Persona & rules* — added to the system prompt of every new conversation.
- *Secrets* — env vars your agent and its shell can read (e.g. `GITHUB_TOKEN`). Write-only once saved.
- *Account & runtime* — change password, see runtime state, restart it, read its log.

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
scp openzo-0.2.0.tar.gz root@your-vps:
ssh root@your-vps
tar xzf openzo-0.2.0.tar.gz && cd openzo
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
| `OPENZO_INTERNAL_HOST` / `OPENZO_INTERNAL_PORT` | — / `8091` | Bridge-gateway listener that proxies only SearXNG to gVisor runtimes. |
| `OPENZO_ALLOW_HOST_PORTS` | — | Extra host ports containers may reach on the gateway (e.g. `11434` for Ollama). |

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

These parts of hosted Zo depend on infrastructure only Zo runs. openzo shows them in the sidebar under **Not in openzo** with an explanation, and the agent's instructions tell it to say so and offer an alternative instead of failing.

| Hosted Zo feature | Why it's not here | What to do instead |
|---|---|---|
| Zo Space, Sites, custom domains | Zo's hosting edge and DNS automation are closed | Have the agent build the site in your workspace; serve it yourself behind your own proxy |
| Integrations (Gmail, Calendar, Notion…) | OAuth apps on Zo's Pipedream account | Put API keys in Settings → Secrets and let the agent call the APIs |
| SMS, email, Telegram, Discord | Zo-owned numbers and inboxes | eve ships Discord/Telegram channels; not wired yet |
| Image/video/speech generation, transcription, maps, X search | Executed by Zo's metered media gateway | The original tools are parked in `reference/cloud-tools/`; copy them back into `agent/tools/` if you run a Zo-protocol gateway (`ZO_AI_BASE_URL`) |
| Hosted browser | Zo-managed browser sessions | The agent can install and drive headless Chromium in its runtime |
| Credits and billing | — | You pay your model provider directly |

## 10. Architecture

```
browser ──HTTPS──▶ Caddy ──▶ openzo host (Bun, :8080)
                               │  /api/*   accounts, settings, files, automations, admin
                               │  /api/terminal  websocket → PTY (host bash, or docker exec)
                               │  /eve/*   proxy, adds the user's JWT
                               │  web/dist the UI
                               ▼
                 per-user runtime (eve agent server, .output/server)
                   process driver: node on 127.0.0.1:<port>, cwd users/<u>/state
                   gvisor driver:  runsc container, /workspace + /state mounted
                               │
                               └─ host sandbox backend: real bash on /workspace
```

- `agent/` — the eve agent: `agent.ts` (model lane from `lib/models.ts`), `sandbox.ts` → `lib/host-sandbox.ts` (a custom `SandboxBackend`: real bash and files on the user's workspace instead of eve's Docker/microsandbox/just-bash ladder — inside a gVisor container a second sandbox would buy nothing), `tools/` (Zo's stdlib file tools + self-hosted `web_search`), `subagents/task_fast`, `channels/eve.ts` (JWT-only auth), `instructions/` (Zo's instruction stack + the user's persona/rules, resolved per session).
- `host/` — the control plane: `server.ts` (routes, proxy, websocket, static), `runtime.ts` (drivers, idle reaper, port probing), `auth.ts`, `db.ts`, `settings.ts` (presets → env), `files.ts`, `automations.ts` (cron with time zones), `agent-client.ts` (history replay from the eve stream), `features.ts`, `cli.ts`.
- `web/` — React 19 + Tailwind 4 + shadcn UI: chat (eve's `useEveAgent`), files, terminal (xterm.js), automations, settings, admin, stub pages.
- `deploy/` — installer, runtime image, firewall, systemd units, Caddy, update and backup scripts.
- `tools/` — `check.sh` (the gate), `e2e.ts` (end-to-end suite), `fake-docker.sh` (gvisor driver test double).

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
