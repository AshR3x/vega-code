import { z } from "zod"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { defineTool } from "./types"

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file to edit"),
  oldString: z.string().describe("The exact text to replace. Must match exactly, including whitespace."),
  newString: z.string().describe("The text to replace it with"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences instead of requiring exactly one match"),
})

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++
    index += needle.length
  }
  return count
}

export const EditTool = defineTool({
  id: "edit",
  description: "Performs an exact string replacement in a file. `oldString` must match exactly once unless replaceAll is set.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "edit", patterns: [filepath], always: [path.dirname(filepath) + "/*"] })

    const content = await readFile(filepath, "utf-8")
    const occurrences = countOccurrences(content, params.oldString)

    if (occurrences === 0) throw new Error(`oldString not found in ${filepath}`)
    if (occurrences > 1 && !params.replaceAll) {
      throw new Error(`oldString matches ${occurrences} times in ${filepath}. Add more context to make it unique, or set replaceAll.`)
    }

    const updated = params.replaceAll
      ? content.split(params.oldString).join(params.newString)
      : content.replace(params.oldString, params.newString)

    await writeFile(filepath, updated, "utf-8")

    return {
      title,
      output: `Replaced ${params.replaceAll ? occurrences : 1} occurrence(s) in ${filepath}`,
      metadata: { occurrences: params.replaceAll ? occurrences : 1 },
    }
  },
})
