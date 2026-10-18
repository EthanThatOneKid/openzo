#!/usr/bin/env bash
# Update a VPS install in place: pull, rebuild, recreate runtimes.
# User data (workspaces, conversations, settings) lives in OPENZO_DATA and is untouched.
set -euo pipefail
cd /opt/openzo
set -a; . /etc/openzo/openzo.env; set +a
if [ -d .git ]; then git pull --ff-only; fi
npm ci --no-audit --no-fund
(cd web && npm ci --no-audit --no-fund)
npm run build
docker build -f deploy/Dockerfile.agent -t "${OPENZO_AGENT_IMAGE:-openzo-agent:latest}" .
# Runtimes restart on demand from the new image; their volumes persist.
ids=$(docker ps -aq --filter label=openzo.user)
if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; fi
systemctl restart openzo
echo "updated — $(curl -fsS http://127.0.0.1:${OPENZO_PORT:-8080}/api/health)"
