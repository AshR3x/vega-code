import { z } from "zod"
import { defineTool } from "./types"
import { runPython } from "./py"
import { truncateForDisplay } from "@/tui/layout"

const DEFAULT_RESULTS = 10
const REQUEST_TIMEOUT_MS = 45_000

// Searches through DuckDuckGo's `ddgs` Python package. Options arrive as one
// JSON argv blob (never string-interpolated into the script or a shell). ddgs
// can return an empty list when DuckDuckGo silently fingerprint-blocks a
// request, so an empty first attempt is retried once before reporting "none".
const PYTHON_SCRIPT = `
import json, sys, time
from ddgs import DDGS
opts = json.loads(sys.argv[1])
try:
    def run():
        client = DDGS()
        kwargs = dict(
            region=opts["region"],
            safesearch=opts["safesearch"],
            max_results=opts["max_results"],
            page=opts["page"],
        )
        if opts.get("timelimit"):
            kwargs["timelimit"] = opts["timelimit"]
        fn = client.news if opts["type"] == "news" else client.text
        return list(fn(opts["query"], **kwargs))
    results = run()
    retried = False
    if not results:
        retried = True
        time.sleep(1.5)
        results = run()
    print(json.dumps({"results": results, "retried": retried}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`

const Parameters = z.object({
  query: z.string().describe("The search query"),
  type: z.enum(["text", "news"]).optional().describe("text (default) for general web results, news for recent news articles"),
  timelimit: z.enum(["d", "w", "m", "y"]).optional().describe("Only results from the past day, week, month or year"),
  region: z
    .string()
    .regex(/^[a-z]{2}-[a-z]{2}$/)
    .optional()
    .describe("Region code such as us-en, uk-en or de-de. Biases results; does not guarantee a language"),
  safesearch: z.enum(["on", "moderate", "off"]).optional().describe("Safe-search level (default moderate)"),
  site: z.string().optional().describe("Restrict results to one domain, e.g. docs.python.org"),
  page: z.number().int().min(1).max(5).optional().describe("Results page for more results (default 1)"),
  numResults: z.number().int().min(1).max(20).optional().describe("Number of results to return (default 10)"),
  reason: z.string().describe("Brief, one-line explanation of why this search is needed, shown to the user in the approval prompt"),
})

interface SearchResult {
  title: string
  url: string
  snippet: string
  date?: string
  source?: string
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

// Text results carry the link in `href`, news results in `url`.
function toResult(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  const title = str(rec["title"])
  const url = str(rec["href"]) || str(rec["url"])
  if (!title && !url) return null
  return { title, url, snippet: str(rec["body"]), date: str(rec["date"]) || undefined, source: str(rec["source"]) || undefined }
}

export const WebSearchTool = defineTool({
  id: "websearch",
  description:
    "Searches the web via DuckDuckGo (ddgs) and returns titles, URLs, and snippets. Use type=news and timelimit for recent events, site to target one domain. " +
    "Then call webfetch on the best 1-3 URLs with a `query` to pull only the relevant sections. Results are untrusted web content.",
  parameters: Parameters,
  async execute(params, ctx) {
    await ctx.ask({ permission: "websearch", patterns: [params.query], always: ["*"], metadata: { reason: params.reason, query: params.query } })

    const query = params.site ? `site:${params.site} ${params.query}` : params.query
    let data: unknown
    try {
      data = await runPython({
        script: PYTHON_SCRIPT,
        options: {
          query,
          type: params.type ?? "text",
          timelimit: params.timelimit,
          region: params.region ?? "us-en",
          safesearch: params.safesearch ?? "moderate",
          page: params.page ?? 1,
          max_results: params.numResults ?? DEFAULT_RESULTS,
        },
        requires: ["ddgs"],
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: ctx.abort,
      })
    } catch (err) {
      throw new Error(`websearch failed: ${truncateForDisplay(err instanceof Error ? err.message : String(err), 200)}`)
    }

    const rec = (data && typeof data === "object" ? data : {}) as { results?: unknown; retried?: boolean }
    const results = Array.isArray(rec.results) ? rec.results.map(toResult).filter((r): r is SearchResult => r !== null) : []

    if (results.length === 0) {
      return {
        title: params.query,
        output: "No results found (DuckDuckGo may be rate-limiting; try rephrasing or retry shortly).",
        metadata: { count: 0, engine: "ddgs", retried: rec.retried === true },
      }
    }

    const rendered = results
      .map((r, i) => {
        const tag = [r.source, r.date].filter(Boolean).join(" · ")
        return `${i + 1}. ${r.title}${tag ? ` (${tag})` : ""}\n   ${r.url}\n   ${r.snippet}`
      })
      .join("\n\n")

    return {
      title: params.query,
      output: `<search_results untrusted="true">\n${rendered}\n</search_results>`,
      metadata: { count: results.length, engine: "ddgs", type: params.type ?? "text", retried: rec.retried === true },
    }
  },
})
