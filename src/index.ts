#!/usr/bin/env bun
import readline from "node:readline"
import type { ModelMessage } from "ai"
import { loadConfig, saveModelPreference, PROVIDERS, type ProviderID, type VegaConfig } from "@/config"
import { PermissionService, DEFAULT_RULESET, type PromptFn } from "@/permission"
import { AGENTS, defaultAgent, type AgentDef } from "@/agent"
import { runAgentLoop } from "@/loop"
import { compact as compactMessages } from "@/context"
import { resolveModel, MissingApiKeyError } from "@/provider"
import { Session, newSessionID } from "@/session"
import { listModels } from "@/models"
import { describeRateLimitError } from "@/util/ratelimit"
import { runCommand, type CommandCtx } from "@/command"
import { theme, fromRgb } from "@/tui/theme"
import { renderLogo, renderPromptFrame, promptBoxWidth, promptBoxTextWidth, PROMPT_FRAME_HEIGHT } from "@/tui/logo"
import { centerBlock, terminalSize, truncateWithEllipsis, truncateForDisplay } from "@/tui/layout"
import { runLayoutDebug } from "@/tui/debug"
import type { TuiHooks } from "@/tui/app"

const GAP_BEFORE_LOGO = 4
const GAP_AFTER_LOGO = 1
const PROMPT_WRAPPER_PADDING_TOP = 1
const FOOTER_PADDING = 1 // top and bottom, matching footer.tsx's paddingTop=1/paddingBottom=1

// A real TTY echoes typed characters itself, and Enter supplies the newline
// that separates our prompt text from whatever we print next. Piped/
// non-interactive stdin echoes nothing, so without this, our prompt text
// and the box's closing lines printed right after `ask()` resolves end up
// concatenated onto one line instead of stacked.
function finishLine() {
  if (!process.stdout.isTTY) process.stdout.write("\n")
}

// The OpenTUI renderer needs exclusive stdin ownership in interactive mode,
// so readline is set up lazily here — only on the non-interactive (one-shot
// or piped-stdin) console path — never at module load.
interface ConsoleAsk {
  ask(prompt: string): Promise<string>
  close(): void
  isThinkingExpanded(): boolean
}

function createConsoleAsk(): ConsoleAsk {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // `rl.question()` only captures the *next* 'line' event at the moment it's
  // called — if input arrives faster than we re-call it (pasted multi-line
  // input, piped/scripted stdin), extra lines fire into the void and are lost,
  // and once stdin hits EOF a pending question() never resolves, silently
  // killing the process. Queue lines ourselves instead so nothing is dropped
  // and EOF resolves cleanly to an exit sentinel.
  const lineQueue: string[] = []
  let waitingResolve: ((line: string) => void) | undefined
  let closed = false

  rl.on("line", (line) => {
    if (waitingResolve) {
      const resolve = waitingResolve
      waitingResolve = undefined
      resolve(line)
    } else {
      lineQueue.push(line)
    }
  })

  rl.on("close", () => {
    closed = true
    if (waitingResolve) {
      const resolve = waitingResolve
      waitingResolve = undefined
      resolve("/exit")
    }
  })

  // Double-tap Tab toggles between a collapsed "(thinking...)" indicator and
  // showing the model's full reasoning/thinking text live as it streams.
  // There's no existing gesture to match, so this picks a concrete one since
  // the feature needs one. Only wired up on a real TTY — piped/non-interactive
  // stdin never emits keypress events, which is fine, there's no live
  // toggling to do there anyway.
  let thinkingExpanded = false
  let lastTabAt = 0
  const DOUBLE_TAP_WINDOW_MS = 400

  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str, key: { name?: string } | undefined) => {
      if (!key || key.name !== "tab") return
      const now = Date.now()
      if (now - lastTabAt < DOUBLE_TAP_WINDOW_MS) {
        thinkingExpanded = !thinkingExpanded
        lastTabAt = 0
        console.log()
        console.log(
          thinkingExpanded
            ? theme.accent("Thinking display: expanded (shows reasoning live from here on)")
            : theme.gray("Thinking display: collapsed"),
        )
      } else {
        lastTabAt = now
      }
    })
  }

  // Must go through rl.setPrompt()/rl.prompt() rather than a raw
  // process.stdout.write(prompt) — readline's own line-editing (backspace,
  // left/right, history, redraw on terminal resize) recalculates cursor
  // position from *its own* internal notion of the prompt (rl._prompt),
  // which stays at its default ('> ') if we never tell it what the real
  // prompt text is. A manually-written prompt readline doesn't know about
  // means every subsequent redraw (e.g. on backspace) is computed against
  // the wrong prompt width and visibly garbles the line.
  async function ask(prompt: string): Promise<string> {
    // Queued lines and the closed-EOF case must be checked, and returned,
    // BEFORE touching `rl` at all: piped stdin can hit EOF (closing `rl`)
    // well before we get back around to the next ask() call — e.g. while a
    // real multi-second LLM turn is still streaming — and rl.prompt() throws
    // ERR_USE_AFTER_CLOSE if the interface is already closed. Only call it
    // once we know we're actually about to wait live, which is the one case
    // where rl is guaranteed still open (closed can't flip mid-synchronous-check
    // in a single-threaded event loop).
    if (lineQueue.length > 0) {
      const line = lineQueue.shift()!
      finishLine()
      return line
    }
    if (closed) {
      finishLine()
      return "/exit"
    }
    rl.setPrompt(prompt)
    rl.prompt()
    return new Promise((resolve) => {
      waitingResolve = (line) => {
        finishLine()
        resolve(line)
      }
    })
  }

  return { ask, close: () => rl.close(), isThinkingExpanded: () => thinkingExpanded }
}

