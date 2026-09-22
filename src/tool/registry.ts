import { tool, type Tool, type ToolSet } from "ai"
import { z } from "zod"
import type { ToolDef, ToolContext } from "./types"
import { ReadTool } from "./read"
import { WriteTool } from "./write"
import { EditTool } from "./edit"
import { BashTool } from "./bash"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { TodoWriteTool } from "./todo"
import { TaskTool } from "./task"
import { Truncate } from "@/util/truncate"

const ALL: ToolDef[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, TodoWriteTool, TaskTool]

export function allToolIds(): string[] {
  return ALL.map((t) => t.id)
}

// Wraps our internal ToolDef into an AI SDK Tool, threading the per-call
// ToolContext through `experimental_context` since our execute() needs
// permission/session/abort info that the model never sees.
function wrap(def: ToolDef): Tool {
  return tool({
    description: def.description,
    inputSchema: def.parameters as z.ZodType<unknown>,
    async execute(input, options) {
      const ctx = options.experimental_context as ToolContext
      const result = await def.execute(input, ctx)
      if (result.output.length > 20_000) {
        const truncated = await Truncate.output(result.output)
        return { ...result, output: truncated.content }
      }
      return result.output
    },
  })
}

export function buildToolSet(allowedIds: string[]): ToolSet {
  const set: ToolSet = {}
  for (const def of ALL) {
    if (!allowedIds.includes(def.id)) continue
    set[def.id] = wrap(def)
  }
  return set
}

export function getToolDefs(allowedIds: string[]): ToolDef[] {
  return ALL.filter((def) => allowedIds.includes(def.id))
}
