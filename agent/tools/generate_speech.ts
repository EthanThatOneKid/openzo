// Text-to-speech: an OpenAI-compatible /audio/speech API when configured, else
// local piper (with a voice model) or espeak-ng (see ../lib/media.ts).
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateSpeech, piperVoices } from "../lib/media";

export default defineTool({
  description:
    "Generate spoken audio from text and save it into the workspace (default /workspace/Audio/). Returns the saved path. Uses Settings → Media → Speech: an OpenAI-compatible API (voices like alloy, nova, shimmer), or local piper / espeak-ng.",
  inputSchema: z.object({
    text: z.string().trim().min(1).max(100_000).describe("Text to speak."),
    file_stem: z.string().trim().min(1).max(80).optional().describe("Output file name without extension."),
    output_dir: z.string().trim().min(1).optional().describe("Workspace directory for the output (default /workspace/Audio)."),
    voice: z.string().trim().min(1).max(100).optional().describe("Voice id: an API voice (alloy, nova…), a piper voice name or fragment (e.g. en_GB-alan), or an espeak-ng language."),
    format: z.enum(["mp3", "wav"]).optional().describe("Audio format (default mp3)."),
    speed: z.number().min(0.25).max(4).optional().describe("Speaking speed multiplier."),
    instructions: z.string().trim().min(1).max(1000).optional().describe("Delivery/tone instruction (gpt-4o-mini-tts only)."),
    language: z.string().trim().min(2).max(16).optional().describe("Language code, used to pick a local voice."),
    model: z.string().trim().min(1).optional().describe("Speech model override."),
  }),
  async execute(input) {
    try {
      return await generateSpeech(input);
    } catch (e) {
      const voices = piperVoices().map((v) => v.name);
      throw new Error(`${(e as Error).message}${voices.length ? ` (piper voices here: ${voices.join(", ")})` : ""}`);
    }
  },
});
