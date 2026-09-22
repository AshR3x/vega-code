import { Wildcard } from "@/util/wildcard"

export type Action = "allow" | "deny" | "ask"

export interface Rule {
  permission: string
  pattern: string
  action: Action
}

export type Ruleset = Rule[]

export interface AskRequest {
  permission: string
  patterns: string[]
  always?: string[]
  metadata?: Record<string, unknown>
}

export type PromptFn = (input: {
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
}) => Promise<"once" | "always" | "reject">

export class PermissionDeniedError extends Error {
  constructor(permission: string, pattern: string) {
    super(`Permission denied: ${permission} (${pattern})`)
    this.name = "PermissionDeniedError"
  }
}

export class PermissionRejectedError extends Error {
  constructor() {
    super("User rejected the permission request")
    this.name = "PermissionRejectedError"
  }
}

export function evaluate(permission: string, pattern: string, ruleset: Ruleset): Rule {
  return (
    [...ruleset].reverse().find((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      permission,
      pattern: "*",
      action: "ask",
    }
  )
}

// Default policy: reads are quiet, everything that touches the filesystem or
// shell asks the first time, and .env-shaped files always ask even to read.
export const DEFAULT_RULESET: Ruleset = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "read", pattern: "*.env.*", action: "ask" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "todo", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "ask" },
  { permission: "websearch", pattern: "*", action: "ask" },
  { permission: "write", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "task", pattern: "*", action: "allow" },
]

export class PermissionService {
  private approved: Ruleset = []
  private autoApprove = false

  constructor(
    private ruleset: Ruleset,
    private prompt: PromptFn,
  ) {}

  // "Auto mode": skip prompting for anything that would otherwise ask.
  // Explicit `deny` rules still apply — this widens "ask" to "allow", it
  // doesn't disable the safety rail entirely.
  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled
  }

  isAutoApprove(): boolean {
    return this.autoApprove
  }

  async ask(input: AskRequest): Promise<void> {
    let needsAsk = false
    for (const pattern of input.patterns) {
      const rule = evaluate(input.permission, pattern, [...this.ruleset, ...this.approved])
      if (rule.action === "deny") throw new PermissionDeniedError(input.permission, pattern)
      if (rule.action === "allow") continue
      needsAsk = true
    }
    if (!needsAsk) return
    if (this.autoApprove) return

    const reply = await this.prompt({
      permission: input.permission,
      patterns: input.patterns,
      metadata: input.metadata,
    })

    if (reply === "reject") throw new PermissionRejectedError()
    if (reply === "always") {
      for (const pattern of input.always ?? input.patterns) {
        this.approved.push({ permission: input.permission, pattern, action: "allow" })
      }
    }
  }
}
