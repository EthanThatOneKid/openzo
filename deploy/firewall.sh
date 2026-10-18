#!/usr/bin/env bash
# Network policy for openzo user containers (idempotent; run after docker).
#
#   - containers on the openzo bridge cannot reach each other (ICC off at
#     network creation), the host, or any private / link-local / CGNAT range —
#     which covers cloud metadata endpoints (169.254.169.254);
#   - they CAN reach the public internet, and exactly one host port: the
#     openzo internal listener (search proxy) on the bridge gateway.
set -euo pipefail
NET="${OPENZO_DOCKER_NETWORK:-openzo}"
SUBNET="${OPENZO_SUBNET:-172.30.0.0/24}"
GATEWAY="${OPENZO_INTERNAL_HOST:-172.30.0.1}"
INTERNAL_PORT="${OPENZO_INTERNAL_PORT:-8091}"
BRIDGE="br-openzo"

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" --gateway "$GATEWAY" \
    -o com.docker.network.bridge.name="$BRIDGE" \
    -o com.docker.network.bridge.enable_icc=false \
    "$NET"
fi

# Containers → other private networks (forwarded traffic).
iptables -N OPENZO-EGRESS 2>/dev/null || iptables -F OPENZO-EGRESS
iptables -A OPENZO-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 224.0.0.0/4; do
  iptables -A OPENZO-EGRESS -d "$range" -j DROP
done
iptables -A OPENZO-EGRESS -j RETURN
iptables -C DOCKER-USER -i "$BRIDGE" -j OPENZO-EGRESS 2>/dev/null || iptables -I DOCKER-USER -i "$BRIDGE" -j OPENZO-EGRESS

# Containers → the host itself (input traffic): only the internal listener and DNS.
iptables -N OPENZO-HOST 2>/dev/null || iptables -F OPENZO-HOST
iptables -A OPENZO-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OPENZO-HOST -p tcp -d "$GATEWAY" --dport "$INTERNAL_PORT" -j ACCEPT
iptables -A OPENZO-HOST -p udp --dport 53 -j ACCEPT
iptables -A OPENZO-HOST -p tcp --dport 53 -j ACCEPT
if [ -n "${OPENZO_ALLOW_HOST_PORTS:-}" ]; then
  for p in ${OPENZO_ALLOW_HOST_PORTS//,/ }; do iptables -A OPENZO-HOST -p tcp -d "$GATEWAY" --dport "$p" -j ACCEPT; done
fi
iptables -A OPENZO-HOST -j DROP
iptables -C INPUT -i "$BRIDGE" -j OPENZO-HOST 2>/dev/null || iptables -I INPUT -i "$BRIDGE" -j OPENZO-HOST

echo "openzo firewall applied on $BRIDGE ($SUBNET)"
