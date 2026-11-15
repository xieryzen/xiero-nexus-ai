/**
 * Web search results of the supported search services, as one shape. Pure:
 * the request and the response of each service, without the network.
 *
 *   brave     GET  https://api.search.brave.com/res/v1/web/search?q=…&count=…
 *             X-Subscription-Token: <key>            → web.results[]
 *   tavily    POST https://api.tavily.com/search { query, max_results }
 *             Authorization: Bearer <key>            → results[]
 *   searxng   GET  <your instance>/search?q=…&format=json   → results[]
 */

export const SEARCH_PROVIDERS = ["brave", "tavily", "searxng"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

export const DEFAULT_SEARCH_URL: Record<SearchProvider, string | null> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
  searxng: null, // self-hosted: the address has to be given
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export const MAX_SEARCH_RESULTS = 10;

export function buildSearchRequest(
  provider: SearchProvider,
  endpoint: string,
  apiKey: string | undefined,
  query: string,
  count: number,
): SearchRequest {
  const n = Math.min(Math.max(1, Math.round(count)), MAX_SEARCH_RESULTS);
  switch (provider) {
    case "brave": {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(n));
      return {
        url: url.toString(),
        method: "GET",
        headers: { accept: "application/json", ...(apiKey ? { "x-subscription-token": apiKey } : {}) },
      };
    }
    case "tavily":
      return {
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: n }),
      };
    case "searxng": {
      // The address is the instance; its search page is /search.
      const base = endpoint.replace(/\/+$/, "");
      const url = new URL(/\/search$/.test(base) ? base : `${base}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      return {
        url: url.toString(),
        method: "GET",
        headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Snippets carry markup for highlighting the matched words.
  const plain = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export function parseSearchResults(provider: SearchProvider, json: unknown, count: number): SearchResult[] {
  if (!isRecord(json)) return [];
  const list =
    provider === "brave"
      ? isRecord(json.web) && Array.isArray(json.web.results)
        ? json.web.results
        : []
      : Array.isArray(json.results)
        ? json.results
        : [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const url = typeof item.url === "string" ? item.url : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: text(item.title, 200) || url,
      url,
      snippet: text(provider === "brave" ? item.description : item.content, 500),
    });
    if (out.length >= count) break;
  }
  return out;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");
}
