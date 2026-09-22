import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { generateText, type LanguageModel, type ModelMessage } from "ai"
import { Token } from "@/util/token"
import type { AgentDef } from "@/agent"

const KEEP_RECENT_MESSAGES = 10

export async function buildSystemPrompt(input: { agent: AgentDef; cwd: string }): Promise<string> {
  const parts: string[] = [
    "You are vega-code, an autonomous CLI coding agent. You help the user with software engineering tasks in their project directory by reading and editing files and running shell commands.",
    "Use the available tools to accomplish the user's request. Prefer taking direct action over asking clarifying questions when the request is reasonably clear.",
    "When you modify code, keep changes minimal and consistent with the surrounding style. Do not add unrelated cleanup or speculative abstractions.",
  ]

  if (input.agent.prompt) parts.push(input.agent.prompt)

  parts.push(
    [
      "<env>",
      `  Working directory: ${input.cwd}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      "</env>",
    ].join("\n"),
  )

  const agentsFile = path.join(input.cwd, "AGENTS.md")
  if (existsSync(agentsFile)) {
    const content = await readFile(agentsFile, "utf-8")
    parts.push(["<project_instructions>", content.trim(), "</project_instructions>"].join("\n"))
  }

  return parts.join("\n\n")
}

export function isOverflow(messages: ModelMessage[], contextLimit: number): boolean {
  const size = Token.estimate(JSON.stringify(messages))
  return size > contextLimit * 0.8
}

// Summarizes everything except the most recent turns into a single synthetic
// message so the conversation can continue within the context window.
export async function compact(input: {
  messages: ModelMessage[]
  model: LanguageModel
}): Promise<ModelMessage[]> {
  if (input.messages.length <= KEEP_RECENT_MESSAGES) return input.messages

  const splitAt = input.messages.length - KEEP_RECENT_MESSAGES
  const older = input.messages.slice(0, splitAt)
  const recent = input.messages.slice(splitAt)

  const transcript = older
    .map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n")

  const { text } = await generateText({
    model: input.model,
    system: "You summarize coding-agent conversation history. Preserve concrete facts: file paths touched, decisions made, and unresolved next steps. Be concise.",
    prompt: `Summarize this conversation history so the agent can continue with full context:\n\n${transcript}`,
  })

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `<conversation_summary>\nThe conversation so far has been summarized to save context:\n\n${text}\n</conversation_summary>`,
  }

  return [summaryMessage, ...recent]
}

export const HomeDir = os.homedir()
