// Image editing through an OpenAI-compatible /images/edits API (see ../lib/media.ts).
import { defineTool } from "eve/tools";
import { z } from "zod";
import { editImage } from "../lib/media";

export default defineTool({
  description:
    "Edit an existing workspace image (or combine it with reference images) from a text instruction. Saves the result next to the source as <name>-edited.<ext> unless output_dir is given, and returns the path. Needs an OpenAI-compatible image API in Settings → Media (the keyless lane cannot edit).",
  inputSchema: z.object({
    prompt: z.string().trim().min(1).max(4000).describe("The edit to make."),
    source_filepath: z.string().trim().min(1).describe("Image to edit, e.g. /workspace/Images/cat.png."),
    mask_filepath: z.string().trim().min(1).optional().describe("Optional PNG mask; transparent areas are the ones to change."),
    reference_filepaths: z.array(z.string().trim().min(1)).max(8).optional().describe("Extra images to draw from (gpt-image-1)."),
    file_suffix: z.string().trim().min(1).max(40).optional().describe("Suffix for the output name (default 'edited')."),
    output_dir: z.string().trim().min(1).optional().describe("Workspace directory for the output (default: the source's directory)."),
    size: z.string().regex(/^\d+x\d+$/).optional(),
    aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional(),
    model: z.string().trim().min(1).optional(),
    quality: z.string().trim().min(1).optional(),
  }),
  async execute(input) {
    return editImage(input);
  },
});
