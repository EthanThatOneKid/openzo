// Web search without Zo's gateway: SearXNG / Brave / Tavily / Exa / DuckDuckGo,
// whichever the workspace configured (see ../lib/search.ts). The original
// gateway-executed tool is parked in reference/cloud-tools/.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { webSearch } from "../lib/search";

export default defineTool({
  description:
    "Search the web. Returns titles, URLs and short excerpts; follow up with webfetch to read a page in full.",
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500).describe("What to search for."),
    max_results: z.number().int().min(1).max(20).optional().describe("Maximum results (default 8)."),
  }),
  async execute({ query, max_results }) {
    return webSearch(query, max_results ?? 8);
  },
});
