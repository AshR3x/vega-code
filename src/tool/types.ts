import type { ZodType } from "zod"
import type { PermissionService, AskRequest } from "@/permission"

export interface ToolContext {
  sessionID: string
  agent: string
  abort: AbortSignal
  cwd: string
  permission: PermissionService
  // Permission approval prompt (approve / always / reject).
  ask(input: Omit<AskRequest, "always"> & { always?: string[] }): Promise<void>
  // Free-text prompt to the user (used by the `question` tool). Resolves with
  // the typed reply, or "" if the user cancelled.
  askText(prompt: string): Promise<string>
  // Subagent nesting depth (0 for the top-level agent). Used by `task`.
  depth: number
}

export interface ToolResult {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

export interface ToolDef<Params = any> {
  id: string
  description: string
  parameters: ZodType<Params>
  execute(args: Params, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<Params>(def: ToolDef<Params>): ToolDef<Params> {
  return def
}
