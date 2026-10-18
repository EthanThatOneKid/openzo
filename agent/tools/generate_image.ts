// Image generation without Zo's media gateway: an OpenAI-compatible
// /images/generations API when configured, else the keyless Pollinations lane
// (see ../lib/media.ts). The gateway original is parked in reference/cloud-tools/.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateImage } from "../lib/media";

export default defineTool({
  description:
    "Generate images from a text prompt and save them into the workspace (default /workspace/Images/). Returns the saved file paths. Uses the image provider set in Settings → Media (an OpenAI-compatible API, or the keyless Pollinations/flux lane).",
  inputSchema: z.object({
    prompt: z.string().trim().min(1).max(4000).describe("What the image should show. Be specific about subject, style, composition and lighting."),
    file_stem: z.string().trim().min(1).max(80).optional().describe("Output file name without extension; derived from the prompt if omitted."),
    output_dir: z.string().trim().min(1).optional().describe("Workspace directory for the output (default /workspace/Images)."),
    aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]).optional().describe("Aspect ratio; ignored when size is given."),
    size: z.string().regex(/^\d+x\d+$/).optional().describe("Exact WIDTHxHEIGHT, e.g. 1024x1024."),
    n: z.number().int().min(1).max(4).optional().describe("Number of images (default 1)."),
    seed: z.number().int().nonnegative().optional().describe("Seed for reproducible output, when supported."),
    model: z.string().trim().min(1).optional().describe("Model id override (e.g. gpt-image-1, flux)."),
    quality: z.string().trim().min(1).optional().describe("Quality hint for OpenAI-compatible APIs (low, medium, high)."),
  }),
  async execute(input) {
    return generateImage(input);
  },
});
