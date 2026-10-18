#!/usr/bin/env bash
# openzo gate: typecheck, compile, build, lint the deploy kit, then run the
# end-to-end suite against a real host on both drivers.
#   bash tools/check.sh [--real]     --real adds one turn on the free model lane
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
pass=0; fail=0
step() {
  local name="$1"; shift
  if out=$("$@" 2>&1); then pass=$((pass + 1)); echo "  ok   $name"
  else fail=$((fail + 1)); echo "  FAIL $name"; echo "$out" | tail -25 | sed 's/^/       /'; fi
}

echo "openzo check"
step "agent typecheck" bash -c "npx tsc --noEmit -p . 2>&1 | grep -v '^node_modules/' | grep -E 'error TS' && exit 1 || exit 0"
step "eve compile: 0 errors, 0 warnings" bash -c "npx eve info >/dev/null 2>&1; python3 -c \"import json,sys; d=json.load(open('.eve/discovery/diagnostics.json')); d=d if isinstance(d,list) else d.get('diagnostics',[]); sys.exit(1 if d else 0)\""
step "agent build" npx eve build
step "web typecheck" bash -c "cd web && npx tsc -p tsconfig.app.json --noEmit"
step "web build" bash -c "cd web && npx vite build"
step "host typecheck" npx tsc -p host/tsconfig.json
step "deploy scripts shellcheck" shellcheck -S warning deploy/*.sh tools/*.sh
step "no Zo CDN or Zo API references in the shipped UI" bash -c "! grep -rlE 'static\\.z\\.computer|api\\.zo\\.computer' web/dist web/src host agent"
step "e2e (process driver)" bun tools/e2e.ts ${1:-}
step "e2e (gvisor driver, fake docker)" bun tools/e2e.ts --gvisor-fake

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
