#!/usr/bin/env bash
# Import published openzo releases into this mirror.
#
# Upstream openzo publishes no git repository. Releases exist only as
# <SITE>/downloads/openzo-<version>.tar.gz on the project site. This script
# resolves the newest published version, downloads every release newer than the
# newest local tag, and imports each one as a commit plus an annotated tag, so
# successive releases diff as ordinary git history.
#
# Usage:
#   .mirror/sync.sh                  # import anything newer than the newest tag
#   VERSION=0.4.0 .mirror/sync.sh    # import one specific version
#   DRY_RUN=1 .mirror/sync.sh        # resolve and report, change nothing
#
# Commits and tags only; the caller pushes. OPENZO_SITE overrides the origin.
set -euo pipefail

SITE="${OPENZO_SITE:-https://openzo-site-failure.zocomputer.io}"
DRY_RUN="${DRY_RUN:-0}"
VERSION="${VERSION:-}"
KEEP=(.git .github .mirror MIRROR.md)

log() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
emit() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

cd "$(dirname "$0")/.."
command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"

# --- upstream discovery ----------------------------------------------------

site_version() {
  # The site bundle carries the version next to the download template, as
  # `const <x>="1.2.3",<y>=`/downloads/openzo-${<x>}.tar.gz``.
  local html js
  html="$(curl -fsSL "$SITE/" 2>/dev/null)" || return 1
  js="$(printf '%s' "$html" | grep -o -E '/assets/index-[A-Za-z0-9_.-]+\.js' | head -n1)"
  [ -n "${js:-}" ] || return 1
  js="$(curl -fsSL "$SITE$js" 2>/dev/null)" || return 1
  printf '%s' "$js" | python3 -c '
import re
import sys

bundle = sys.stdin.read()
at = bundle.find("downloads/openzo-")
if at < 0:
    sys.exit(1)
found = re.findall(r"\"(\d+\.\d+\.\d+)\"", bundle[max(0, at - 400):at])
if not found:
    sys.exit(1)
print(found[-1])
'
}

tarball_exists() {
  # A published release answers application/gzip. Unknown paths fall back to the
  # site's HTML shell, so the content type is the only reliable signal.
  local ct
  ct="$(curl -fsSI "$SITE/downloads/openzo-$1.tar.gz" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1) == "content-type:" { print $2; exit }')"
  case "${ct:-}" in
    application/gzip | application/x-gzip | application/octet-stream) return 0 ;;
    *) return 1 ;;
  esac
}

newest_local_tag() { git tag --list 'v*' | sed 's/^v//' | sort -V | tail -n1; }

is_newer() { # is_newer <candidate> <baseline>
  local newest
  newest="$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -n1)"
  [ "$newest" = "$1" ] && [ "$1" != "$2" ]
}

between_candidates() { # every version spanned by <last>..<newest>
  local last="$1" newest="$2" lmaj lmin lpat nmaj nmin npat m p lo
  IFS=. read -r lmaj lmin lpat <<<"$last"
  IFS=. read -r nmaj nmin npat <<<"$newest"
  if [ "$lmaj" != "$nmaj" ] || [ "$lmin" -gt "$nmin" ]; then
    printf '%s\n' "$newest"
    return 0
  fi
  for m in $(seq "$lmin" "$nmin"); do
    lo=0
    [ "$m" = "$lmin" ] && lo="$lpat"
    for p in $(seq "$lo" "$npat"); do printf '%s.%s.%s\n' "$lmaj" "$m" "$p"; done
  done
}

walk_candidates() { # bounded sweep, used only when the site version is unreadable
  local last="$1" maj min pat m p
  IFS=. read -r maj min pat <<<"$last"
  for p in $(seq $((pat + 1)) $((pat + 12))); do printf '%s.%s.%s\n' "$maj" "$min" "$p"; done
  for m in $(seq $((min + 1)) $((min + 6))); do
    for p in 0 1 2; do printf '%s.%s.%s\n' "$maj" "$m" "$p"; done
  done
  printf '%s.0.0\n' "$((maj + 1))"
}

# --- import ----------------------------------------------------------------

import_version() {
  local version="$1" tmp pkgver stale
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  log "importing openzo $version"
  curl -fsSL "$SITE/downloads/openzo-$version.tar.gz" -o "$tmp/openzo.tar.gz" \
    || die "download failed: openzo-$version.tar.gz"
  tar xzf "$tmp/openzo.tar.gz" -C "$tmp" || die "extract failed: openzo-$version.tar.gz"
  [ -f "$tmp/openzo/package.json" ] || die "unexpected archive layout for $version"
  pkgver="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$tmp/openzo/package.json")"
  [ "$pkgver" = "$version" ] || die "archive for $version contains version $pkgver"

  find . -mindepth 1 -maxdepth 1 \
    -not -name "${KEEP[0]}" -not -name "${KEEP[1]}" \
    -not -name "${KEEP[2]}" -not -name "${KEEP[3]}" \
    -exec rm -rf {} +
  cp -a "$tmp/openzo/." .

  git add -A
  stale="$(git diff --cached --name-status | wc -l)"
  git commit -q \
    -m "Import openzo $version" \
    -m "Verbatim upstream release source: $SITE/downloads/openzo-$version.tar.gz ($stale path(s) changed)"
  git tag -a "v$version" -m "openzo $version"
  log "  committed and tagged v$version ($stale path(s) changed)"
}

# --- run -------------------------------------------------------------------

previous="$(newest_local_tag)"
target="${VERSION:-}"

if [ -n "$target" ]; then
  log "target pinned to openzo $target"
elif target="$(site_version)"; then
  log "site publishes openzo $target"
else
  target=""
  log "could not read a version from the site bundle; probing instead"
fi

if [ -n "$target" ]; then
  candidates="$(between_candidates "${previous:-0.0.0}" "$target")"
elif [ -n "$previous" ]; then
  candidates="$(walk_candidates "$previous")"
else
  die "no local tags and no resolvable upstream version: nothing to anchor on"
fi

todo=""
for v in $(printf '%s\n' "$candidates" | sort -V -u); do
  [ -n "$v" ] || continue
  is_newer "$v" "${previous:-0.0.0}" || continue
  tarball_exists "$v" || continue
  todo="$todo $v"
done
todo="$(printf '%s\n' $todo | sed '/^$/d' | sort -V -u | tr '\n' ' ' | sed 's/ $//')"

if [ -z "$todo" ]; then
  log "up to date: nothing published beyond v${previous:-none}"
  emit imported ""
  emit previous "$previous"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: would import $todo"
  exit 0
fi

imported=""
for v in $todo; do
  import_version "$v"
  imported="$imported $v"
done

emit imported "$(printf '%s' "$imported" | sed 's/^ //')"
emit previous "$previous"
log "imported:$(printf '%s' "$imported")"
