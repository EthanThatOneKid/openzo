import { defineExternalState } from "@zocomputer/agent-sdk/state";

// The default per-session runtime sandbox, declared as external state (design
// doc D10). eve's `zoBackend` resolves this declaration through POST
// /state/handles, so the sandbox's lifecycle and partition are user-overridable
// like any other state — rebind it to `partition: user` for a durable personal
// workspace with zero agent-code changes. See plans/dcosson/external-state-sandbox.md.
//
// `interface: "exec"` is the sandbox's primary capability; the same broker
// handle also serves files (SFTP) over one SSH channel — `sandbox-daytona`
// declares interfaces `exec`+`files` in the engine catalog.
export default defineExternalState({
  name: "scratch",
  interface: "exec",
  access: "rw",
  intent: "private",
  suggestedDefaults: { engine: "sandbox-daytona", partition: "session" },
});
