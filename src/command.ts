import os from "node:os"
import path from "node:path"
import { stat } from "node:fs/promises"
import { PROVIDERS, type ProviderID, type VegaConfig } from "@/config"
import { AGENTS, primaryAgents, type AgentDef } from "@/agent"
import { listModels } from "@/models"
import type { PermissionService } from "@/permission"
import { theme } from "@/tui/theme"

export interface CommandCtx {
  getConfig(): VegaConfig
  setModel(provider: ProviderID, model: string): Promise<VegaConfig>
  getAgent(): AgentDef
  setAgent(agent: AgentDef): void
  getCwd(): string
  setCwd(dir: string): void
  permission: PermissionService
  ask(prompt: string): Promise<string>
  print(text: string): void
  clearMessages(): void
  compact(): Promise<void>
}

export type CommandOutcome = "handled" | "exit" | "not-a-command"

interface Command {
  name: string
  description: string
  run(args: string[], ctx: CommandCtx): Promise<void>
}

async function pickFromList(ctx: CommandCtx, title: string, items: string[]): Promise<string | undefined> {
  ctx.print(theme.accent(title))
  items.forEach((item, i) => ctx.print(`  ${theme.purple(String(i + 1))}) ${item}`))
  const reply = (await ctx.ask(theme.accent(`Select [1-${items.length}] (empty to cancel): `))).trim()
  if (reply === "") return undefined
  const idx = Number(reply)
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    ctx.print(theme.error("Invalid selection."))
    return undefined
  }
  return items[idx - 1]
}

// Shared by /models and /provider: opens a provider picker window first
// (anthropic / openai / ollama / groq), then a model picker scoped to
// whichever provider was chosen.
async function switchProviderAndModel(ctx: CommandCtx): Promise<void> {
  const chosen = await pickFromList(ctx, "Providers:", [...PROVIDERS])
  if (!chosen) return
  const providerID = chosen as ProviderID

  ctx.print(theme.dim(`Fetching models for ${providerID}...`))
  let models: string[]
  try {
    const result = await listModels(providerID)
    models = result.models
    if (!result.live) ctx.print(theme.gray("(live lookup failed, showing a static fallback list)"))
  } catch (err) {
    ctx.print(theme.error(err instanceof Error ? err.message : String(err)))
    return
  }

  const model = await pickFromList(ctx, `Models (${providerID}):`, models)
  if (!model) return
  const next = await ctx.setModel(providerID, model)
  ctx.print(theme.success(`Switched to ${next.provider}/${next.model}`))
}

// "~" and "~/x" expand to the home dir; surrounding quotes (for paths with
// spaces) are stripped; relative paths resolve against the current directory.
function resolveDir(input: string, current: string): string {
  let raw = input.trim().replace(/^(["'])(.*)\1$/, "$2")
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) raw = path.join(os.homedir(), raw.slice(1))
  return path.resolve(current, raw)
}

async function changeDir(args: string[], ctx: CommandCtx): Promise<void> {
  if (args.length === 0) {
    ctx.print(`Current directory: ${ctx.getCwd()}`)
    ctx.print(theme.gray("Usage: /change-dir <path>   (also /cd; ~ and relative paths work)"))
    return
  }
  const target = resolveDir(args.join(" "), ctx.getCwd())
  const info = await stat(target).catch(() => undefined)
  if (!info) {
    ctx.print(theme.error(`No such directory: ${target}`))
    return
  }
  if (!info.isDirectory()) {
    ctx.print(theme.error(`Not a directory: ${target}`))
    return
  }
  ctx.setCwd(target)
  ctx.print(theme.success(`Working directory: ${target}`))
}

const COMMANDS: Command[] = [
  {
    name: "help",
    description: "List available commands",
    async run(_args, ctx) {
      ctx.print(theme.accent("Commands:"))
      for (const cmd of COMMANDS) {
        ctx.print(`  ${theme.purpleBright("/" + cmd.name.padEnd(10))} ${theme.gray(cmd.description)}`)
      }
      ctx.print("")
      ctx.print(theme.gray("Double-tap Tab to expand/collapse the model's live thinking output."))
    },
  },
  {
    name: "models",
    description: "Open the provider/model picker (anthropic / openai / ollama / groq), live from each provider's API",
    async run(_args, ctx) {
      await switchProviderAndModel(ctx)
    },
  },
  {
    name: "provider",
    description: "Alias for /models — switch provider, then pick a model",
    async run(_args, ctx) {
      await switchProviderAndModel(ctx)
    },
  },
  {
    name: "agent",
    description: "Switch agent (build / plan)",
    async run(_args, ctx) {
      const options = primaryAgents()
      const chosen = await pickFromList(
        ctx,
        "Agents:",
        options.map((a) => `${a.name} — ${a.description}`),
      )
      if (!chosen) return
      const name = chosen.split(" — ")[0]!
      const agent = options.find((a) => a.name === name)
      if (!agent) return
      ctx.setAgent(agent)
      ctx.print(theme.success(`Switched to ${agent.name} agent`))
    },
  },
  {
    name: "plan",
    description: "Shortcut for /agent plan — read-only planning mode, no writes/edits/bash",
    async run(_args, ctx) {
      ctx.setAgent(AGENTS.plan)
      ctx.print(theme.success("Switched to plan agent (read-only)."))
    },
  },
  {
    name: "build",
    description: "Shortcut for /agent build — full read/write/shell access",
    async run(_args, ctx) {
      ctx.setAgent(AGENTS.build)
      ctx.print(theme.success("Switched to build agent."))
    },
  },
  {
    name: "auto",
    description: "Toggle auto mode: skip permission prompts for the rest of the session",
    async run(_args, ctx) {
      const next = !ctx.permission.isAutoApprove()
      ctx.permission.setAutoApprove(next)
      ctx.print(next ? theme.accent("Auto mode ON — permission prompts will be skipped.") : theme.success("Auto mode OFF — permissions will ask again."))
    },
  },
  {
    name: "change-dir",
    description: "Change the working directory the agent's tools run in (alias: /cd)",
    async run(args, ctx) {
      await changeDir(args, ctx)
    },
  },
  {
    name: "cd",
    description: "Alias for /change-dir",
    async run(args, ctx) {
      await changeDir(args, ctx)
    },
  },
  {
    name: "compact",
    description: "Manually summarize the conversation so far to free up context",
    async run(_args, ctx) {
      ctx.print(theme.dim("Compacting..."))
      await ctx.compact()
      ctx.print(theme.success("Done."))
    },
  },
  {
    name: "clear",
    description: "Clear the page and conversation history (keeps the session file, starts fresh context)",
    async run(_args, ctx) {
      ctx.clearMessages()
      ctx.print(theme.dim("Context cleared."))
    },
  },
]

export async function runCommand(line: string, ctx: CommandCtx): Promise<CommandOutcome> {
  if (!line.startsWith("/")) return "not-a-command"
  const [rawName, ...args] = line.slice(1).trim().split(/\s+/)
  const name = (rawName ?? "").toLowerCase()

  if (name === "exit" || name === "quit") return "exit"

  const cmd = COMMANDS.find((c) => c.name === name)
  if (!cmd) {
    ctx.print(theme.error(`Unknown command: /${name}. Type /help for a list.`))
    return "handled"
  }

  await cmd.run(args, ctx)
  return "handled"
}
