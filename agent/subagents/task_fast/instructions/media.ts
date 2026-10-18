import { createLookInstruction } from "@zocomputer/agent-sdk";
import { fileTools } from "../../../lib/file-tools";

// The media-delegation playbook for this child, built from the PARENT's
// resolved oracle (the child's `look` is the parent's instance, so the
// playbook must describe the model it actually runs) and deliberately
// WITHOUT parentCapabilities: sandbox reads return metadata only, so no
// media is viewable inline here regardless of the tier model.
const oracle = fileTools.mediaOracle;
if (oracle === null) {
  throw new Error(
    "shared/file-tools.ts must wire mediaOracle for the task child's media instruction",
  );
}
export default createLookInstruction({
  modelName: oracle.modelName,
  capabilities: oracle.capabilities,
});
