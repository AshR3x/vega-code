import type { ZodType } from "zod"
import type { PermissionService, AskRequest } from "@/permission"

export interface ToolContext {
  sessionID: string
  agent: string
  abort: AbortSignal
  cwd: string
  permission: PermissionService
  ask(input: Omit<AskRequest, "always"> & { always?: string[] }): Promise<void>
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