// The one-shot piped/console path's permission prompt, byte-for-byte the
// original: colored lines printed to stdout followed by the Allow? ask.
function makeConsolePromptFn(askInput: (prompt: string) => Promise<string>): PromptFn {
  return async (input) => {
    console.log()
    console.log(theme.accent(`Permission requested: ${input.permission}`))
    for (const pattern of input.patterns) console.log(theme.gray(`  ${pattern}`))
    if (input.metadata?.["command"]) console.log(theme.gray(`  command: ${input.metadata["command"]}`))
    const reply = await askInput(theme.accent("Allow? [y]es once / [a]lways / [n]o: "))
    const normalized = reply.trim().toLowerCase()
    if (normalized === "a" || normalized === "always") return "always"
    if (normalized === "y" || normalized === "yes" || normalized === "") return "once"
    return "reject"
  }
}

// The TUI path surfaces permission prompts as tool-call rows with Approve /
// Always / Reject buttons instead of a text ask — the app assigns the real
// hooks.askPermission implementation on mount (the stub cancels).
function makePermissionPromptFn(hooks: TuiHooks): PromptFn {
  return (input) => hooks.askPermission({ permission: input.permission, patterns: input.patterns, metadata: input.metadata })
}

interface ParsedArgs {
  provider?: string
  model?: string
  shouldContinue: boolean
  oneShot: string
  testMode: boolean
  testWidth?: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = []
  let provider: string | undefined
  let model: string | undefined
  let shouldContinue = false
  let testMode = false
  let testWidth: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--continue" || arg === "-c") {
      shouldContinue = true
    } else if (arg === "--test") {
      testMode = true
    } else if (arg === "--test-width") {
      testWidth = Number(argv[++i])
    } else if (arg.startsWith("--test-width=")) {
      testWidth = Number(arg.slice("--test-width=".length))
    } else if (arg === "--provider") {
      provider = argv[++i]
    } else if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length)
    } else if (arg === "--model") {
      model = argv[++i]
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length)
    } else {
      rest.push(arg)
    }
  }

  return { provider, model, shouldContinue, oneShot: rest.join(" "), testMode, testWidth }
}

