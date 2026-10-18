// Video generation through a configured provider (fal.ai or Replicate). There
// is no keyless lane; without a key the tool says how to configure one.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateVideo } from "../lib/media";

export default defineTool({
  description:
    "Generate a short video from a text instruction, optionally starting from a workspace image. Saves it into the workspace (default /workspace/Videos/) and returns the path. Needs fal.ai or Replicate configured in Settings → Media → Video; can take several minutes.",
  inputSchema: z.object({
    instruction: z.string().trim().min(1).max(4000).describe("What the video should show and how it moves."),
    filepath: z.string().trim().min(1).optional().describe("Optional start-frame image in the workspace."),
    duration_seconds: z.number().int().min(1).max(30).optional(),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
    model: z.string().trim().min(1).optional().describe("Provider model id override (e.g. fal-ai/kling-video/v2.1/standard/text-to-video)."),
    file_stem: z.string().trim().min(1).max(80).optional(),
    output_dir: z.string().trim().min(1).optional(),
  }),
  async execute(input) {
    return generateVideo(input);
  },
});
