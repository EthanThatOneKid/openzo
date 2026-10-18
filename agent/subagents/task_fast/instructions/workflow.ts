import { createWorkflowInstruction } from "@zocomputer/agent-sdk";

// The how-to-work contract — the same SDK section the parent's composed
// stack carries (../../../instructions/stack.ts), rebuilt à la carte because
// declared subagents inherit nothing. Defaults match the parent's stack
// (workspaceNoun "workspace", no verify hint).
export default createWorkflowInstruction();
