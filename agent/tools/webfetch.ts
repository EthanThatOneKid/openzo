import {
  createWebFetchTool,
  createWorkspace,
  lookFetchedImageHint,
  lookFetchedMediaHint,
} from "@zocomputer/agent-sdk";
import { fileTools, WORKSPACE_ROOT } from "../lib/file-tools";

// Fetch a URL and return it as markdown (or text/raw HTML) — the fetch
// itself runs on the eve process, not the sandbox. INLINE-FIRST mode (no
// spillDir), deliberately: a spill file would land on the deployed
// function's disk, where the sandbox-backed `read` can't reach it. Whole
// content returns inline up to the SDK's 100k-char default; only extremely
// long pages truncate head+tail.
//
// Fetched media can't attach on this topology (no media follow-up delivery), so the
// unavailable-media hints route download-then-look: bash runs in the
// sandbox, where `look` reads. Derived from the SAME resolved oracle as
// shared/file-tools.ts so the hints name the model look actually calls.
const oracle = fileTools.mediaOracle;
// Per-kind: each builder returns undefined for kinds the oracle can't view,
// leaving the factory's honest defaults in place.
const imageHint = oracle !== null ? lookFetchedImageHint(oracle) : undefined;
const mediaHint = oracle !== null ? lookFetchedMediaHint(oracle) : undefined;

export default createWebFetchTool({
  // Used only for spill-label math (unused in inline-first mode); points at
  // the sandbox work dir for consistency with shared/file-tools.ts.
  workspace: createWorkspace(WORKSPACE_ROOT),
  ...(imageHint !== undefined ? { imageUnavailableHint: imageHint } : {}),
  ...(mediaHint !== undefined ? { mediaUnavailableHint: mediaHint } : {}),
});
