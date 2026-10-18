// task_fast — the fast task tier: a full-capability copy of the parent agent
// pinned to a fast, cheap model, sharing the parent session's sandbox. Eve has
// no per-call model parameter — a subagent's model compiles from this file —
// so this directory IS the model knob: the parent picks a model by picking the
// tool, guided by the description below.
//
// Model lanes come from ../../lib/models.ts (the "fast" tier of whatever lane
// the parent runs on). The lane must be resolvable here because a declared
// subagent compiles into its own bundle and may load without the parent's
// agent.ts having run.
import "@zocomputer/agent-sdk/ai/register";
import {
  createTaskAgent,
  STDLIB_EXTERNAL_DEPENDENCIES,
} from "@zocomputer/agent-sdk";
import { modelId, resolveModel } from "../../lib/models";

export default createTaskAgent({
  model: resolveModel("fast"),
  modelName: modelId("fast"),
  use: "Prefer it for quick, well-scoped subtasks — exploration and how/where/what questions, mechanical edits, focused verification — where a fast, cheap model is enough.",
  capabilityNote:
    "It cannot ask the user anything and cannot request state consent — questions and approval-gated state operations stay with you.",
  workspaceNoun: "workspace",
  build: { externalDependencies: [...STDLIB_EXTERNAL_DEPENDENCIES] },
});
