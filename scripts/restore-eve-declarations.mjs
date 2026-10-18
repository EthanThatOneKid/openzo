/**
 * Restore the declaration files `eve` omits from its published tarball, for a
 * standalone seed install.
 *
 * The repo root has its own version of this (`scripts/restore-eve-declarations.ts`)
 * which covers `apps/api/seed/node_modules` when you install from the root. This one
 * exists for the case that one cannot reach: an **isolated** seed install, where only
 * the files tracked under `apps/api/seed/` are present and there is no repo root.
 * That's what `scripts/check-seed-build.ts` builds and what a deployed agent is, so
 * without this the seed's Chat SDK types are `any` in exactly the environment that
 * ships. Self-contained and dependency-free for that reason — nothing here may import
 * from the repo root.
 *
 * `patches/eve-declarations/` and its manifest are **generated**: the root's
 * `bun run restore-eve-declarations --generate` writes them here. Never hand-edit.
 *
 * This runs as `postinstall`, so it must never fail an install. A broken or missing
 * manifest warns and exits 0 — a deploy that ships slightly worse types is much
 * better than a deploy that doesn't happen.
 *
 * Be precise about what that trades away. For the **checked-in seed**, CI is the
 * backstop: `bun run check:dep-types` and the assertion in
 * `scripts/check-seed-build.ts` fail loudly if this didn't work. For a **deployed
 * agent**, there is no backstop — it installs on Vercel from its own repo and never
 * runs this repo's CI, so a warning here is the only signal, and it degrades to `any`
 * types rather than a failed deploy. That's the deliberate trade: agents keep
 * deploying. What makes it safe is that the agent's copy is produced from the same
 * seed CI does verify, so a break shows up here first.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";

const seedRoot = join(import.meta.dirname, "..");
const vendorDir = join(seedRoot, "patches/eve-declarations");
const manifestPath = join(vendorDir, "manifest.json");

function warn(message) {
  console.warn(`restore-eve-declarations (seed) — ${message}`);
}

/** Every installed copy of eve, across bun's node_modules layouts. */
function findEveInstalls() {
  const modules = join(seedRoot, "node_modules");
  if (!existsSync(modules)) return [];

  const candidates = [join(modules, "eve")];
  const store = join(modules, ".bun");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      candidates.push(join(store, entry, "node_modules/eve"));
    }
  }

  const found = new Map();
  for (const dir of candidates) {
    const packageJson = join(dir, "package.json");
    if (!existsSync(packageJson)) continue;
    let version;
    try {
      version = JSON.parse(readFileSync(packageJson, "utf8")).version;
    } catch {
      continue;
    }
    if (typeof version !== "string") continue;
    // Key on the resolved path: bun points a dependency's own `node_modules/eve` at
    // the store copy, so the same install is reachable several ways and would
    // otherwise be visited repeatedly.
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (!found.has(real)) found.set(real, { dir: real, version });
  }
  return [...found.values()];
}

function main() {
  if (!existsSync(manifestPath)) {
    // Nothing vendored. Either eve fixed its packaging and this was deleted, or the
    // seed was copied without the generated directory. Not this script's call.
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    warn(`${manifestPath} is not readable JSON; restored nothing.`);
    return;
  }
  if (!Array.isArray(manifest?.files) || !Array.isArray(manifest?.eveVersions)) {
    warn("manifest.json is missing a files or eveVersions array; restored nothing.");
    return;
  }

  const installs = findEveInstalls();
  if (installs.length === 0) return;

  let restored = 0;
  const skipped = new Set();

  for (const { dir, version } of installs) {
    // Never restore across eve versions — a chunk built against a different eve is
    // the exact hazard the root generator's assertions exist to prevent.
    if (!manifest.eveVersions.includes(version)) {
      skipped.add(version);
      continue;
    }
    // Only the files this eve version needs — a version whose tarball is complete
    // needs none, and different eve eras want different content-hashed chunk names.
    const wanted = manifest.files.filter(
      (file) => Array.isArray(file?.appliesTo) && file.appliesTo.includes(version),
    );
    for (const file of wanted) {
      if (typeof file?.path !== "string" || typeof file?.sha256 !== "string") continue;
      const source = join(vendorDir, file.path);
      const target = join(dir, file.path);
      if (!existsSync(source)) {
        warn(`${file.path} is listed in the manifest but not vendored here.`);
        continue;
      }
      if (existsSync(target)) {
        const current = createHash("sha256")
          .update(readFileSync(target, "utf8"))
          .digest("hex");
        if (current !== file.sha256) {
          warn(
            `${file.path} already exists in eve@${version} with unexpected content; ` +
              `left it alone.`,
          );
        }
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      restored += 1;
    }
  }

  if (skipped.size > 0) {
    warn(
      `eve ${[...skipped].sort().join(", ")} is installed but the vendored ` +
        `declarations were generated for ${manifest.eveVersions.join(", ")}; ` +
        `restored nothing for it. Re-run \`bun run restore-eve-declarations ` +
        `--generate\` from the repo root and commit the result.`,
    );
  }
  if (restored > 0) {
    console.log(
      `restore-eve-declarations (seed) — restored ${restored} missing eve ` +
        `declaration file(s).`,
    );
  }
}

try {
  main();
} catch (error) {
  // Never break an install; CI is where this is enforced.
  warn(`restored nothing (${error instanceof Error ? error.message : String(error)}).`);
}
