// The stdlib file toolset over the session sandbox (`ctx.getSandbox()`). The
// tools in ../tools (read, write, edit, glob, grep, bash, tasks, look)
// re-export from this set; read_file / write_file carry disable shims because
// these replace them under the Claude Code names.
//
// The seed pointed this at /home/daytona (Zo's hosted Daytona image), which
// does not exist here: openzo's sandbox is ./host-sandbox.ts and its nominal
// root is eve's /workspace, mapped onto the user's real workspace.
import { createSandboxFileTools, DEFAULT_MEDIA_ORACLE } from "@zocomputer/agent-sdk";
import { activeLane, modelId, resolveModel } from "./models";

export const WORKSPACE_ROOT = "/workspace";

// `look` needs a model that can see. On the mock/setup lanes there is none, so
// the oracle stays the SDK default (its calls fail cleanly with a model error).
const lane = activeLane();
const mediaOracle =
  lane === "mock" || lane === "setup" || lane === "zo"
    ? DEFAULT_MEDIA_ORACLE
    : {
        model: resolveModel("vision"),
        modelName: modelId("vision"),
        capabilities: { image: true, pdf: lane !== "openai", video: false, audio: false },
      };

export const fileTools = createSandboxFileTools({
  workspaceRoot: WORKSPACE_ROOT,
  spillDir: `${WORKSPACE_ROOT}/.agent/tool-outputs`,
  mediaOracle: mediaOracle as never,
  subagentRoster: [
    {
      name: "task_fast",
      when: "quick, well-scoped subtasks — exploration, focused questions, mechanical edits — where a faster, cheaper model is enough",
    },
  ],
});
