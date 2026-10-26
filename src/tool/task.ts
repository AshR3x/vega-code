import { z } from "zod"
import { defineTool } from "./types"
import { AGENTS } from "@/agent"
import { loadConfig } from "@/config"

const Parameters = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the subagent to perform"),
  subagent_type: z.string().describe(`The type of subagent to use. Options: ${Object.keys(AGENTS).filter((a) => a !== "build").join(", ")}`),
  model: z
    .string()
    .optional()
    .describe("Optional model override as providerID/modelID. Only set this if the user explicitly asked for a particular model."),
})

export const TaskTool = defineTool({
  id: "task",
  description: "Launches a subagent to autonomously handle a self-contained task, returning its final report. Use for research or multi-step work you don't need to babysit.",
  parameters: Parameters,
  async execute(params, ctx) {
    const agent = AGENTS[params.subagent_type]
    if (!agent) throw new Error(`Unknown subagent_type: ${params.subagent_type}. Options: ${Object.keys(AGENTS).join(", ")}`)
    if (agent.mode === "primary" || agent.tools.includes("task")) throw new Error(`Subagent "${agent.name}" cannot run as a subagent.`)

    const cfg = await loadConfig()
    const limit = cfg.subagentDepth
    if (ctx.depth >= limit) throw new Error(`Subagent depth limit reached (${limit}). Raise "subagentDepth" in vega.config.json to allow nested subagents.`)

    // Dynamic import breaks the loop.ts <-> registry.ts <-> task.ts import cycle:
    // by call time every module is fully initialized.
    const { runAgentLoop } = await import("@/loop")

    const result = await runAgentLoop({
      agent,
      cwd: ctx.cwd,
      permission: ctx.permission,
      abort: ctx.abort,
      sessionID: `${ctx.sessionID}.sub.${Date.now()}`,
      messages: [{ role: "user", content: params.prompt }],
      onChunk: () => {},
      askText: ctx.askText,
      depth: ctx.depth + 1,
      modelOverride: params.model,
    })

    return {
      title: params.description,
      output: result.text || "(subagent produced no output)",
      metadata: { subagent: agent.name },
    }
  },
})
