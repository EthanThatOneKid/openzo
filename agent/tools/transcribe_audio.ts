// Speech-to-text: an OpenAI-compatible /audio/transcriptions API (OpenAI,
// Groq…) when configured, else local faster-whisper (see ../lib/media.ts).
import { defineTool } from "eve/tools";
import { z } from "zod";
import { transcribe } from "../lib/media";

export default defineTool({
  description:
    "Transcribe an audio file in the workspace. Saves the transcript next to the original (<name>.transcript.txt, plus .srt/.vtt/.json when asked) and returns the text. Uses Settings → Media → Transcription (OpenAI/Groq-compatible API or local faster-whisper).",
  inputSchema: z.object({
    audio_file_path: z.string().trim().min(1).describe("Audio file, e.g. /workspace/Audio/note.mp3."),
    language: z.string().trim().min(2).max(16).optional().describe("ISO language code if known (improves accuracy)."),
    output_format: z.enum(["text", "srt", "vtt", "json"]).optional().describe("Extra transcript file format to write (default text)."),
    model: z.string().trim().min(1).optional().describe("Model override (whisper-1, whisper-large-v3, or a faster-whisper size like base/small)."),
  }),
  async execute({ audio_file_path, ...rest }) {
    return transcribe({ path: audio_file_path, ...rest });
  },
});