// Ollama has no fixed default at all; Groq's lineup turns over too often to
// hardcode. Both resolve their model live here instead of silently landing
// on something possibly stale or (for ollama) not even installed.
async function selectModel(providerID: "ollama" | "groq", askInput: (prompt: string) => Promise<string>): Promise<string> {
  console.log(theme.dim(providerID === "ollama" ? "Checking local Ollama models (`ollama list`)..." : "Fetching Groq models..."))
  let models: string[]
  try {
    const result = await listModels(providerID)
    models = result.models
    if (!result.live) console.log(theme.gray("(live lookup failed, showing a static fallback list)"))
  } catch (err) {
    console.error(theme.error(err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }

  if (models.length === 0) {
    console.error(theme.error(providerID === "ollama" ? "No Ollama models found. Pull a model first (e.g. `ollama pull llama3.2`)." : "No Groq models found."))
    process.exit(1)
  }

  if (models.length === 1) {
    console.log(theme.dim(`Using ${models[0]} (only model available)`))
    await saveModelPreference(providerID, models[0]!)
    return models[0]!
  }

  console.log(theme.accent(providerID === "ollama" ? "Select an Ollama model:" : "Select a Groq model:"))
  models.forEach((name, i) => console.log(`  ${theme.purple(String(i + 1))}) ${name}`))
  while (true) {
    const reply = (await askInput(theme.accent(`Model [1-${models.length}]: `))).trim()
    const idx = Number(reply)
    if (Number.isInteger(idx) && idx >= 1 && idx <= models.length) {
      await saveModelPreference(providerID, models[idx - 1]!)
      return models[idx - 1]!
    }
    console.log(theme.error("Invalid selection."))
  }
}

function statusLine(cfg: VegaConfig, agent: AgentDef, autoMode: boolean, sessionActive: boolean, terminalWidth: number): string {
  const autoText = autoMode ? " [auto]" : ""
  const prefixLength = agent.name.length + 2 // "  " between name and model
  const budget = Math.max(10, promptBoxTextWidth(sessionActive, terminalWidth) - prefixLength - autoText.length)
  const modelText = truncateWithEllipsis(`${cfg.provider}/${cfg.model}`, budget)

  const agentLabel = fromRgb(...agent.color)(agent.name)
  const modelLabel = theme.gray(modelText)
  const autoLabel = theme.accent(autoText)
  return `${agentLabel}  ${modelLabel}${autoLabel}`
}

// Live keybinding hint row matching the box's left edge, directly adjacent
// to the box's closing cap row (no gap), sharing the box's left edge rather
// than being independently centered. There's no keybinding-config system, so
// this shows the slash-command equivalents of the same row.
function hintBar(sessionActive: boolean, terminalWidth: number): string {
  // Kept terse on purpose — the full command list is one `/help` away, and
  // this needs to fit within
  // promptBoxWidth() or it overflows the box's right edge same as the
  // status line does with a long model id.
  const text = "/help commands   /models models   /agent agents"
  return theme.gray(truncateWithEllipsis(text, promptBoxWidth(sessionActive, terminalWidth)))
}

async function main() {
  const { provider, model, shouldContinue, oneShot, testMode, testWidth } = parseArgs(process.argv.slice(2))

  // Pure offline layout diagnostics — no config, no API key, no session, no
  // network. Exists because verifying the TUI layout by eye against a real
  // terminal isn't always available; this prints rulers, exact computed
  // widths/indents, and raw escaped strings for every layout primitive
  // instead. `bun run src/index.ts --test` (add `--test-width=<n>` to check
  // a specific terminal width, e.g. to see the session-box expansion beyond
  // whatever your actual terminal happens to be).
  if (testMode) {
    runLayoutDebug(testWidth)
    return
  }

  if (provider) {
    if (!PROVIDERS.includes(provider as ProviderID)) {
      console.error(theme.error(`Unknown provider: ${provider}. Options: ${PROVIDERS.join(", ")}`))
      process.exit(1)
    }
    process.env["VEGA_PROVIDER"] = provider
  }
  if (model) process.env["VEGA_MODEL"] = model

  let cfg = await loadConfig()

  const cwd = process.cwd()
  let agent: AgentDef = defaultAgent()
  const session = shouldContinue ? (await Session.mostRecent()) ?? (await Session.create(newSessionID())) : await Session.create(newSessionID())

  // Shared by the TUI path (/models, /provider, Ollama bootstrap) and the
  // console path's commandCtx. Explicit selections are persisted for next
  // launch (unlike a one-off --provider/--model CLI flag, which is a session
  // override and deliberately doesn't persist).
  async function setModelPreference(providerID: ProviderID, modelID: string): Promise<VegaConfig> {
    process.env["VEGA_PROVIDER"] = providerID
    process.env["VEGA_MODEL"] = modelID
    cfg = await loadConfig()
    // Fail fast if the new provider/model combo can't even construct
    // (e.g. missing API key) rather than discovering it mid-turn.
    resolveModel(cfg)
    await saveModelPreference(providerID, modelID)
    return cfg
  }

  // Interactive terminal + non-one-shot input: own the screen with the
  // OpenTUI renderer. The TUI handles all prompting itself (permission
  // prompts, command pickers, and the Ollama model bootstrap when the config
  // targets a local Ollama with no model set) through the hooks.ask bridge.
  const interactive = !oneShot && Boolean(process.stdin.isTTY && process.stdout.isTTY)

  if (interactive) {
    const hooks: TuiHooks = {
      ask: () => Promise.resolve("/exit"),
      askPermission: () => Promise.resolve("reject"),
    }
    const permission = new PermissionService(DEFAULT_RULESET, makePermissionPromptFn(hooks))
    // Loaded dynamically so the one-shot/piped/--test console paths never
    // pull in OpenTUI (and its native renderer) at startup.
    const { runTui } = await import("@/tui/app")
    await runTui({
      cwd,
      hooks,
      getConfig: () => cfg,
      getAgent: () => agent,
      setAgent(next) {
        agent = next
      },
      setModel: setModelPreference,
      permission,
      session,
    })
    // The renderer can leave engine timers/native handles behind after it
    // tears down; force a clean exit once the TUI has finished.
    process.exit(0)
  }

  // ------------------------------------------------------------------
  // One-shot / piped console path (unchanged behaviour).
  // ------------------------------------------------------------------
  const consoleInput = createConsoleAsk()
  const permission = new PermissionService(DEFAULT_RULESET, makeConsolePromptFn((prompt) => consoleInput.ask(prompt)))

  if ((cfg.provider === "ollama" || cfg.provider === "groq") && !model) {
    process.env["VEGA_MODEL"] = await selectModel(cfg.provider, (prompt) => consoleInput.ask(prompt))
    cfg = await loadConfig()
  }

  // Printed once at startup, then the box is what's actually interactive —
  // it must NOT be a separate decorative copy of the box (that was the bug:
  // splash prints its own static box, then the real one prints again below
  // the footer, stranding the live input bar far below the logo). Only the
  // logo + the gap leading into where the box goes are printed here; the
  // very first loop iteration's `ask()` call draws the real box immediately
  // after, so there's nothing in between them.
  if (!oneShot) {
    const { columns, rows } = terminalSize()

    // Exact row budget, verified against packages/tui/src/routes/home.tsx
    // and component/prompt/index.tsx (see comments in tui/logo.ts):
    //   gap4 (height=4) -> logo -> gap1 (height=1) -> promptWrapper's own
    //   paddingTop=1 -> the prompt box itself.
    // This whole block sits between two equal flexGrow=1 spacers
    // (home.tsx:73,87); the footer (home.tsx:90-92) is a separate
    // width=100% box OUTSIDE that centered container, so it is NOT part of
    // the centered pool — it's fixed at the very bottom (approximated here
    // as printing once, right after the first exchange, since we don't have
    // a real bottom-pinned region in a scrolling terminal).
    const logoLines = renderLogo()

    const centeredBlockHeight = GAP_BEFORE_LOGO + logoLines.length + GAP_AFTER_LOGO + PROMPT_WRAPPER_PADDING_TOP + PROMPT_FRAME_HEIGHT
    const footerHeight = FOOTER_PADDING + 1 + FOOTER_PADDING

    const remaining = Math.max(0, rows - centeredBlockHeight - footerHeight)
    const spacer = Math.floor(remaining / 2)

    const lines: string[] = []
    lines.push(...Array(spacer).fill(""))
    lines.push(...Array(GAP_BEFORE_LOGO).fill(""))
    lines.push(...centerBlock(logoLines, columns))
    lines.push(...Array(GAP_AFTER_LOGO).fill(""))
    lines.push(...Array(PROMPT_WRAPPER_PADDING_TOP).fill(""))

    console.clear()
    console.log(lines.join("\n"))
  }

  async function turn(userText: string) {
    const controller = new AbortController()
    const sigint = () => controller.abort()
    process.once("SIGINT", sigint)

    permission.resetTurn()
    session.data.messages.push({ role: "user", content: userText })

    let assistantLine = false
    let reasoningLineOpen = false
    try {
      const result = await runAgentLoop({
        agent,
        cwd,
        permission,
        abort: controller.signal,
        sessionID: session.data.id,
        messages: session.data.messages,
        onChunk(event) {
          if (event.type === "reasoning-start") {
            if (assistantLine) {
              process.stdout.write("\n")
              assistantLine = false
            }
            // Collapsed mode: one static marker, no per-delta spam (this is
            // a scrolling terminal, not a repaintable TUI — there's no way
            // to animate a spinner in place across many deltas).
            // Expanded mode: the actual text streams in on reasoning-delta
            // below instead, so nothing to print yet.
            if (!consoleInput.isThinkingExpanded()) console.log(theme.gray("(thinking...)"))
          } else if (event.type === "reasoning-delta") {
            if (consoleInput.isThinkingExpanded()) {
              process.stdout.write(theme.gray(event.text))
              reasoningLineOpen = true
            }
          } else if (event.type === "reasoning-end") {
            if (reasoningLineOpen) {
              process.stdout.write("\n")
              reasoningLineOpen = false
            }
          } else if (event.type === "text") {
            process.stdout.write(event.text)
            assistantLine = true
          } else if (event.type === "tool-call") {
            if (assistantLine) {
              process.stdout.write("\n")
              assistantLine = false
            }
            const input = truncateForDisplay(JSON.stringify(event.input))
            console.log(theme.purple(`→ ${event.name}`) + theme.gray(`(${input})`))
          } else if (event.type === "tool-result") {
            console.log(theme.gray(`  ${truncateForDisplay(event.output)}`))
          } else if (event.type === "tool-error") {
            console.log(theme.error(`  error: ${truncateForDisplay(event.error)}`))
          }
        },
      })
      if (assistantLine) process.stdout.write("\n")
      session.data.messages = result.messages
      await session.save()
    } catch (err) {
      if (assistantLine) process.stdout.write("\n")
      const rateLimit = describeRateLimitError(err)
      if (err instanceof Error && err.name === "PermissionRejectedError") {
        console.log(theme.accent("Permission denied by user."))
      } else if (controller.signal.aborted) {
        console.log(theme.accent("Interrupted."))
      } else if (rateLimit) {
        console.log(theme.error(rateLimit))
      } else {
        console.log(theme.error(`Error: ${err instanceof Error ? err.message : String(err)}`))
      }
    } finally {
      process.removeListener("SIGINT", sigint)
    }
  }

  if (oneShot) {
    await turn(oneShot)
    consoleInput.close()
    return
  }

  const commandCtx: CommandCtx = {
    getConfig: () => cfg,
    setModel: setModelPreference,
    getAgent: () => agent,
    setAgent(next) {
      agent = next
    },
    permission,
    ask: (prompt) => consoleInput.ask(prompt),
    print: (text) => console.log(text),
    clearMessages() {
      session.data.messages = []
    },
    async compact() {
      const model = resolveModel(cfg)
      session.data.messages = await compactMessages({ messages: session.data.messages, model })
      await session.save()
    },
  }

  // The prompt box isn't the same width for the whole app — it's fixed at
  // 75 cols only on the pre-first-message home screen; once a session is
  // active it expands to fill nearly the full terminal width (see the width
  // comment on promptBoxWidth() in tui/logo.ts). The very first frame drawn
  // (right after the splash) still uses the "home" width, then flips to
  // "session" width for every frame after.
  let sessionActive = false

  while (true) {
    const { columns } = terminalSize()
    const frame = renderPromptFrame({
      status: statusLine(cfg, agent, permission.isAutoApprove(), sessionActive, columns),
      hint: hintBar(sessionActive, columns),
      agentColor: fromRgb(...agent.color),
      terminalWidth: columns,
      sessionActive,
    })

    console.log(frame.top.join("\n"))
    const line = await consoleInput.ask(frame.inputPrefix)
    console.log(frame.bottom.join("\n"))

    const trimmed = line.trim()
    // A bare Enter with nothing typed is a no-op — no session is created.
    // Must check this BEFORE flipping
    // sessionActive/printing the footer below, or hitting Enter on an empty
    // home screen would permanently widen the box and print the footer with
    // nothing having actually happened.
    if (trimmed === "") {
      // Every other path (a real turn, a slash command) prints a blank
      // separator line before the next box redraws — this one didn't,
      // so consecutive empty Enters visually mashed each box's hint row
      // directly into the next box's top bar with no gap.
      console.log()
      continue
    }

    // The footer line (cwd/branch, MCP status, version) lives outside the
    // centered home container, fixed at the screen bottom.
    // A scrolling terminal has no real "pin to bottom", so this prints it
    // once, right under the first real submission, rather than repeating it
    // every turn — at the same point the box itself transitions from home
    // to session width.
    if (!sessionActive) {
      // 3 lines total (paddingTop blank, content, paddingBottom blank) to
      // match footer.tsx's paddingTop={1}/paddingBottom={1} and the
      // footerHeight=3 budget the splash's vertical-centering math above
      // already reserves for this — a 2-line print here (missing the
      // trailing blank) would silently desync from that reserved space.
      console.log()
      console.log(theme.gray(`cwd: ${cwd}  session: ${session.data.id}`))
      console.log()
      sessionActive = true
    }

    if (trimmed.startsWith("/")) {
      let outcome: Awaited<ReturnType<typeof runCommand>>
      try {
        outcome = await runCommand(trimmed, commandCtx)
      } catch (err) {
        console.log(theme.error(err instanceof Error ? err.message : String(err)))
        console.log()
        continue
      }
      if (outcome === "exit") break
      console.log()
      continue
    }

    await turn(trimmed)
    console.log()
  }

  consoleInput.close()
}

main()
  .catch((err) => {
    if (err instanceof MissingApiKeyError) {
      console.error(theme.error(err.message))
      process.exit(1)
    }
    console.error(theme.error(err instanceof Error ? (err.stack ?? err.message) : String(err)))
    process.exit(1)
  })
  .finally(() => {
    process.exitCode = process.exitCode ?? 0
  })