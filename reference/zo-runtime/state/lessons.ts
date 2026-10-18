import { defineExternalState } from "@zocomputer/agent-sdk/state";

// Session-partitioned lesson memory — the thin M7 slice pulled forward for the
// M6 conformance proof (D11). Adversarial memory fixtures mount markdown lessons
// here; the seed agent's dynamic instructions read them at session start so the
// model actually sees poisoned guidance. Full mining/curation stays M7.
export default defineExternalState({
  name: "lessons",
  interface: "files",
  access: "r",
  intent: "private",
  suggestedDefaults: { engine: "zo-blob-r2", partition: "session" },
});
