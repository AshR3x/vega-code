import { z } from "zod"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { defineTool } from "./types"
import { Lsp } from "@/lsp/lsp"
import { Bom } from "@/util/bom"

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file to write"),
  content: z.string().describe("The full content to write to the file"),
  reason: z.string().describe("Brief, one-line explanation of why this write is needed, shown to the user in the approval prompt"),
})

export const WriteTool = defineTool({
  id: "write",
  description: "Writes content to a file, creating it (and parent directories) if needed, or overwriting it if it exists. For partial changes, use the edit tool instead.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "write", patterns: [filepath], always: [path.dirname(filepath) + "/*"], metadata: { reason: params.reason } })

    // Preserve an existing file's byte-order mark; also honor one supplied in
    // the new content. This mirrors opencode's writeTextPreservingBom.
    const existing = await readFile(filepath, "utf-8").catch(() => undefined)
    const hadBom = existing !== undefined && Bom.split(existing).bom
    const next = Bom.split(params.content)
    const out = Bom.join(next.text, hadBom || next.bom)

    await mkdir(path.dirname(filepath), { recursive: true })
    await writeFile(filepath, out, "utf-8")

    const diagnostics = await Lsp.touchFile(filepath, ctx.cwd).catch(() => "")
    const output = `Wrote ${out.length} bytes to ${filepath}` + (diagnostics ? `\n\n${diagnostics}` : "")

    return {
      title,
      output,
      metadata: { bytes: out.length, existed: existing !== undefined },
    }
  },
})
