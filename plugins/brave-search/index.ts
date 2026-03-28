/**
 * Brave Search plugin for Beige.
 *
 * Provides web search using the Brave Search API.
 *
 * Config (passed via pluginConfigs or plugins.brave-search.config):
 *   apiKey:         Brave Search API key (required). Falls back to BRAVE_API_KEY env var.
 *   maxResults:     Default number of results to return (1-20, default: 5)
 *   timeoutSeconds: HTTP request timeout in seconds (default: 30)
 *
 * Get an API key at https://brave.com/search/api/
 */

import type {
  PluginInstance,
  PluginContext,
  PluginRegistrar,
  ToolResult,
} from "@matthias-hausberger/beige";

// ── Config ────────────────────────────────────────────────────────────────────

interface BraveSearchConfig {
  apiKey?: string;
  maxResults?: number;
  timeoutSeconds?: number;
}

// ── API response types ────────────────────────────────────────────────────────

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Plugin entry point ────────────────────────────────────────────────────────

export function createPlugin(
  config: Record<string, unknown>,
  ctx: PluginContext
): PluginInstance {
  const cfg = config as BraveSearchConfig;

  // Resolve API key: explicit config takes priority over environment variable
  const resolvedApiKey: string | undefined =
    (cfg.apiKey?.trim() || undefined) ?? process.env.BRAVE_API_KEY?.trim();

  if (!resolvedApiKey) {
    ctx.log.warn(
      "Brave Search: no API key configured. " +
        "Set apiKey in plugin config or BRAVE_API_KEY env var."
    );
  }

  const defaultCount = Math.min(
    Math.max(cfg.maxResults ?? DEFAULT_MAX_RESULTS, 1),
    MAX_RESULTS_CAP
  );
  const timeoutMs = (cfg.timeoutSeconds ?? 30) * 1000;

  // ── Core search function ─────────────────────────────────────────────

  async function search(
    key: string,
    query: string,
    opts: { count?: number; offset?: number; country?: string }
  ): Promise<BraveWebResult[]> {
    const count = Math.min(Math.max(opts.count ?? defaultCount, 1), MAX_RESULTS_CAP);

    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    if (opts.offset) url.searchParams.set("offset", String(opts.offset));
    if (opts.country) url.searchParams.set("country", opts.country.toUpperCase());

    ctx.log.info(
      `brave search: "${query}" count=${count}` +
        (opts.offset ? ` offset=${opts.offset}` : "") +
        (opts.country ? ` country=${opts.country.toUpperCase()}` : "")
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Brave Search API error ${response.status}: ${detail || response.statusText}`
      );
    }

    const data = (await response.json()) as BraveSearchResponse;
    return data.web?.results ?? [];
  }

  // ── Output formatter ─────────────────────────────────────────────────

  function formatResults(query: string, results: BraveWebResult[]): string {
    if (results.length === 0) {
      return `No results found for: ${query}`;
    }

    const lines: string[] = [`Search results for: ${query}\n`];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.title ?? "(no title)"}`);
      if (r.url) lines.push(`   ${r.url}`);
      if (r.description) {
        const snippet =
          r.description.length > 200 ? r.description.slice(0, 197) + "…" : r.description;
        lines.push(`   ${snippet}`);
      }
      if (r.age) lines.push(`   ${r.age}`);
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  // ── Tool handler ─────────────────────────────────────────────────────

  async function handler(args: string[]): Promise<ToolResult> {
    const USAGE =
      "Usage:\n" +
      "  brave-search search <query>\n" +
      "  brave-search search <query> --count <n>       (1-20, default: 10)\n" +
      "  brave-search search <query> --country <code>  (e.g. US, DE, GB)\n" +
      "  brave-search search <query> --offset <n>      (pagination)";

    if (args.length === 0 || args[0] !== "search") {
      return { output: USAGE, exitCode: 1 };
    }

    if (!resolvedApiKey) {
      return {
        output:
          "Error: Brave Search API key not configured.\n" +
          "Set apiKey in the plugin config or the BRAVE_API_KEY environment variable.\n" +
          "Get a key at https://brave.com/search/api/",
        exitCode: 1,
      };
    }

    // Parse remaining args: collect query words, then flags
    let count: number | undefined;
    let offset: number | undefined;
    let country: string | undefined;
    const queryWords: string[] = [];

    let i = 1; // skip "search"
    while (i < args.length) {
      switch (args[i]) {
        case "--count":
          count = parseInt(args[++i] ?? "", 10);
          if (isNaN(count) || count < 1) {
            return { output: "Error: --count must be a positive integer", exitCode: 1 };
          }
          break;
        case "--offset":
          offset = parseInt(args[++i] ?? "", 10);
          if (isNaN(offset) || offset < 0) {
            return { output: "Error: --offset must be a non-negative integer", exitCode: 1 };
          }
          break;
        case "--country":
          country = args[++i];
          if (!country) {
            return { output: "Error: --country requires a value (e.g. US, DE, GB)", exitCode: 1 };
          }
          break;
        default:
          queryWords.push(args[i]);
      }
      i++;
    }

    const query = queryWords.join(" ").trim();
    if (!query) {
      return { output: "Error: search query cannot be empty\n\n" + USAGE, exitCode: 1 };
    }

    try {
      const results = await search(resolvedApiKey, query, { count, offset, country });
      return { output: formatResults(query, results), exitCode: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error(`Brave Search failed: ${msg}`);
      return { output: `Search failed: ${msg}`, exitCode: 1 };
    }
  }

  // ── Plugin instance ───────────────────────────────────────────────────

  return {
    register(reg: PluginRegistrar): void {
      reg.tool({
        name: "brave-search",
        description:
          "Search the web using the Brave Search API. " +
          "Privacy-focused, fast web search with optional result limits and country filtering.",
        commands: [
          "search <query>                         — Search the web",
          "search <query> --count <n>             — Number of results (1-20, default: 10)",
          "search <query> --country <code>        — Country-specific results (e.g. US, DE, GB)",
          "search <query> --offset <n>            — Pagination: skip first N results",
        ],
        handler,
      });
    },

    async start(): Promise<void> {
      ctx.log.info(
        resolvedApiKey
          ? "Brave Search plugin ready"
          : "Brave Search plugin started — WARNING: no API key set"
      );
    },

    async stop(): Promise<void> {
      // nothing to tear down
    },
  };
}
