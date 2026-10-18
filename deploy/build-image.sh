#!/usr/bin/env bash
# Build the agent server and the per-user runtime image.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${OPENZO_AGENT_IMAGE:-openzo-agent:latest}"
npx eve build
docker build -f deploy/Dockerfile.agent -t "$IMAGE" .
echo "built $IMAGE"
