#!/usr/bin/env bash
# openzo VPS installer — Debian 12+/Ubuntu 22.04+, run as root from a checkout:
#
#   OPENZO_DOMAIN=zo.example.com bash deploy/install.sh
#
# Installs Docker, gVisor (runsc), Node 24, Bun and Caddy; builds openzo and the
# per-user runtime image; starts SearXNG, the container firewall and the host
# as systemd services. Idempotent: re-run it to repair or after editing
# /etc/openzo/openzo.env. Nothing here touches existing Docker containers
# other than openzo's own.
set -euo pipefail

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu (apt) only — see docs/GUIDE.md for manual steps"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/openzo
ENV_FILE=/etc/openzo/openzo.env
ARCH="$(dpkg --print-architecture)"

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git unzip rsync iptables sqlite3 debian-keyring debian-archive-keyring apt-transport-https >/dev/null

log "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

log "gVisor (runsc)"
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc >/dev/null
fi
if ! docker info --format '{{json .Runtimes}}' | grep -q runsc; then
  runsc install
  systemctl restart docker
fi
docker run --rm --runtime=runsc hello-world >/dev/null && echo "runsc works"

log "Node 24 + Bun"
if ! node -v 2>/dev/null | grep -qE '^v(2[4-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
fi
node -v && bun -v

log "openzo code → ${DEST}"
if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST"
  rsync -a --delete --exclude node_modules --exclude web/node_modules --exclude .eve --exclude .output --exclude data --exclude zoapp --exclude reference "$SRC/" "$DEST/"
fi
cd "$DEST"

log "Configuration"
mkdir -p /etc/openzo
if [ ! -f "$ENV_FILE" ]; then
  [ -n "${OPENZO_DOMAIN:-}" ] || die "set OPENZO_DOMAIN=your.domain for the first install (DNS A/AAAA record must point here)"
  sed -e "s#^OPENZO_DOMAIN=.*#OPENZO_DOMAIN=${OPENZO_DOMAIN}#" -e "s#^OPENZO_PUBLIC_URL=.*#OPENZO_PUBLIC_URL=https://${OPENZO_DOMAIN}#" deploy/openzo.env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
mkdir -p "${OPENZO_DATA:-/var/lib/openzo}"

log "Build (agent server, web UI, runtime image)"
npm ci --no-audit --no-fund
(cd web && npm ci --no-audit --no-fund)
npm run build
docker build -f deploy/Dockerfile.agent -t "${OPENZO_AGENT_IMAGE:-openzo-agent:latest}" .

log "Container network + firewall"
install -m 644 deploy/openzo-firewall.service /etc/systemd/system/openzo-firewall.service
systemctl daemon-reload
systemctl enable openzo-firewall.service
systemctl restart openzo-firewall.service

log "SearXNG (search backend, loopback only)"
mkdir -p /etc/openzo/searxng
if [ ! -f /etc/openzo/searxng/settings.yml ]; then
  sed "s#__OPENZO_SEARXNG_SECRET__#$(openssl rand -hex 32)#" deploy/searxng/settings.yml > /etc/openzo/searxng/settings.yml
fi
if ! docker inspect openzo-searxng >/dev/null 2>&1; then
  docker run -d --name openzo-searxng --restart unless-stopped \
    -p 127.0.0.1:8888:8080 -v /etc/openzo/searxng:/etc/searxng \
    searxng/searxng:latest >/dev/null
fi

log "Caddy (TLS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$ENV_FILE" > /etc/systemd/system/caddy.service.d/openzo.conf

log "openzo service"
install -m 644 deploy/openzo.service /etc/systemd/system/openzo.service
systemctl daemon-reload
systemctl enable openzo.service caddy
systemctl restart openzo.service
systemctl restart caddy

log "Health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${OPENZO_PORT:-8080}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${OPENZO_PORT:-8080}/api/health" && echo
echo
echo "openzo is up. Open https://${OPENZO_DOMAIN} and create the admin account (the first sign-up becomes admin)."
echo "Logs: journalctl -u openzo -f    Config: ${ENV_FILE}    Data: ${OPENZO_DATA:-/var/lib/openzo}"
