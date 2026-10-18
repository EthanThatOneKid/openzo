#!/usr/bin/env bash
# A stand-in `docker` CLI for testing openzo's gvisor driver on a box without
# Docker. It records every invocation to $FAKE_DOCKER_STATE/calls.log and
# emulates the handful of subcommands the driver uses, running each "container"
# as a local process of the openzo agent server with /workspace mapped to the
# bind-mounted host dir. Isolation is NOT emulated — only the control flow.
set -uo pipefail
STATE="${FAKE_DOCKER_STATE:?set FAKE_DOCKER_STATE}"
AGENT="${FAKE_DOCKER_AGENT:?set FAKE_DOCKER_AGENT (path to .output/server/index.mjs)}"
mkdir -p "$STATE/c"
printf '%s\n' "$*" >> "$STATE/calls.log"

cmd="$1"; shift
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

start_ctr() {
  local name="$1" dir="$STATE/c/$1"
  local ws state port
  ws="$(cat "$dir/workspace")"; state="$(cat "$dir/state")"; port="$(free_port)"
  echo "$port" > "$dir/port"
  (
    set -a; . "$dir/env"; set +a
    cd "$state" && OPENZO_WORKSPACE="$ws" HOME="$ws" PORT="$port" HOST=127.0.0.1 exec node "$AGENT"
  ) >> "$dir/log" 2>&1 &
  echo $! > "$dir/pid"
  echo running > "$dir/status"
}

stop_ctr() {
  local dir="$STATE/c/$1"
  [ -f "$dir/pid" ] && kill "$(cat "$dir/pid")" 2>/dev/null
  echo exited > "$dir/status"
}

case "$cmd" in
  info) echo '{"io.containerd.runc.v2":{},"runc":{},"runsc":{"path":"/usr/bin/runsc"}}' ;;
  image) echo "sha256:fake" ;;
  network)
    sub="$1"
    if [ "$sub" = inspect ]; then [ -f "$STATE/net" ] && cat "$STATE/net" || exit 1
    elif [ "$sub" = create ]; then echo "${!#}" > "$STATE/net"; fi ;;
  inspect)
    name="${!#}"
    [ -f "$STATE/c/$name/status" ] || exit 1
    cat "$STATE/c/$name/status" ;;
  run)
    name=""; envfile=""; ws=""; st=""
    while [ $# -gt 1 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --env-file) envfile="$2"; shift 2 ;;
        -v) case "$2" in *:/workspace) ws="${2%:/workspace}" ;; *:/state) st="${2%:/state}" ;; esac; shift 2 ;;
        -d) shift ;;
        --*|-p) shift 2 ;;
        *) shift ;;
      esac
    done
    dir="$STATE/c/$name"; mkdir -p "$dir"
    cp "$envfile" "$dir/env"; echo "$ws" > "$dir/workspace"; echo "$st" > "$dir/state"
    start_ctr "$name"
    echo "fakecontainer-$name" ;;
  start) start_ctr "$1" ;;
  stop) stop_ctr "${!#}" ;;
  rm) name="${!#}"; stop_ctr "$name"; rm -rf "${STATE:?}/c/$name" ;;
  port) echo "127.0.0.1:$(cat "$STATE/c/$1/port")" ;;
  logs) cat "$STATE/c/${!#}/log" ;;
  exec)
    while [ $# -gt 0 ]; do case "$1" in -it|-i|-t) shift ;; -w|-e) shift 2 ;; *) break ;; esac; done
    name="$1"; shift
    cd "$(cat "$STATE/c/$name/workspace")" && exec "$@" ;;
  ps) ls "$STATE/c" 2>/dev/null | sed 's/^/fakecontainer-/' ;;
  *) echo "fake-docker: unsupported $cmd" >&2; exit 1 ;;
esac
