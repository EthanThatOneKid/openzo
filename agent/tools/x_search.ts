// Search recent posts on X. Needs the user's own X API bearer token
// (X_BEARER_TOKEN in Settings → Secrets); X has no keyless search.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Search recent posts on X (Twitter) from the last 7 days with X's query syntax (from:user, -is:retweet, lang:en, \"exact phrase\"). Needs X_BEARER_TOKEN in the user's secrets; without it, say so and fall back to web_search.",
  inputSchema: z.object({
    query: z.string().min(1).max(512),
    max_results: z.number().int().min(10).max(100).optional(),
  }),
  async execute({ query, max_results }) {
    const token = process.env.X_BEARER_TOKEN?.trim();
    if (!token) return { error: "X search needs an X API bearer token: add X_BEARER_TOKEN in Settings → Secrets (developer.x.com). Use web_search instead for now." };
    const qs = new URLSearchParams({
      query,
      max_results: String(max_results ?? 20),
      "tweet.fields": "created_at,public_metrics,author_id,lang",
      expansions: "author_id",
      "user.fields": "username,name,verified",
    });
    const res = await fetch(`https://api.x.com/2/tweets/search/recent?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`X answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as any;
    const users = new Map((data.includes?.users ?? []).map((u: any) => [u.id, u]));
    return {
      results: (data.data ?? []).map((t: any) => {
        const u: any = users.get(t.author_id);
        return { text: t.text, author: u ? `@${u.username}` : t.author_id, created_at: t.created_at, metrics: t.public_metrics, url: u ? `https://x.com/${u.username}/status/${t.id}` : undefined };
      }),
    };
  },
});
