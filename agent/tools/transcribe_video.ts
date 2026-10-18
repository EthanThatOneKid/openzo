// Video transcription: ffmpeg pulls the audio track, then the same lanes as
// transcribe_audio (see ../lib/media.ts).
import { defineTool } from "eve/tools";
import { z } from "zod";
import { transcribe } from "../lib/media";

export default defineTool({
  description:
    "Transcribe the audio track of a video file in the workspace (mp4, mov, mkv, webm…). Saves the transcript next to the original and returns the text.",
  inputSchema: z.object({
    video_file_path: z.string().trim().min(1).describe("Video file, e.g. /workspace/Videos/talk.mp4."),
    language: z.string().trim().min(2).max(16).optional().describe("ISO language code if known."),
    output_format: z.enum(["text", "srt", "vtt", "json"]).optional().describe("Extra transcript file format to write (default text)."),
    model: z.string().trim().min(1).optional().describe("Model override."),
  }),
  async execute({ video_file_path, ...rest }) {
    return transcribe({ path: video_file_path, ...rest });
  },
});
