#!/usr/bin/env bash
# Source tarball for copying openzo to a server: no node_modules, builds, data
# or the private zoapp copy. `scp dist/openzo-<v>.tar.gz root@vps:` then
# `tar xzf` and run deploy/install.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
v="$(node -p 'require("./package.json").version')"
mkdir -p dist
tar --exclude=./node_modules --exclude=./web/node_modules --exclude=./web/dist \
    --exclude=./.eve --exclude=./.output --exclude=./data --exclude=./zoapp \
    --exclude=./dist --exclude=./.git --exclude=./promo/out --exclude=./promo/audio \
    --transform "s#^\./#openzo/#" -czf "dist/openzo-$v.tar.gz" .
echo "dist/openzo-$v.tar.gz ($(du -h "dist/openzo-$v.tar.gz" | cut -f1))"
