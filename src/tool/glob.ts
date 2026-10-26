import { z } from "zod"
import { glob } from "glob"
import { defineTool } from "./types"

const Parameters = z.object({
  pattern: z.string().describe("The glob pattern to match files against, e.g. '**/*.ts'"),
  path: z.string().optional().describe("Directory to search in (defaults to the project directory)"),
  hidden: z.boolean().optional().describe("Include hidden files and directories (default: false)"),
  limit: z.number().int().positive().optional().describe("Maximum number of matching files to return (default 100)"),
})

export const GlobTool = defineTool({
  id: "glob",
  description: "Finds files matching a glob pattern, sorted by modification time (newest first).",
  parameters: Parameters,
  async execute(params, ctx) {
    const cwd = params.path ?? ctx.cwd
    const limit = params.limit ?? 100
    const matches = await glob(params.pattern, {
      cwd,
      absolute: true,
      dot: params.hidden ?? false,
      ignore: ["**/node_modules/**", "**/.git/**"],
      nodir: true,
    })

    const withStats = await Promise.all(
      matches.map(async (file) => {
        const bunFile = Bun.file(file)
        const stat = await bunFile.stat().catch(() => undefined)
        return { file, mtime: stat?.mtime?.getTime() ?? 0 }
      }),
    )
    withStats.sort((a, b) => b.mtime - a.mtime)

    const files = withStats.map((f) => f.file)
    const limited = files.slice(0, limit)
    const truncated = files.length > limit

    return {
      title: params.pattern,
      output: limited.length
        ? limited.join("\n") + (truncated ? `\n\n(Results truncated: showing first ${limited.length} of ${files.length}. Use a more specific path or pattern.)` : "")
        : "No files found",
      metadata: { count: files.length, shown: limited.length, truncated },
    }
  },
})
