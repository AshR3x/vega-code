import { z } from "zod"
import { glob } from "glob"
import { defineTool } from "./types"

const Parameters = z.object({
  pattern: z.string().describe("The glob pattern to match files against, e.g. '**/*.ts'"),
  path: z.string().optional().describe("Directory to search in (defaults to the project directory)"),
})

export const GlobTool = defineTool({
  id: "glob",
  description: "Finds files matching a glob pattern, sorted by modification time (newest first).",
  parameters: Parameters,
  async execute(params, ctx) {
    const cwd = params.path ?? ctx.cwd
    const matches = await glob(params.pattern, {
      cwd,
      absolute: true,
      dot: false,
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
    const limited = files.slice(0, 200)

    return {
      title: params.pattern,
      output: limited.length ? limited.join("\n") : "No files found",
      metadata: { count: files.length, shown: limited.length },
    }
  },
})
