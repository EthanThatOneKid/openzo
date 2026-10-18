import { defineExternalState } from "@zocomputer/agent-sdk/state";

export default defineExternalState({
  name: "files",
  interface: "files",
  access: "rw",
  intent: "private",
  suggestedDefaults: { engine: "zo-blob-r2", partition: "session" },
});
