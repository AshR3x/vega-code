export interface AgentDef {
  name: string
  description: string
  mode: "primary" | "subagent"
  tools: string[]
  prompt?: string
  // RGB, used for the prompt bar's left border — a per-agent accent color
  // so each agent is visually distinct in the status line.
  color: [number, number, number]
}

export const AGENTS: Record<string, AgentDef> = {
  build: {
    name: "build",
    description: "The default agent. Full read/write/shell access, can spawn subagents.",
    mode: "primary",
    tools: ["read", "write", "edit", "bash", "glob", "grep", "webfetch", "websearch", "todo", "task"],
    color: [168, 133, 255], // purple
  },
  plan: {
    name: "plan",
    description: "Read-only planning mode. Investigates and proposes a plan without making changes.",
    mode: "primary",
    tools: ["read", "glob", "grep", "webfetch", "websearch", "todo"],
    color: [255, 158, 100], // amber — visually flags "you can't write anything right now"
    prompt:
      "You are in PLAN MODE. You can read and search the codebase, but you have no access to write, edit, bash, or task tools — you cannot modify anything or execute commands. " +
      "Investigate the request thoroughly, then present a clear, concrete implementation plan (steps, files touched, risks). " +
      "Do not claim to have made changes. End by telling the user to switch to /build to execute the plan.",
  },
  general: {
    name: "general",
    description: "Subagent for research and multi-step search tasks. No write/edit/bash access, cannot spawn further subagents.",
    mode: "subagent",
    tools: ["read", "glob", "grep", "webfetch", "websearch"],
    prompt: "You are a research subagent. Investigate the task thoroughly and report your findings clearly. You cannot modify files or run shell commands.",
    color: [140, 140, 150], // gray — not user-facing, so it never actually renders
  },
}

export function defaultAgent(): AgentDef {
  return AGENTS.build
}

export function primaryAgents(): AgentDef[] {
  return Object.values(AGENTS).filter((a) => a.mode === "primary")
}
