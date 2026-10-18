// Re-export of the parent's tool: the task child runs the parent's full tool
// surface (a declared subagent inherits nothing, so parity is by re-export).
// The parent's instances are sandbox-backed and already attach-disabled, so
// they are child-safe as-is.
export { default } from "../../../tools/edit";
