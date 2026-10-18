import { fileTools } from "../lib/file-tools";

// The SDK's composed instruction stack, pre-configured for the sandbox
// topology by createSandboxFileTools: workflow → planning → parallel tools
// → subagents → media (the look oracle) → asking → communicating. No
// repo-conventions section — the workspace lives in the session sandbox, not
// on this process's disk, so nested AGENTS.md files ride the read tool's
// dir-conventions riders instead. The agent's persona and rules — what the
// Builder authors — stay in ../instructions.md; eve composes both, flat file
// first.
// Session-scoped like every dynamic instruction — part of the cached prefix.
export default fileTools.instructions.stack;
