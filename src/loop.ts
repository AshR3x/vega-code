import { streamText, stepCountIs, type ModelMessage } from "ai"
import type { AgentDef } from "@/agent"
import type { PermissionService } from "@/permission"
import { buildToolSet } from "@/tool/registry"
import type { ToolContext } from "@/tool/types"
import { buildSystemPrompt, isOverflow, compact } from "@/context"
import { loadConfig } from "@/config"
import { resolveModel } from "@/provider"

const MAX_STEPS = 30

export type AgentLoopEvent =
  | { type: "text"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "tool-result"; name: string; output: string }
  | { type: "tool-error"; name: string; error: string }

export interface AgentLoopInput {
  agent: AgentDef
  cwd: string
  permission: PermissionService
  abort: AbortSignal
  sessionID: string
  messages: ModelMessage[]
  onChunk(event: AgentLoopEvent): void
}

export interface AgentLoopResult {
  text: string
  messages: ModelMessage[]
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const cfg = await loadConfig()
  const model = resolveModel(cfg)

  let messages = input.messages
  if (isOverflow(messages, cfg.contextLimit)) {
    messages = await compact({ messages, model })
  }

  const system = await buildSystemPrompt({ agent: input.agent, cwd: input.cwd })
  const tools = buildToolSet(input.agent.tools)

  const toolContext: ToolContext = {
    sessionID: input.sessionID,
    agent: input.agent.name,
    abort: input.abort,
    cwd: input.cwd,
    permission: input.permission,
    ask: (req) => input.permission.ask({ ...req, always: req.always ?? req.patterns }),
  }

  const result = streamText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    // After a rejection the model gets exactly one more, tool-free step: its
    // reply (per the rejection message) asks the user what to do instead.
    prepareStep: () => (input.permission.hasRejection() ? { toolChoice: "none" as const } : undefined),
    abortSignal: input.abort,
    experimental_context: toolContext,
  })

  let text = ""
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text
      input.onChunk({ type: "text", text: part.text })
    } else if (part.type === "reasoning-start") {
      input.onChunk({ type: "reasoning-start" })
    } else if (part.type === "reasoning-delta") {
      input.onChunk({ type: "reasoning-delta", text: part.text })
    } else if (part.type === "reasoning-end") {
      input.onChunk({ type: "reasoning-end" })
    } else if (part.type === "tool-call") {
      input.onChunk({ type: "tool-call", name: part.toolName, input: part.input })
    } else if (part.type === "tool-result") {
      const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
      input.onChunk({ type: "tool-result", name: part.toolName, output })
    } else if (part.type === "tool-error") {
      const rejected = part.error instanceof Error && part.error.name === "PermissionRejectedError"
      input.onChunk({ type: "tool-error", name: part.toolName, error: rejected ? "Rejected by user." : String(part.error) })
    } else if (part.type === "error") {
      input.onChunk({ type: "tool-error", name: "stream", error: String(part.error) })
    }
  }

  const responseMessages = (await result.response).messages
  return { text, messages: [...messages, ...(responseMessages as ModelMessage[])] }
}
