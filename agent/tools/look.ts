import { fileTools } from "../lib/file-tools";

// The media oracle: ask a capable model (Gemini 3 Flash via the Zo metering
// proxy) one question about a media file in the workspace — this agent's own
// model gets sandbox media as metadata only, so `look` is how it sees
// images, PDFs, video, and audio. No companion instruction on purpose (the
// seed stays a blank slate); the tool's own description carries the routing.
const look = fileTools.tools.look;
if (look === undefined) {
  throw new Error("shared/file-tools.ts must wire mediaOracle for the look tool");
}
export default look;
