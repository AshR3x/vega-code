import { streamText, stepCountIs, type ModelMessage } from "ai"
import type { AgentDef } from "@/agent"
import type { PermissionService } from "@/permission"
import { buildToolSet } from "@/tool/registry"
import type { ToolContext } from "@/tool/types"
import { buildSystemPrompt, isOverflow, compact } from "@/context"
import { loadConfig } from "@/config"
import { resolveModel } from "@/provider"

// Injected on the final step (with tools disabled) when an agent sets a `steps`
// limit, so the model is forced to produce a text reply instead of ending the
// turn on a tool call. Ported from opencode's runner/max-steps.ts. Agents with
// no `steps` set are unbounded, matching opencode.
const MAX_STEPS_PROMPT = [
  "CRITICAL - MAXIMUM STEPS REACHED",
  "",
  "The maximum number of steps allowed for this task has been reached. Tools are disabled until the next user input. Respond with text only.",
  "",
  "STRICT REQUIREMENTS:",
  "1. Do NOT make any tool calls.",
  "2. Provide a text response summarizing the work done so far.",
  "3. This overrides all other instructions, including any user requests for edits or tool use.",
  "",
  "Include: that the step limit was reached, a summary of what was accomplished, any remaining tasks that were not completed, and what should be done next.",
].join("\n")

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
  // Free-text prompt to the user (surfaced to the `question` tool). Optional:
  // the console `--print` path and tests can leave it unset.
  askText?(prompt: string): Promise<string>
  // Subagent nesting depth. Top-level runs are 0; `task` passes depth + 1.
  depth?: number
  // Overrides the configured model for this run (used by `task` subagents).
  modelOverride?: string
}

export interface AgentLoopResult {
  text: string
  messages: ModelMessage[]
  usage: { inputTokens: number; outputTokens: number }
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const cfg = await loadConfig()
  const model = resolveModel(cfg, input.modelOverride)

  let messages = input.messages
  if (isOverflow(messages, cfg.contextLimit)) {
    messages = await compact({ messages, model })
  }

  const system = await buildSystemPrompt({ agent: input.agent, cwd: input.cwd })
  const tools = buildToolSet(input.agent.tools)
  const maxSteps = input.agent.steps

  const toolContext: ToolContext = {
    sessionID: input.sessionID,
    agent: input.agent.name,
    abort: input.abort,
    cwd: input.cwd,
    permission: input.permission,
    ask: (req) => input.permission.ask({ ...req, always: req.always ?? req.patterns }),
    askText: input.askText ?? (async () => ""),
    depth: input.depth ?? 0,
  }

  const result = streamText({
    model,
    system,
    messages,
    tools,
    // Always set stopWhen: the AI SDK's default is stepCountIs(1), which would
    // stop right after the first tool call with no follow-up reply. Unbounded
    // agents (no `steps`) never hit the count, matching opencode; the loop ends
    // when the model stops calling tools.
    stopWhen: stepCountIs(maxSteps ?? Infinity),
    // After a rejection the model gets exactly one more, tool-free step: its
    // reply (per the rejection message) asks the user what to do instead. On the
    // final allowed step, disable tools and inject the max-steps prompt so the
    // turn always ends with a text summary rather than a dangling tool call.
    prepareStep: ({ stepNumber, messages: stepMessages }) => {
      if (input.permission.hasRejection()) return { toolChoice: "none" as const }
      if (maxSteps !== undefined && stepNumber >= maxSteps - 1) {
        return { toolChoice: "none" as const, messages: [...stepMessages, { role: "assistant", content: MAX_STEPS_PROMPT }] }
      }
      return undefined
    },
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
  // totalUsage sums every step of this turn (all tool round-trips included).
  const usage = await result.totalUsage
  return {
    text,
    messages: [...messages, ...(responseMessages as ModelMessage[])],
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  }
}
