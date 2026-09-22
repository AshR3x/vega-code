import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { onFocus, render, useKeyboard, useRenderer } from "@opentui/solid"
import {
  createCliRenderer,
  TextAttributes,
  type BoxRenderable,
  type InputRenderable,
  type KeyEvent,
  type MouseEvent as TuMouseEvent,
} from "@opentui/core"
import { AGENTS, defaultAgent, type AgentDef } from "@/agent"
import { runCommand, type CommandCtx } from "@/command"
import type { ProviderID, VegaConfig } from "@/config"
import { compact as compactMessages } from "@/context"
import { runAgentLoop, type AgentLoopEvent } from "@/loop"
import { listOllamaModels } from "@/ollama"
import type { PermissionService } from "@/permission"
import { resolveModel } from "@/provider"
import type { Session } from "@/session"
import { logoRows } from "@/tui/logo"
import { stripAnsi, truncateForDisplay } from "@/tui/layout"
import { colors } from "@/tui/theme"

// index.ts builds the PermissionService's promptFn around this hook, so
// permission prompts surfacing mid-turn are answered through the TUI's own
// tool-call buttons (Approve / Always / Reject). The app assigns the real
// implementation on mount.
export type PermissionChoice = "once" | "always" | "reject"

export interface TuiHooks {
  ask(prompt: string): Promise<string>
  askPermission(req: { permission: string; patterns: string[]; metadata?: Record<string, unknown> }): Promise<PermissionChoice>
}

// Editor modes: plan/build/auto are cycled with Shift+Tab; a manually
// /agent-selected agent that isn't plan or build is "custom" and carries no
// mode state of its own.
type Mode = "plan" | "build" | "auto" | "custom"
const MODE_CYCLE: Mode[] = ["plan", "build", "auto"]

function initialMode(agent: AgentDef): Mode {
  if (agent.name === "plan") return "plan"
  if (agent.name === "build") return "build"
  return "custom"
}

export interface TuiOptions {
  cwd: string
  hooks: TuiHooks
  getConfig(): VegaConfig
  getAgent(): AgentDef
  setAgent(agent: AgentDef): void
  setModel(providerID: ProviderID, model: string): Promise<VegaConfig>
  permission: PermissionService
  session: Session
}

const DOUBLE_TAP_WINDOW_MS = 400

type RowKind = "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "tool-error" | "system" | "error"

interface HistoryRow {
  id: number
  kind: RowKind
  text: string
  // Set only on "tool-call" rows.
  name?: string
  input?: string
  status?: "running" | "done" | "error"
}

interface PendingAsk {
  id: number
  resolve: (value: PermissionChoice) => void
  permission: string
  patterns: string[]
}

interface AskState {
  prompt: string
  resolve: (value: string) => void
}

