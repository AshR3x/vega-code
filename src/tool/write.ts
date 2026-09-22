import { z } from "zod"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { defineTool } from "./types"

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file to write"),
  content: z.string().describe("The full content to write to the file"),
})

export const WriteTool = defineTool({
  id: "write",
  description: "Writes content to a file, creating it (and parent directories) if needed, or overwriting it if it exists.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "write", patterns: [filepath], always: [path.dirname(filepath) + "/*"] })

    await mkdir(path.dirname(filepath), { recursive: true })
    await writeFile(filepath, params.content, "utf-8")

    return {
      title,
      output: `Wrote ${params.content.length} bytes to ${filepath}`,
      metadata: { bytes: params.content.length },
    }
  },
})
