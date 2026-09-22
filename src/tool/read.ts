import { z } from "zod"
import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import { defineTool } from "./types"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file or directory to read"),
  offset: z.number().int().min(1).optional().describe("The line number to start reading from (1-indexed)"),
  limit: z.number().int().min(1).optional().describe("The maximum number of lines to read (default 2000)"),
})

export const ReadTool = defineTool({
  id: "read",
  description: "Reads a file from the local filesystem, or lists a directory's contents. Use absolute paths when possible.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "read", patterns: [filepath], always: [path.dirname(filepath) + "/*"] })

    const info = await stat(filepath).catch(() => undefined)
    if (!info) throw new Error(`File not found: ${filepath}`)

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
    const footer =
      last < lines.length
        ? `\n\n(Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
        : `\n\n(End of file - total ${lines.length} lines)`

    return {
      title,
      output: [`<path>${filepath}</path>`, `<type>file</type>`, `<content>`, numbered + footer, `</content>`].join("\n"),
      metadata: { lines: lines.length },
    }
  },
})
