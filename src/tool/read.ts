import { z } from "zod"
import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import { defineTool } from "./types"
import { Lsp } from "@/lsp/lsp"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_OUTPUT_BYTES = 50 * 1024

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file or directory to read"),
  offset: z.number().int().min(1).optional().describe("The line number to start reading from (1-indexed)"),
  limit: z.number().int().min(1).optional().describe("The maximum number of lines to read (default 2000)"),
})

// Mirror opencode: on a miss, suggest sibling names that share a substring
// with what was requested, so a typo doesn't dead-end the model.
async function suggestions(dir: string, requested: string): Promise<string[]> {
  const base = path.basename(requested).toLowerCase()
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries
    .filter((entry) => {
      const candidate = entry.toLowerCase()
      return candidate.includes(base) || base.includes(candidate)
    })
    .slice(0, 3)
}

export const ReadTool = defineTool({
  id: "read",
  description: "Reads a file from the local filesystem, or lists a directory's contents. Each text line is prefixed by its 1-based line number. Use offset/limit for large files. Prefer one larger read over many small slices.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "read", patterns: [filepath], always: [path.dirname(filepath) + "/*"] })

    const info = await stat(filepath).catch(() => undefined)
    if (!info) {
      const hints = await suggestions(path.dirname(filepath), params.filePath)
      const message =
        hints.length === 0
          ? `File not found: ${params.filePath}`
          : `File not found: ${params.filePath}\n\nDid you mean one of these?\n${hints.join("\n")}`
      throw new Error(message)
    }

    if (info.isDirectory()) {
      const entries = await readdir(filepath, { withFileTypes: true })
      const names = entries
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort((a, b) => a.localeCompare(b))
      return {
        title,
        output: [`<path>${filepath}</path>`, `<type>directory</type>`, `<entries>`, names.join("\n"), `</entries>`].join("\n"),
        metadata: { entries: names.length },
      }
    }

    const raw = await readFile(filepath, "utf-8").catch(() => {
      throw new Error(`Cannot read binary or unreadable file: ${filepath}`)
    })

    // Fire-and-forget: warms up the file's language server (installing it on
    // first touch if needed) so later hover/definition/edit calls are fast.
    void Lsp.touchFile(filepath, ctx.cwd).catch(() => {})

    const lines = raw.split("\n")
    const offset = params.offset ?? 1
    const limit = params.limit ?? DEFAULT_LIMIT
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice
      .map((line, i) => {
        const clipped = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "... (line truncated)" : line
        return `${offset + i}: ${clipped}`
      })
      .join("\n")

    const last = offset + slice.length - 1
    let footer =
      last < lines.length
        ? `\n\n(Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
        : `\n\n(End of file - total ${lines.length} lines)`

    let body = numbered
    if (Buffer.byteLength(body, "utf-8") > MAX_OUTPUT_BYTES) {
      body = body.slice(0, MAX_OUTPUT_BYTES)
      footer = `\n\n(Output truncated at ${MAX_OUTPUT_BYTES / 1024}KiB. Use offset/limit to read the rest.)`
    }

    return {
      title,
      output: [`<path>${filepath}</path>`, `<type>file</type>`, `<content>`, body + footer, `</content>`].join("\n"),
      metadata: { lines: lines.length },
    }
  },
})