function agentHex(agent: AgentDef): string {
  const [r, g, b] = agent.color
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

function rowColor(kind: RowKind): string {
  switch (kind) {
    case "tool-call":
      return colors.purpleBright
    case "tool-error":
    case "error":
      return colors.error
    case "thinking":
    case "tool-result":
    case "system":
      return colors.gray
    default:
      return colors.white
  }
}

function rowAttributes(kind: RowKind): number {
  if (kind === "user") return TextAttributes.BOLD
  if (kind === "thinking") return TextAttributes.ITALIC
  return TextAttributes.NONE
}

// Turn labels make it obvious who said what: `you ›` for the user's own
// messages (cyan, bold), `<agent> ›` (the agent's accent color) for answers.
function rowLabel(kind: RowKind, agent: AgentDef): { prefix: string; fg: string; attrs: number } | null {
  if (kind === "user") return { prefix: "you › ", fg: colors.cyan, attrs: TextAttributes.BOLD }
  if (kind === "assistant") return { prefix: `${agent.name} › `, fg: agentHex(agent), attrs: TextAttributes.BOLD }
  return null
}

interface TuiAppProps {
  opts: TuiOptions
  onExit(err?: unknown): void
}

// A tool invocations rendered as a bordered box: `→ name(input)`, then a
// button row. While a permission ask for this call is pending the border
// glows accent and Approve/Always/Reject appear (Enter or left-click on a
// button activates it; ←/→ move focus, Escape rejects); otherwise only Copy
// shows. The border tint follows the call lifecycle (accent → pending,
// success → done, error → failed).
function ToolCallRow(props: { row: HistoryRow; pendingAsks: Accessor<PendingAsk[]>; onRespond(rowID: number, choice: PermissionChoice): void }) {
  const renderer = useRenderer()
  const row = props.row
  const isPending = createMemo(() => props.pendingAsks().some((a) => a.id === row.id))
  const [copied, setCopied] = createSignal(false)

  let copyNode: BoxRenderable | undefined
  let approveNode: BoxRenderable | undefined
  let alwaysNode: BoxRenderable | undefined
  let rejectNode: BoxRenderable | undefined

  // The newest pending ask grabs keyboard focus so the user can hit Enter to
  // approve without touching the mouse.
  createEffect(() => {
    if (!isPending()) return
    const asks = props.pendingAsks()
    if (asks[asks.length - 1]?.id === row.id) approveNode?.focus()
  })

  const borderColor = createMemo(() => {
    if (isPending()) return colors.accent
    if (row.status === "error") return colors.error
    if (row.status === "done") return colors.success
    return colors.purpleDim
  })

  const copyText = () => `${row.name ?? "tool"}(${row.input ?? ""})`

  function focusButton(which: "copy" | "approve" | "always" | "reject"): void {
    const node = which === "copy" ? copyNode : which === "approve" ? approveNode : which === "always" ? alwaysNode : rejectNode
    node?.focus()
  }

  // Label order matches reading order: Copy leads, then the permission row.
  function visibleButtons(): ("copy" | "approve" | "always" | "reject")[] {
    return isPending() ? ["copy", "approve", "always", "reject"] : ["copy"]
  }

  function activate(which: "copy" | "approve" | "always" | "reject"): void {
    if (which === "copy") {
      renderer.copyToClipboardOSC52(copyText())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      return
    }
    props.onRespond(row.id, which === "approve" ? "once" : which === "always" ? "always" : "reject")
  }

  function buttonKey(e: KeyEvent, which: "copy" | "approve" | "always" | "reject"): void {
    if (e.name === "return" || e.name === "enter") {
      e.preventDefault()
      activate(which)
      return
    }
    if (e.name === "escape") {
      e.preventDefault()
      props.onRespond(row.id, "reject")
      return
    }
    if (e.name === "left" || e.name === "right") {
      e.preventDefault()
      const list = visibleButtons()
      const next = list[(list.indexOf(which) + (e.name === "right" ? 1 : -1) + list.length) % list.length]!
      focusButton(next)
    }
  }

  return (
    <box width="100%" border borderColor={borderColor()} paddingX={1} paddingTop={0}>
      <text wrapMode="none" fg={colors.purpleBright}>
        → {row.name}
      </text>
      <text width="100%" wrapMode="word" fg={colors.white}>
        {row.input}
      </text>
      <box flexDirection="row" width="100%" paddingTop={1}>
        <box
          border
          borderColor={colors.purpleDim}
          focusedBorderColor={colors.white}
          paddingX={1}
          marginRight={1}
          focusable
          ref={(node) => {
            copyNode = node
          }}
          onMouseDown={(e: TuMouseEvent) => {
            if (e.button === 0) activate("copy")
          }}
          onKeyDown={(e: KeyEvent) => buttonKey(e, "copy")}
        >
          <text fg={copied() ? colors.success : colors.white}>{copied() ? "Copied" : "Copy"}</text>
        </box>
        <Show when={isPending()}>
          <box
            border
            borderColor={colors.accent}
            focusedBorderColor={colors.white}
            paddingX={1}
            marginRight={1}
            focusable
            ref={(node) => {
              approveNode = node
            }}
            onMouseDown={(e: TuMouseEvent) => {
              if (e.button === 0) activate("approve")
            }}
            onKeyDown={(e: KeyEvent) => buttonKey(e, "approve")}
          >
            <text fg={colors.success}>Approve</text>
          </box>
          <box
            border
            borderColor={colors.accent}
            focusedBorderColor={colors.white}
            paddingX={1}
            marginRight={1}
            focusable
            ref={(node) => {
              alwaysNode = node
            }}
            onMouseDown={(e: TuMouseEvent) => {
              if (e.button === 0) activate("always")
            }}
            onKeyDown={(e: KeyEvent) => buttonKey(e, "always")}
          >
            <text fg={colors.purpleBright}>Always</text>
          </box>
          <box
            border
            borderColor={colors.accent}
            focusedBorderColor={colors.white}
            paddingX={1}
            marginRight={1}
            focusable
            ref={(node) => {
              rejectNode = node
            }}
            onMouseDown={(e: TuMouseEvent) => {
              if (e.button === 0) activate("reject")
            }}
            onKeyDown={(e: KeyEvent) => buttonKey(e, "reject")}
          >
            <text fg={colors.error}>Reject</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

export function TuiApp(props: TuiAppProps) {
  props.opts.hooks.ask = ask
  props.opts.hooks.askPermission = askPermission

  const renderer = useRenderer()
  const [rows, setRows] = createStore<HistoryRow[]>([])
  const [askState, setAskState] = createSignal<AskState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [thinkingExpanded, setThinkingExpanded] = createSignal(false)
  const [mode, setMode] = createSignal<Mode>(initialMode(props.opts.getAgent()))
  const [pendingAsks, setPendingAsks] = createSignal<PendingAsk[]>([])
  const [providerID, setProviderID] = createSignal(props.opts.getConfig().provider)
  const [modelID, setModelID] = createSignal(props.opts.getConfig().model)
  const [tick, setTick] = createSignal(0)
  const [clockText, setClockText] = createSignal("")

  let rowId = 0
  let streamCursor: { kind: "assistant" | "thinking"; index: number } | null = null
  let currentAbort: AbortController | null = null
  // Thinking is buffered even when collapsed so a double-tap Tab can reveal
  // what the model reasoned about earlier in the turn.
  let thinkingBuffer = ""
  let thinkingRowIndex: number | null = null
  let reasoningActive = false
  let lastToolCallRowId: number | null = null
  let exited = false

  let mainInput: InputRenderable | undefined
  let askInput: InputRenderable | undefined

  function addRow(content: Omit<HistoryRow, "id">): number {
    const id = rowId++
    setRows(rows.length, { ...content, id } as HistoryRow)
    return id
  }

  function pushBlock(kind: RowKind, text: string): number {
    streamCursor = null
    return addRow({ kind, text })
  }

  function appendStream(kind: "assistant" | "thinking", delta: string): void {
    if (streamCursor && streamCursor.kind === kind) {
      setRows(streamCursor.index, "text", (t: string) => t + delta)
      return
    }
    const index = rows.length
    setRows(index, { id: rowId++, kind, text: delta } as HistoryRow)
    streamCursor = { kind, index }
  }

  // The TUI's one ask() entry point: surfaces the prompt in the ask input
  // and resolves with whatever the user types ("" = cancelled via Ctrl+C).
  function ask(prompt: string): Promise<string> {
    pushBlock("system", truncateForDisplay(prompt, 800))
    return new Promise<string>((resolve) => {
      setAskState({ prompt, resolve })
    })
  }

  // Permission prompts surface as button rows on the relevant tool-call box
  // (see ToolCallRow) instead of a text ask. The Promise stays open until the
  // user picks Approve/Always/Reject (or Ctrl+C rejects it).
  function askPermission(req: { permission: string; patterns: string[]; metadata?: Record<string, unknown> }): Promise<PermissionChoice> {
    return new Promise<PermissionChoice>((resolve) => {
      setPendingAsks((prev) => [...prev, { id: lastToolCallRowId ?? -1, resolve, permission: req.permission, patterns: req.patterns }])
    })
  }

  function respondPermission(rowID: number, choice: PermissionChoice): void {
    const ask = pendingAsks().find((a) => a.id === rowID)
    if (!ask) return
    setPendingAsks((prev) => prev.filter((a) => a.id !== rowID))
    ask.resolve(choice)
    if (pendingAsks().length === 0) focusActiveInput()
  }

  function cancelPendingAsks(): void {
    const asks = pendingAsks()
    asks.forEach((a) => a.resolve("reject"))
    setPendingAsks([])
    focusActiveInput()
  }

  function focusActiveInput(): void {
    if (askState()) askInput?.focus()
    else mainInput?.focus()
  }

  function exitApp(err?: unknown): void {
    if (exited) return
    exited = true
    setBusy(false)
    props.onExit(err)
  }

  function handleInterrupt(): void {
    const state = askState()
    if (state) {
      setAskState(null)
      askInput?.clear()
      state.resolve("")
      return
    }
    // Ctrl+C while a permission prompt is up cancels the prompt (returns the
    // tool's ask as "reject", letting the loop surface the denial) rather
    // than aborting the whole run.
    if (pendingAsks().length > 0) {
      cancelPendingAsks()
      return
    }
    if (busy()) {
      currentAbort?.abort()
      return
    }
    exitApp()
  }

  // Typing should always land in the prompt box. If focus was lost (e.g. a
  // click on the scrollback focused something else), any keystroke bounces it
  // right back: global handlers run before the focused element sees the key,
  // so the same keystroke still reaches the input after we refocus.
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.ctrl || key.meta || key.option) return
    if (key.name === "enter") return
    if (!renderer.currentFocusedEditor) focusActiveInput()
  })

  // Same idea for the terminal window coming back into focus (e.g. the user
  // clicked into the terminal after reading elsewhere): snap focus back to
  // the prompt so typing works immediately.
  onFocus(() => {
    focusActiveInput()
  })

  // Ctrl+C (exitOnCtrlC is false on the renderer, so this is our job).
  // Global handlers run before focused-input handlers — preventDefault keeps
  // the input from seeing the key at all.
  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) {
      key.preventDefault()
      handleInterrupt()
    }
  })

  // Escape is a softer interrupt than Ctrl+C: it cancels an in-flight turn or
  // a pending prompt, but never exits the app (an accidental press shouldn't
  // kill the session). When idle it does nothing and passes through.
  useKeyboard((key) => {
    if (key.name !== "escape") return
    const state = askState()
    if (state) {
      key.preventDefault()
      setAskState(null)
      askInput?.clear()
      state.resolve("")
      return
    }
    if (pendingAsks().length > 0) {
      key.preventDefault()
      cancelPendingAsks()
      return
    }
    if (busy()) {
      key.preventDefault()
      currentAbort?.abort()
    }
  })

  // Double-tap Tab toggles collapsed vs. live streaming of model thinking;
  // Shift+Tab cycles the editor mode (plan → build → auto). Global handlers
  // run before focused-input handlers — preventDefault keeps the input from
  // seeing the key at all.
  let lastTabAt = 0
  useKeyboard((key) => {
    if (key.name !== "tab") return
    // Shift+Tab is the mode gesture; it must not count toward the double-tap
    // window or it would trigger an unintentional thinking toggle.
    if (key.shift) {
      key.preventDefault()
      lastTabAt = 0
      cycleMode()
      return
    }
    const now = Date.now()
    if (now - lastTabAt >= DOUBLE_TAP_WINDOW_MS) {
      lastTabAt = now
      return
    }
    key.preventDefault()
    lastTabAt = 0
    setThinkingExpanded((prev) => {
      const next = !prev
      // Reveal reasoning collected while collapsed by backfilling the
      // "(thinking...)" placeholder row instead of abandoning it; if the
      // model is still reasoning, later deltas stream into that same row.
      if (next && thinkingRowIndex !== null && thinkingBuffer !== "") {
        setRows(thinkingRowIndex, "text", thinkingBuffer)
        if (reasoningActive) streamCursor = { kind: "thinking", index: thinkingRowIndex }
      }
      return next
    })
  })

  // Each mode maps to an agent plus an approval posture: build/plan always
  // ask, auto approves permission prompts for the rest of the session
  // (mirrors opencode's `--auto` flag).
  function applyMode(next: Mode): void {
    setMode(next)
    if (next === "plan") {
      props.opts.setAgent(AGENTS.plan ?? defaultAgent())
      props.opts.permission.setAutoApprove(false)
    } else if (next === "build") {
      props.opts.setAgent(AGENTS.build ?? defaultAgent())
      props.opts.permission.setAutoApprove(false)
    } else if (next === "auto") {
      props.opts.setAgent(AGENTS.build ?? defaultAgent())
      props.opts.permission.setAutoApprove(true)
    }
    pushBlock("system", `Mode: ${next}`)
    setTick((t) => t + 1)
  }

  function cycleMode(): void {
    const idx = MODE_CYCLE.indexOf(mode())
    applyMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!)
  }

  function handleChunk(event: AgentLoopEvent): void {
    switch (event.type) {
      case "text":
        appendStream("assistant", event.text)
        break
      case "reasoning-start": {
        reasoningActive = true
        thinkingBuffer = ""
        if (thinkingExpanded()) {
          const index = rows.length
          setRows(index, { id: rowId++, kind: "thinking", text: "" } as HistoryRow)
          streamCursor = { kind: "thinking", index }
          thinkingRowIndex = index
        } else {
          thinkingRowIndex = pushBlock("thinking", "(thinking...)")
        }
        break
      }
      case "reasoning-delta": {
        thinkingBuffer += event.text
        if (thinkingExpanded()) appendStream("thinking", event.text)
        break
      }
      case "reasoning-end":
        reasoningActive = false
        streamCursor = null
        break
      case "tool-call": {
        const input = truncateForDisplay(JSON.stringify(event.input), 2000)
        const id = pushBlock("tool-call", "")
        setRows(id, "name", event.name)
        setRows(id, "input", input)
        setRows(id, "status", "running")
        lastToolCallRowId = id
        break
      }
      case "tool-result":
        if (lastToolCallRowId !== null) setRows(lastToolCallRowId, "status", "done")
        pushBlock("tool-result", truncateForDisplay(event.output))
        break
      case "tool-error":
        if (lastToolCallRowId !== null) setRows(lastToolCallRowId, "status", "error")
        pushBlock("tool-error", `error: ${truncateForDisplay(event.error)}`)
        break
    }
  }

  async function runTurn(userText: string): Promise<void> {
    if (busy()) return
    setBusy(true)
    const controller = new AbortController()
    currentAbort = controller
    try {
      props.opts.session.data.messages.push({ role: "user", content: userText })
      pushBlock("user", userText)
      const result = await runAgentLoop({
        agent: props.opts.getAgent(),
        cwd: props.opts.cwd,
        permission: props.opts.permission,
        abort: controller.signal,
        sessionID: props.opts.session.data.id,
        messages: props.opts.session.data.messages,
        onChunk: handleChunk,
      })
      streamCursor = null
      props.opts.session.data.messages = result.messages
      await props.opts.session.save()
    } catch (err) {
      streamCursor = null
      if (err instanceof Error && err.name === "PermissionRejectedError") {
        pushBlock("system", "Permission denied by user.")
      } else if (controller.signal.aborted) {
        pushBlock("system", "Interrupted.")
      } else {
        pushBlock("error", `Error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      if (currentAbort === controller) currentAbort = null
      setBusy(false)
    }
  }

  function applyConfig(cfg: VegaConfig): void {
    setProviderID(cfg.provider)
    setModelID(cfg.model)
    setTick((t) => t + 1)
  }

  async function runSlashCommand(line: string): Promise<void> {
    if (busy()) return
    setBusy(true)
    try {
      const commandCtx: CommandCtx = {
        getConfig: props.opts.getConfig,
        async setModel(providerID, modelID) {
          const next = await props.opts.setModel(providerID, modelID)
          applyConfig(next)
          return next
        },
        getAgent: props.opts.getAgent,
        setAgent(next) {
          props.opts.setAgent(next)
          // Keep the mode indicator in sync with a manual /agent switch.
          const m: Mode = next.name === "plan" ? "plan" : next.name === "build" ? "build" : "custom"
          setMode(m)
          if (m !== "custom") props.opts.permission.setAutoApprove(false)
        },
        permission: props.opts.permission,
        ask,
        // Commands print theme-colored ANSI strings; strip them so the TUI
        // text renderable shows clean text instead of raw escape sequences.
        print: (text) => pushBlock("system", stripAnsi(text)),
        clearMessages() {
          props.opts.session.data.messages = []
          // Clear the whole page too, not just context: wipe every rendered
          // row and any dangling per-turn state so /clear gives a blank slate.
          setRows([])
          streamCursor = null
          thinkingBuffer = ""
          thinkingRowIndex = null
          reasoningActive = false
          lastToolCallRowId = null
          setPendingAsks([])
          setAskState(null)
          mainInput?.focus()
        },
        async compact() {
          const model = resolveModel(props.opts.getConfig())
          props.opts.session.data.messages = await compactMessages({ messages: props.opts.session.data.messages, model })
          await props.opts.session.save()
        },
      }
      const outcome = await runCommand(line, commandCtx)
      if (outcome === "exit") {
        exitApp()
        return
      }
    } catch (err) {
      pushBlock("error", err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setTick((t) => t + 1)
    }
  }

  // The JSX intrinsics type onSubmit as `(event) & (value: string)`. The
  // reconciler actually calls it with the current value string; `unknown`
  // satisfies both slots and we narrow at runtime.
  function handleMainSubmit(value: unknown): void {
    if (typeof value !== "string" || busy()) return
    mainInput?.clear()
    const trimmed = value.trim()
    if (trimmed === "") return
    void (trimmed.startsWith("/") ? runSlashCommand(trimmed) : runTurn(trimmed))
  }

  function handleAskSubmit(value: unknown): void {
    if (typeof value !== "string") return
    const state = askState()
    if (!state) return
    setAskState(null)
    askInput?.clear()
    state.resolve(value)
  }

  // Full-screen entry: in config file `provider: "ollama"` with no model set
  // (no model saved and no --model flag), pick a local model through the TUI
  // itself instead of the console fallback — same flow as the CLI path.
  async function bootstrapOllama(): Promise<void> {
    setBusy(true)
    try {
      pushBlock("system", "Checking local Ollama models (`ollama list`)...")
      const models = await listOllamaModels()
      if (models.length === 0) {
        pushBlock("error", "No Ollama models found. Pull a model first (e.g. `ollama pull llama3.2`).")
        exitApp()
        return
      }

      let chosen: string | undefined
      if (models.length === 1) {
        chosen = models[0]!
        pushBlock("system", `Using ${chosen} (only local model available)`)
      } else {
        pushBlock("system", "Select an Ollama model:")
        models.forEach((name, i) => pushBlock("system", `  ${i + 1}) ${name}`))
        while (true) {
          const reply = (await ask(`Model [1-${models.length}]: `)).trim()
          if (reply === "") break
          const idx = Number(reply)
          if (Number.isInteger(idx) && idx >= 1 && idx <= models.length) {
            chosen = models[idx - 1]!
            break
          }
          pushBlock("error", "Invalid selection.")
        }
      }

      if (!chosen) {
        exitApp()
        return
      }

      const next = await props.opts.setModel("ollama", chosen)
      applyConfig(next)
      pushBlock("system", `Using model: ${chosen}`)
    } catch (err) {
      exitApp(err)
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    const cfg = props.opts.getConfig()
    if (cfg.provider === "ollama" && !cfg.model) void bootstrapOllama()
    const fmt = (d: Date) => d.toLocaleTimeString("en-GB", { hour12: false })
    setClockText(fmt(new Date()))
    const timer = setInterval(() => setClockText(fmt(new Date())), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const promptColor = createMemo(() => {
    tick()
    if (askState() || mode() === "auto") return colors.accent
    return agentHex(props.opts.getAgent())
  })

  const statusMemo = createMemo(() => {
    tick()
    return {
      agent: props.opts.getAgent().name,
      model: `${providerID()}/${modelID()}`,
      auto: props.opts.permission.isAutoApprove() ? " [auto]" : "",
    }
  })

  const logo = logoRows()

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      onMouseDown={() => {
        // Mouse bubbles up through the tree, so any click — on the
        // scrollback, mode hint, logo, wherever — hands focus back to the
        // active input, so the next keystroke types straight into the box.
        focusActiveInput()
      }}
    >
      <box flexShrink={0} paddingLeft={2} paddingTop={2}>
        <For each={logo}>
          {(row) => (
            <text wrapMode="none">
              <span style={{ fg: row.leftColor }}>{row.left}</span>
              <span style={{ fg: row.rightColor }}>{row.right}</span>
            </text>
          )}
        </For>
      </box>

      <scrollbox flexGrow={1} width="100%" stickyScroll stickyStart="bottom" paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <For each={rows}>
          {(row) => {
            if (row.kind === "tool-call") {
              return <ToolCallRow row={row} pendingAsks={pendingAsks} onRespond={respondPermission} />
            }
            const label = rowLabel(row.kind, props.opts.getAgent())
            return (
              <text width="100%" wrapMode="word" fg={rowColor(row.kind)} attributes={rowAttributes(row.kind)}>
                {label ? (
                  // The <span> catalogue doesn't type attributes; set it via
                  // the node ref so the label shares the row's emphasis.
                  <span
                    style={{ fg: label.fg }}
                    ref={(node) => {
                      if (node) node.attributes = label.attrs
                    }}
                  >
                    {label.prefix}
                  </span>
                ) : undefined}
                {row.text}
              </text>
            )
          }}
        </For>
      </scrollbox>

      <box width="100%" flexShrink={0} height={2} flexDirection="column" border={["left"]} borderColor={promptColor()} paddingLeft={1} paddingRight={2}>
        <Show
          when={askState()}
          fallback={
            <input
              width="100%"
              ref={(node) => {
                mainInput = node
                if (!askState()) node.focus()
              }}
              onSubmit={handleMainSubmit}
              placeholder={busy() ? "…" : "Ask anything — or /help for commands"}
              maxLength={1000}
            />
          }
        >
          <input
            width="100%"
            ref={(node) => {
              askInput = node
              if (askState()) node.focus()
            }}
            onSubmit={handleAskSubmit}
            placeholder={askState()?.prompt ?? ""}
            maxLength={1000}
          />
        </Show>
        <box width="100%" flexDirection="row">
          <text wrapMode="none">
            <span style={{ fg: promptColor() }}>{statusMemo().agent}</span>
            <span style={{ fg: colors.gray }}>  {statusMemo().model}</span>
            <span style={{ fg: colors.accent }}>{statusMemo().auto}</span>
          </text>
          <box flexGrow={1} />
          <text wrapMode="none" fg={colors.gray}>
            {clockText()}
          </text>
        </box>
      </box>

      <text width="100%" flexShrink={0} wrapMode="none" fg={colors.gray} truncate paddingLeft={2}>
        Shift+Tab: modes   /help commands   /models models   /agent agents
      </text>
    </box>
  )
}

// OpenTUI's `render()` mounts the tree and returns immediately — it does NOT
// resolve when the renderer is destroyed. runTui therefore owns the exit
// lifecycle itself: an explicit onExit call (clean exit via Ctrl+C or
// /exit, fatal error via err) tears the renderer down, waits a beat for the
// terminal to restore, then resolves (or rejects, so main().catch can print
// the error and set a non-zero exit code).
export async function runTui(opts: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })

  return new Promise<void>((resolve, reject) => {
    let settled = false

    const teardown = (err?: unknown): void => {
      if (settled) return
      settled = true
      renderer.off("destroy", onDestroyed)
      try {
        if (!renderer.isDestroyed) renderer.destroy()
      } catch {
        // destroy() itself is responsible for terminal restore; a throw here
        // is best-effort — the onExit promise below still settles either way.
      }
      setTimeout(() => (err ? reject(err) : resolve()), 50)
    }

    // External teardown (e.g. terminal close) should also settle runTui.
    const onDestroyed = (): void => teardown()
    renderer.on("destroy", onDestroyed)

    render(() => <TuiApp opts={opts} onExit={teardown} />, renderer).catch((err: unknown) => teardown(err))
  })
}
