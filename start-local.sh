#!/usr/bin/env bash
# Run openzo on this machine: one command, process driver, http://127.0.0.1:8080.
# Needs Node 24+ and Bun. Data lives in ./data (override with OPENZO_DATA).
set -euo pipefail
cd "$(dirname "$0")"
need() { command -v "$1" >/dev/null || { echo "openzo needs $1 — $2" >&2; exit 1; }; }
need node "https://nodejs.org (v24+)"
need bun "curl -fsSL https://bun.sh/install | bash"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || { echo "Node 24+ required (found $(node -v))" >&2; exit 1; }

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then npm install --no-audit --no-fund; fi
if [ ! -d web/node_modules ] || [ web/package-lock.json -nt web/node_modules ]; then (cd web && npm install --no-audit --no-fund); fi
if [ ! -f .output/server/index.mjs ] || [ -n "$(find agent -newer .output/server/index.mjs -print -quit)" ]; then npx eve build; fi
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src -newer web/dist/index.html -print -quit)" ]; then (cd web && npx vite build); fi

export OPENZO_DRIVER="${OPENZO_DRIVER:-process}"
export OPENZO_HOST="${OPENZO_HOST:-127.0.0.1}"
export OPENZO_PORT="${OPENZO_PORT:-8080}"
export OPENZO_SIGNUP="${OPENZO_SIGNUP:-closed}"
echo "openzo → http://${OPENZO_HOST}:${OPENZO_PORT}  (first visit creates the admin account)"
exec bun host/server.ts
