# openzo-mirror

A tracking mirror of the **openzo** releases, kept so upstream versions can be diffed,
read, and followed over time. openzo itself is a self-hosted Zo Computer: an agent with a
real shell, a persistent workspace, a terminal, and automations, for one person or a team,
with one gVisor container per user on a VPS. It is not affiliated with Zo Computer.

## Provenance

- Upstream: <https://openzo-site-failure.zocomputer.io>
- Upstream has **no git repository**. Releases are versioned source tarballs served from
  `https://openzo-site-failure.zocomputer.io/downloads/openzo-<version>.tar.gz`.
- Every commit here is a verbatim import of one of those tarballs, tagged `v<version>`.
  Nothing in the upstream tree is edited, and the mirror adds no upstream-facing files.
- Files that belong to the mirror, not upstream, are `.mirror/`, `.github/`, and this file.
- openzo ships no license file, so this mirror redistributes nothing. It is a private,
  unmodified copy kept for reference. Do not make it public unless upstream adds a license.

## How updates arrive

`.github/workflows/sync-upstream.yml` runs weekly (Mondays 15:00 UTC) and on demand:

1. `.mirror/sync.sh` reads the version the site currently publishes, from the download
   template in the site's JavaScript bundle, falling back to probing candidate tarballs by
   HTTP content type.
2. Every published version newer than the newest local tag is downloaded, verified against
   the `version` field in its `package.json`, unpacked over the tree, committed, and tagged.
3. The commit and tag are pushed, and an issue is opened with the diffstat against the
   previous release.

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
