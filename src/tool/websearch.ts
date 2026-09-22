import { z } from "zod"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { defineTool } from "./types"
import { truncateForDisplay } from "@/tui/layout"

const execFileAsync = promisify(execFile)

const DEFAULT_RESULTS = 10
const REQUEST_TIMEOUT_MS = 45_000
const RESOLVE_TIMEOUT_MS = 10_000

// Searches through DuckDuckGo's `ddgs` Python package, which reads the search
// endpoint itself (far less scrape-fragile than the old `html.duckduckgo.com`
// POST+parse approach). The query goes in as argv, never string-interpolated,
// so there's no injection surface through the shell.
const PYTHON_SCRIPT = `
import json, sys
from ddgs import DDGS
try:
    results = list(DDGS().text(sys.argv[1], max_results=int(sys.argv[2])))
    print(json.dumps(results, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`

const Parameters = z.object({
  query: z.string().describe("The search query"),
  numResults: z.number().int().min(1).max(20).optional().describe("Number of results to return (default 10)"),
})

interface SearchResult {
  title: string
  url: string
  snippet: string
}

type PythonRunnable = { cmd: string; pre: string[] }
let resolvedPython: PythonRunnable | undefined

async function resolvePython(): Promise<PythonRunnable> {
  if (resolvedPython) return resolvedPython
  const candidates: PythonRunnable[] = [
    { cmd: "python", pre: [] },
    { cmd: "python3", pre: [] },
    { cmd: "py", pre: ["-3"] },
  ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.cmd, [...candidate.pre, "-c", "import ddgs; print('OK')"], {
        timeout: RESOLVE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      })
      if (stdout.trim() === "OK") {
        resolvedPython = candidate
        return candidate
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("websearch requires Python 3 with the `ddgs` package (install with: pip install ddgs)")
}

function toResult(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  const title = typeof rec["title"] === "string" ? rec["title"] : ""
  const url = typeof rec["href"] === "string" ? rec["href"] : ""
  const snippet = typeof rec["body"] === "string" ? rec["body"] : ""
  if (!title && !url) return null
  return { title, url, snippet }
}

export const WebSearchTool = defineTool({
  id: "websearch",
  description: "Searches the web via DuckDuckGo (ddgs) and returns titles, URLs, and snippets for the top results. Use this to find current information or URLs to fetch with webfetch.",
  parameters: Parameters,
  async execute(params, ctx) {
    await ctx.ask({ permission: "websearch", patterns: [params.query], always: ["*"] })

    let stdout = ""
    const python = await resolvePython()
    try {
      ;({ stdout } = await execFileAsync(python.cmd, [...python.pre, "-c", PYTHON_SCRIPT, params.query, String(params.numResults ?? DEFAULT_RESULTS)], {
        timeout: REQUEST_TIMEOUT_MS,
        signal: ctx.abort,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      }))
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: unknown; killed?: boolean }
      const detail = (e.stderr ?? "").trim() || (e.message ?? String(err))
      throw new Error(`ddgs search failed${e.killed || e.code === null ? " (timed out)" : ""}: ${truncateForDisplay(detail, 200)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error("ddgs search failed: unexpected output (not valid JSON)")
    }

    const results = Array.isArray(parsed)
      ? (parsed.map(toResult).filter((r): r is SearchResult => r !== null) as SearchResult[])
      : []

    if (results.length === 0) {
      return { title: params.query, output: "No results found.", metadata: { count: 0, engine: "ddgs" } }
    }

    const rendered = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")

    return {
      title: params.query,
      output: rendered,
      metadata: { count: results.length, engine: "ddgs" },
    }
  },
})