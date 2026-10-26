import { z } from "zod"
import path from "node:path"
import { defineTool } from "./types"
import { Lsp } from "@/lsp/lsp"

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file"),
  line: z.number().int().min(1).describe("1-indexed line number of the symbol"),
  column: z.number().int().min(1).describe("1-indexed column number of the symbol"),
})

export const HoverTool = defineTool({
  id: "hover",
  description:
    "Shows type/signature/doc information for the symbol at a file position, using the project's language server " +
    "(TypeScript/JavaScript, Python, and Go are auto-installed on first use if not already on PATH).",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = `${path.relative(ctx.cwd, filepath)}:${params.line}:${params.column}`

    await ctx.ask({ permission: "read", patterns: [filepath], always: [path.dirname(filepath) + "/*"] })

    const output = await Lsp.hover(filepath, params.line - 1, params.column - 1, ctx.cwd)
    return { title, output }
  },
})
