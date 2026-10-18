# openzo (unofficial mirror)

An unofficial, public tracking mirror of the **openzo** releases, kept so upstream versions
can be read, diffed, and followed over time.

**This repository is not upstream.** openzo is published by someone else, and this mirror is
not affiliated with that project or with Zo Computer. Upstream publishes openzo as versioned
source tarballs on a project site and has no git repository of its own, so every commit here
is a verbatim import of one of those tarballs.

openzo itself is a self-hosted Zo Computer: an agent with a real shell, a persistent
workspace, a terminal, and automations, for one person or a team, with one gVisor container
per user on a VPS.

## Provenance

- Upstream site: <https://openzo-site-failure.zocomputer.io>
- Releases: `https://openzo-site-failure.zocomputer.io/downloads/openzo-<version>.tar.gz`
- Every commit here is a verbatim import of one tarball, tagged `v<version>`. Nothing in the
  upstream tree is edited.
- Files that belong to the mirror rather than upstream: `.mirror/`, `.github/`, and this file.
- Licensing: upstream ships no license file. This mirror republishes the release tarballs
  that upstream already serves publicly, unmodified and with no claim of rights over them.
  A missing license means the terms are unclear, not that the code is free to reuse, so ask
  the upstream author before building on it.

## How updates arrive

`.github/workflows/sync-upstream.yml` runs weekly (Mondays 15:00 UTC) and on demand:

1. `.mirror/sync.sh` reads the version the site currently publishes, from the download
   template in the site's JavaScript bundle, falling back to probing candidate tarballs by
   HTTP content type.
2. Every published version newer than the newest local tag is downloaded, verified against
   the `version` field in its `package.json`, unpacked over the tree, committed, and tagged.
3. The commit and tag are pushed, and an issue is opened with a per-version diffstat.

Scheduled workflows on GitHub disable themselves after 60 days without repository
activity, which the weekly commits normally prevent. If the schedule ever stops, run the
workflow manually.

## Manual use

```bash
.mirror/sync.sh                  # import anything newer than the newest tag
VERSION=0.4.0 .mirror/sync.sh    # import one specific version
DRY_RUN=1 .mirror/sync.sh        # resolve and report, change nothing
git push origin HEAD:main --follow-tags   # publish what was imported
```

Requires `curl`, `tar`, `git`, and `python3` (used to parse the site bundle and the release
`package.json`).

## Reading a release

```bash
git show v0.3.0 --stat          # what a release touched
git diff v0.2.0 v0.3.0          # what changed between two releases
git checkout v0.3.0             # read or run a specific release
```

Upstream's own documentation lives in `docs/GUIDE.md` inside each release, and the site
serves the same content at `/docs`.
