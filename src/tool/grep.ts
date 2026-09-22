import { z } from "zod"
import path from "node:path"
import { stat } from "node:fs/promises"
import { glob } from "glob"
import { defineTool } from "./types"

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024

const Parameters = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  path: z.string().optional().describe("File or directory to search in (defaults to the project directory; also accepts a page file saved by webfetch)"),
  include: z.string().optional().describe("Glob to filter which files are searched, e.g. '*.ts'"),
})

function grepLines(fileLabel: string, text: string, regex: RegExp, results: string[]): void {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length && results.length < MAX_MATCHES; i++) {
    if (regex.test(lines[i])) {
      results.push(`${fileLabel}:${i + 1}: ${lines[i].trim()}`)
    }
  }
}

export const GrepTool = defineTool({
  id: "grep",
  description: "Searches file contents for a regular expression pattern, returning matching lines with file:line context. `path` may be a directory (default: the project) or a single saved-html temp file from webfetch.",
  parameters: Parameters,
  async execute(params, ctx) {
    const cwd = params.path ?? ctx.cwd
    const target = params.path ? (path.isAbsolute(params.path) ? params.path : path.resolve(ctx.cwd, params.path)) : undefined

    let regex: RegExp
    try {
      regex = new RegExp(params.pattern)
    } catch (err) {
      throw new Error(`Invalid regular expression: ${String(err)}`)
    }

    const results: string[] = []

    // `path` can name a single file (e.g. a page saved by webfetch) — grep it
    // directly instead of walking a directory.
    const fileInfo = target ? await stat(target).catch(() => undefined) : undefined
    if (target && fileInfo?.isFile()) {
      if (fileInfo.size > MAX_FILE_BYTES) return { title: params.pattern, output: "File too large to search (over 2MB).", metadata: { matches: 0 } }
      const text = await Bun.file(target).text().catch(() => undefined)
      if (text !== undefined) grepLines(path.relative(ctx.cwd, target) || target, text, regex, results)
      return {
        title: params.pattern,
        output: results.length ? results.join("\n") : "No matches found",
        metadata: { matches: results.length },
      }
    }

    const files = await glob(params.include ? `**/${params.include}` : "**/*", {
      cwd,
      absolute: true,
      dot: false,
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
    })

    for (const file of files) {
      if (results.length >= MAX_MATCHES) break
      const bunFile = Bun.file(file)
      const fileStat = await bunFile.stat().catch(() => undefined)
      if (!fileStat || fileStat.size > MAX_FILE_BYTES) continue

      const text = await bunFile.text().catch(() => undefined)
      if (text === undefined) continue

      grepLines(path.relative(cwd, file), text, regex, results)
    }

    return {
      title: params.pattern,
      output: results.length ? results.join("\n") : "No matches found",
      metadata: { matches: results.length },
    }
  },
})