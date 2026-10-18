// Self-hosted web search. Zo's own web_search runs through its metered
// gateway; openzo calls a search backend directly, first configured wins:
//
//   SEARXNG_URL      a SearXNG instance (the VPS compose ships one) — no key
//   BRAVE_API_KEY    Brave Search API
//   TAVILY_API_KEY   Tavily
//   EXA_API_KEY      Exa
//   (none)           DuckDuckGo's HTML endpoint — keyless, but datacenter IPs
//                    usually get a bot wall, so a VPS should set one above.
export interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
}

export interface SearchOutcome {
  provider: string;
  query: string;
  results: SearchResult[];
}

const env = (k: string) => process.env[k]?.trim() || undefined;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export function searchProvider(): string {
  if (env("SEARXNG_URL")) return "searxng";
  if (env("BRAVE_API_KEY")) return "brave";
  if (env("TAVILY_API_KEY")) return "tavily";
  if (env("EXA_API_KEY")) return "exa";
  return "duckduckgo";
}

async function json(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export async function webSearch(query: string, max = 8): Promise<SearchOutcome> {
  const provider = searchProvider();
  let results: SearchResult[] = [];
  switch (provider) {
    case "searxng": {
      // Append rather than resolve: the URL may carry a path prefix
      // (gVisor runtimes reach SearXNG via the host's /searxng proxy).
      const u = new URL(`${env("SEARXNG_URL")!.replace(/\/+$/, "")}/search`);
      u.searchParams.set("q", query);
      u.searchParams.set("format", "json");
      const d = await json(u.toString());
      results = (d.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url, excerpt: r.content ?? "" }));
      break;
    }
    case "brave": {
      const d = await json(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
        headers: { "X-Subscription-Token": env("BRAVE_API_KEY")!, Accept: "application/json" },
      });
      results = (d.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, excerpt: strip(r.description ?? "") }));
      break;
    }
    case "tavily": {
      const d = await json("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env("TAVILY_API_KEY")}` },
        body: JSON.stringify({ query, max_results: max }),
      });
      results = (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, excerpt: r.content ?? "" }));
      break;
    }
    case "exa": {
      const d = await json("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env("EXA_API_KEY")! },
        body: JSON.stringify({ query, numResults: max, contents: { text: { maxCharacters: 600 } } }),
      });
      results = (d.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url, excerpt: r.text ?? "" }));
      break;
    }
    default: {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(20_000),
      });
      const html = await res.text();
      const re = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      for (const m of html.matchAll(re)) {
        let url = m[1]!;
        const uddg = /[?&]uddg=([^&]+)/.exec(url);
        if (uddg) url = decodeURIComponent(uddg[1]!);
        results.push({ title: strip(m[2]!), url, excerpt: strip(m[3]!) });
      }
      if (results.length === 0) {
        throw new Error(
          `DuckDuckGo returned no parseable results (HTTP ${res.status}; datacenter IPs are usually bot-walled). ` +
            "Set SEARXNG_URL, BRAVE_API_KEY, TAVILY_API_KEY or EXA_API_KEY in the workspace settings.",
        );
      }
    }
  }
  return { provider, query, results: results.slice(0, max) };
}
