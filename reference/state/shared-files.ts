import { defineExternalState } from "@zocomputer/agent-sdk/state";

export default defineExternalState({
  name: "shared-files",
  interface: "files",
  access: "rw",
  intent: "shared",
  suggestedDefaults: { engine: "zo-blob-r2", partition: "none" },
});
