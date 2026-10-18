# openzo — self-hosted Zo

A self-hosted Zo Computer for one user or many: eve agent + Zo's stdlib tools,
a Bun control plane (accounts, per-user runtimes, files, terminal,
automations, admin), a React UI, and a VPS kit with one gVisor container per
user. `docs/GUIDE.md` is the user-facing manual and the source of truth for
config/env names; the Zo Site at `Projects/openzo-site` presents the same
content. Own git repo (nested; the workspace root ignores everything, and
Tailwind honours that ignore — see traps).

## Layout

- `agent/` — eve agent (eve 0.28.0 ↔ @zocomputer/agent-sdk v0.27.0; keep paired).
  - `lib/models.ts` — lanes picked by env **at runtime start** (not frozen at
    build): `ZO_MOCK` / `OPENAI_*` / `ANTHROPIC_*` / `AI_GATEWAY_API_KEY` /
    `ZO_AI_BASE_URL` / none → setup model. Mock understands `[mock:bash <cmd>]`.
  - `lib/host-sandbox.ts` — custom `SandboxBackend` ("openzo-host"): real bash
    + fs on `OPENZO_WORKSPACE`, `/workspace` mapped onto it in paths and
    commands. Replaces eve's docker/microsandbox/just-bash ladder.
  - `lib/file-tools.ts` — SDK file tools rooted at `/workspace` (the seed had
    `/home/daytona`, which broke every file tool off Zo's cloud).
  - `lib/search.ts` + `tools/web_search.ts` — SearXNG/Brave/Tavily/Exa/DDG.
  - `channels/eve.ts` — with `OPENZO_AGENT_SECRET` set, **JWT only** (no
    localDev: process-driver runtimes share loopback).
  - `instructions/zz-user.ts` — persona/rules from env, `defineDynamic` per session.
- `host/` — Bun control plane, zero deps. `server.ts` routes + `/eve/*` proxy
  (records conversations on session create) + terminal websocket + static UI
  + optional internal SearXNG listener; `runtime.ts` drivers (`process`,
  `gvisor`), idle reaper, port probing; `settings.ts` presets → runtime env;
  `agent-client.ts` replays history from the eve stream (`includeTailIndex`).
- `web/` — React 19 + Tailwind 4 + shadcn; pages chat/files/terminal/
  automations/settings/admin/stub. Built to `web/dist`, served by the host.
- `deploy/` — `install.sh` (Docker, runsc, Node 24, Bun, Caddy, SearXNG,
  systemd), `Dockerfile.agent`, `firewall.sh`, units, `update.sh`, `backup.sh`.
- `tools/` — `check.sh` (gate: 11 steps), `e2e.ts` (52 checks process driver,
  62 with `--gvisor-fake`, `--real` adds a free-lane model turn),
  `fake-docker.sh` (records docker argv, runs "containers" as processes).
- `reference/` — parked Zo-cloud-coupled files: `cloud-tools/` (media, maps,
  x_search, gateway web_search, state consent — need a Zo-protocol gateway),
  slack channel (Vercel Connect), lessons/state hooks, zoSandbox.
- `zoapp/` — private local copy of the hosted Zo Next.js app found on this box.
  Gitignored, never shipped, not part of openzo.

## Verified (2026-10-13)

`bash tools/check.sh` → 11/11: agent tsc, eve 0 errors/0 warnings, agent build,
web tsc + build, host tsc, shellcheck, no Zo CDN/API refs, e2e both drivers.
Real model turn on the Pollinations free lane (gpt-oss-20b) passes. UI driven
in a real browser: login, chat with tool cards, conversation replay after a
host restart, files, terminal PTY, settings, admin.

**Not verified on hardware**: gVisor itself, the Docker image build,
`install.sh`, `firewall.sh`, Caddy — Zo has no Docker and is itself a gVisor
sandbox. The fake-docker run proves the driver's flow and argv only.
Nothing has been deployed to any VPS (Zandy's rule: no hardware without a go).

## Traps

- eve's server **exits 0 silently** when its port is taken → ports are probed
  (connect + bind) before use; base 25400 because 24900 is taken here.
- `disableTool()` only works for framework tool names; `eve info` does not
  catch misuse, the runtime 500s on first request. Remove tools from the tree
  instead (that is why cloud tools live in `reference/`).
- Workflow state lives in `<cwd>/.eve/.workflow-data`; runtimes get
  `cwd = users/<u>/state` for per-user isolation.
- Run `node .output/server/index.mjs` directly: `eve start` adds an npm + CLI
  wrapper (~600 MB extra per runtime).
- Vite needs `base: "/"` or deep links load assets relative to the route.
- Tailwind 4 skips gitignored files; the workspace root `.gitignore` is `*`,
  so `web/` only builds styles because openzo is its own git repo.
- `new URL("/search", base)` drops a base path; append instead.
- Zo sandbox: `pkill -f` patterns kill your own shell — kill by PID.
