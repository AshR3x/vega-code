import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { onFocus, render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
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
import { diffLines, type DiffLine } from "@/tui/diff"
import { runAgentLoop, type AgentLoopEvent } from "@/loop"
import { listModels } from "@/models"
import type { PermissionService } from "@/permission"
import { describeRateLimitError } from "@/util/ratelimit"
import { resolveModel } from "@/provider"
import type { Session } from "@/session"
import { logoRows } from "@/tui/logo"
import { randomSplash } from "@/tui/splash"
import {
  ART_COLS,
  clipText,
  progressParts,
  renderBars,
  startVisualizer,
  toHex,
  visualizerEnabled,
  type VisualizerEvent,
  type VisualizerHandle,
} from "@/tui/visualizer"
import { stripAnsi, summarizeToolResult, truncateForDisplay } from "@/tui/layout"
import { MarkdownText } from "@/tui/markdown"
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
  // Set only on "edit" tool-call rows — rendered as a red/green diff below
  // `input` instead of dumping oldString/newString as raw text.
  diff?: DiffLine[]
}

const MAX_DIFF_LINES = 200

function isEditToolInput(input: unknown): input is { filePath: string; oldString: string; newString: string; replaceAll?: boolean } {
  return (
    !!input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>)["oldString"] === "string" &&
    typeof (input as Record<string, unknown>)["newString"] === "string"
  )
}

interface PendingAsk {
  askId: number
  rowId: number
  resolve: (value: PermissionChoice) => void
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
}

// Renders a tool call's input as clean `key: value` lines instead of raw
// JSON. Each value is clamped independently (single line, truncated) so one
// huge field (write's `content`, edit's `oldString`/`newString`) can't
// swallow the whole box and hide the other params. `reason` is carried
// separately in PendingAsk.metadata and rendered as its own "Reason:" line,
// so it's excluded here to avoid printing it twice.
function formatToolInput(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>).filter(([key]) => key !== "reason")
    return entries.map(([key, value]) => `${key}: ${formatToolValue(value)}`).join("\n")
  }
  return truncateForDisplay(String(input), 2000)
}

function formatToolValue(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === "string") {
    const lines = value.split("\n")
    const first = truncateForDisplay(lines[0] ?? "", 300)
    return lines.length > 1 ? `${first} … (+${lines.length - 1} more lines)` : first
  }
  if (typeof value === "object") return truncateForDisplay(JSON.stringify(value), 300)
  return String(value)
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
// button row. Only the oldest pending ask across the whole session is
// "active" at once — a row whose ask is queued behind it shows a dim
// "waiting…" note instead of buttons, so at most one approval box is
// interactive at any time. The border tint follows the call lifecycle
// (accent → active, dim → queued, success → done, error → failed).
function ToolCallRow(props: { row: HistoryRow; pendingAsks: Accessor<PendingAsk[]>; onRespond(askID: number, choice: PermissionChoice): void }) {
  const renderer = useRenderer()
  const row = props.row
  const ask = createMemo(() => props.pendingAsks().find((a) => a.rowId === row.id))
  const isActive = createMemo(() => props.pendingAsks()[0]?.rowId === row.id)
  const isQueued = createMemo(() => ask() !== undefined && !isActive())
  const [copied, setCopied] = createSignal(false)

  let copyNode: BoxRenderable | undefined
  let approveNode: BoxRenderable | undefined
  let alwaysNode: BoxRenderable | undefined
  let rejectNode: BoxRenderable | undefined

  // The active ask grabs keyboard focus so the user can hit Enter to approve
  // without touching the mouse.
  createEffect(() => {
    if (isActive()) approveNode?.focus()
  })

  const borderColor = createMemo(() => {
    if (isActive()) return colors.accent
    if (isQueued()) return colors.gray
    if (row.status === "error") return colors.error
    if (row.status === "done") return colors.success
    return colors.purpleDim
  })

  const copyText = () => `${row.name ?? "tool"}(${row.input ?? ""})`

  function reasonLine(): string | undefined {
    const reason = ask()?.metadata?.["reason"]
    return typeof reason === "string" && reason ? reason : undefined
  }

  function focusButton(which: "copy" | "approve" | "always" | "reject"): void {
    const node = which === "copy" ? copyNode : which === "approve" ? approveNode : which === "always" ? alwaysNode : rejectNode
    node?.focus()
  }

  // Label order matches reading order: Copy leads, then the permission row.
  function visibleButtons(): ("copy" | "approve" | "always" | "reject")[] {
    return isActive() ? ["copy", "approve", "always", "reject"] : ["copy"]
  }

  function activate(which: "copy" | "approve" | "always" | "reject"): void {
    if (which === "copy") {
      renderer.copyToClipboardOSC52(copyText())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      return
    }
    const active = ask()
    if (!active) return
    props.onRespond(active.askId, which === "approve" ? "once" : which === "always" ? "always" : "reject")
  }

  function buttonKey(e: KeyEvent, which: "copy" | "approve" | "always" | "reject"): void {
    if (e.name === "return" || e.name === "enter") {
      e.preventDefault()
      activate(which)
      return
    }
    if (e.name === "escape") {
      e.preventDefault()
      const active = ask()
      if (active) props.onRespond(active.askId, "reject")
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
      <Show when={row.diff && row.diff.length > 0}>
        <box width="100%" flexDirection="column" border borderColor={colors.purpleDim} paddingX={1}>
          <For each={row.diff}>
            {(line) => (
              <text width="100%" wrapMode="word" fg={line.type === "add" ? colors.success : line.type === "del" ? colors.error : colors.gray}>
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                {line.text}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={isActive() && reasonLine()}>
        <text width="100%" wrapMode="word" fg={colors.accent}>
          Reason: {reasonLine()}
        </text>
      </Show>
      <Show when={isQueued()}>
        <text fg={colors.gray}>waiting for the current approval…</text>
      </Show>
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
        <Show when={isActive()}>
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
  let askId = 0
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

  // Up/Down cycling through previously submitted prompts (shell-history
  // style). -1 means "not browsing" — the input holds the live draft.
  // Stepping past the newest history entry on Down restores whatever the
  // user had typed before they started browsing.
  const promptHistory: string[] = []
  let historyIndex = -1
  let historyDraft = ""

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
      const entry: PendingAsk = {
        askId: askId++,
        rowId: lastToolCallRowId ?? -1,
        resolve,
        permission: req.permission,
        patterns: req.patterns,
        metadata: req.metadata,
      }
      setPendingAsks((prev) => [...prev, entry])
    })
  }

  function respondPermission(askID: number, choice: PermissionChoice): void {
    const entry = pendingAsks().find((a) => a.askId === askID)
    if (!entry) return
    setPendingAsks((prev) => prev.filter((a) => a.askId !== askID))
    entry.resolve(choice)
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
      // Reveal the current step's reasoning collected while collapsed by
      // creating its row now; if the model is still reasoning, later deltas
      // stream into that same row.
      if (next && thinkingBuffer !== "") {
        if (thinkingRowIndex === null) {
          const index = rows.length
          setRows(index, { id: rowId++, kind: "thinking", text: thinkingBuffer } as HistoryRow)
          thinkingRowIndex = index
        } else {
          setRows(thinkingRowIndex, "text", thinkingBuffer)
        }
        if (reasoningActive) streamCursor = { kind: "thinking", index: thinkingRowIndex }
      }
      return next
    })
  })

  // Each mode maps to an agent plus an approval posture: build/plan always
  // ask, auto approves permission prompts for the rest of the session
  // (the `--auto` equivalent).
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
          // Collapsed: no placeholder row. One per tool step piled up between
          // the tool boxes; the working line above the prompt already shows
          // activity, and Tab Tab reveals the reasoning of the current step.
          thinkingRowIndex = null
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
        const id = pushBlock("tool-call", "")
        setRows(id, "name", event.name)
        if (event.name === "edit" && isEditToolInput(event.input)) {
          const { filePath, oldString, newString, replaceAll } = event.input
          setRows(id, "input", formatToolInput({ filePath, ...(replaceAll ? { replaceAll } : {}) }))
          const lines = diffLines(oldString, newString)
          setRows(
            id,
            "diff",
            lines.length > MAX_DIFF_LINES
              ? [...lines.slice(0, MAX_DIFF_LINES), { type: "ctx", text: `… (${lines.length - MAX_DIFF_LINES} more lines)` }]
              : lines,
          )
        } else {
          setRows(id, "input", formatToolInput(event.input))
        }
        setRows(id, "status", "running")
        lastToolCallRowId = id
        break
      }
      case "tool-result":
        if (lastToolCallRowId !== null) setRows(lastToolCallRowId, "status", "done")
        pushBlock("tool-result", summarizeToolResult(event.name, event.output))
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
    props.opts.permission.resetTurn()
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
      const rateLimit = describeRateLimitError(err)
      if (err instanceof Error && err.name === "PermissionRejectedError") {
        pushBlock("system", "Permission denied by user.")
      } else if (controller.signal.aborted) {
        pushBlock("system", "Interrupted.")
      } else if (rateLimit) {
        pushBlock("error", rateLimit)
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
          // rowId must reset alongside the array: addRow()'s caller-visible
          // `id` is only a valid array index (used by later setRows(id, ...)
          // calls, e.g. in the tool-call handler) as long as rowId tracks
          // rows.length in lockstep. Leaving it stale after clearing to 0
          // desyncs the two, so the next tool-call row writes its name/input
          // at an index that doesn't exist and crashes deep in the store.
          rowId = 0
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
    if (promptHistory[promptHistory.length - 1] !== trimmed) promptHistory.push(trimmed)
    historyIndex = -1
    historyDraft = ""
    void (trimmed.startsWith("/") ? runSlashCommand(trimmed) : runTurn(trimmed))
  }

  // Up walks back through promptHistory (saving the in-progress draft the
  // first time), Down walks forward and restores that draft once you step
  // past the newest entry.
  function handleMainInputKeyDown(e: KeyEvent): void {
    if (e.name === "up") {
      if (promptHistory.length === 0) return
      e.preventDefault()
      if (historyIndex === -1) historyDraft = mainInput?.value ?? ""
      historyIndex = historyIndex === -1 ? promptHistory.length - 1 : Math.max(0, historyIndex - 1)
      if (mainInput) mainInput.value = promptHistory[historyIndex]!
      return
    }
    if (e.name === "down") {
      if (historyIndex === -1) return
      e.preventDefault()
      historyIndex++
      if (historyIndex >= promptHistory.length) {
        historyIndex = -1
        if (mainInput) mainInput.value = historyDraft
      } else if (mainInput) {
        mainInput.value = promptHistory[historyIndex]!
      }
    }
  }

  function handleAskSubmit(value: unknown): void {
    if (typeof value !== "string") return
    const state = askState()
    if (!state) return
    setAskState(null)
    askInput?.clear()
    state.resolve(value)
  }

  // Full-screen entry: config resolved to a provider with no model set (no
  // saved preference and no --model flag) — ollama because it has no fixed
  // default at all, groq because its lineup turns over too often to
  // hardcode. Fetch that provider's live model list through the TUI itself
  // instead of silently falling back to something possibly stale.
  async function bootstrapModel(providerID: "ollama" | "groq"): Promise<void> {
    setBusy(true)
    try {
      pushBlock("system", providerID === "ollama" ? "Checking local Ollama models (`ollama list`)..." : "Fetching Groq models...")
      let models: string[]
      try {
        const result = await listModels(providerID)
        models = result.models
        if (!result.live) pushBlock("system", "(live lookup failed, showing a static fallback list)")
      } catch (err) {
        pushBlock("error", err instanceof Error ? err.message : String(err))
        exitApp()
        return
      }
      if (models.length === 0) {
        pushBlock(
          "error",
          providerID === "ollama" ? "No Ollama models found. Pull a model first (e.g. `ollama pull llama3.2`)." : "No Groq models found.",
        )
        exitApp()
        return
      }

      let chosen: string | undefined
      if (models.length === 1) {
        chosen = models[0]!
        pushBlock("system", `Using ${chosen} (only model available)`)
      } else {
        pushBlock("system", providerID === "ollama" ? "Select an Ollama model:" : "Select a Groq model:")
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

      const next = await props.opts.setModel(providerID, chosen)
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
    if ((cfg.provider === "ollama" || cfg.provider === "groq") && !cfg.model) void bootstrapModel(cfg.provider)
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

  // Dynamic terminal/window title: project + agent, prefixed with what the
  // session is doing so a backgrounded tab shows when it needs attention.
  const projectName = props.opts.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "vega"
  createEffect(() => {
    const state = askState() || pendingAsks().length > 0 ? "⚠ awaiting input" : busy() ? "● working" : ""
    const title = [state, `vega · ${projectName}`, statusMemo().agent].filter(Boolean).join(" · ")
    if (!renderer.isDestroyed) renderer.setTerminalTitle(title)
  })

  // Working indicator above the prompt (like Claude Code's spinner line): an
  // animated glyph, a random splash line (fresh per turn, rotating on long
  // turns) and elapsed seconds.
  // Doom-style "argent charge": a bright red slug sweeps back and forth along
  // a track, leaving a fading orange trail like a projectile/muzzle flash.
  const TRACK = 12
  const PERIOD = 2 * (TRACK - 1)
  const [splash, setSplash] = createSignal(randomSplash())
  const [frame, setFrame] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  const trail = createMemo(() => {
    const f = frame() % PERIOD
    const forward = f < TRACK
    const head = forward ? f : PERIOD - f
    return Array.from({ length: TRACK }, (_, i) => {
      const behind = forward ? head - i : i - head
      if (behind === 0) return { ch: "█", fg: colors.error }
      if (behind === 1) return { ch: "▓", fg: colors.accent }
      if (behind === 2) return { ch: "▒", fg: colors.accent }
      if (behind === 3) return { ch: "░", fg: colors.purpleDim }
      return { ch: "·", fg: colors.purpleShadow }
    })
  })
  createEffect(() => {
    if (!busy()) return
    const startedAt = Date.now()
    setSplash((prev) => randomSplash(prev))
    setElapsed(0)
    const frameTimer = setInterval(() => {
      setFrame((f) => (f + 1) % PERIOD)
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 70)
    const splashTimer = setInterval(() => setSplash((prev) => randomSplash(prev)), 8000)
    onCleanup(() => {
      clearInterval(frameTimer)
      clearInterval(splashTimer)
    })
  })

  // Header visualizer (right of the logo/helmet): live spectrum + now-playing
  // from visualizer/feed.py. Absent until the feed produces data.
  const dims = useTerminalDimensions()
  const [viz, setViz] = createSignal<VisualizerEvent | null>(null)
  let vizControl: VisualizerHandle | undefined
  // Album art arrives once per track (on its first frame) and is kept until the next one.
  const [art, setArt] = createSignal<[string, string][][]>([])
  onMount(() => {
    if (!visualizerEnabled()) return
    const handle = startVisualizer((event) => {
      if (event?.frame?.art) setArt(event.frame.art)
      setViz(event)
    })
    vizControl = handle
    onCleanup(() => handle.stop())
  })

  const logo = logoRows()
  const logoWidth = Math.max(...logo.map((r) => r.left.length + r.right.length))
  const VIZ_ROWS = 6
  // paddingLeft(2) + logo + gap(2) + helmet(16) + gap(2) + right margin(2)
  const artWidth = createMemo(() => (art().length > 0 ? ART_COLS + 2 : 0))
  const vizWidth = createMemo(() => Math.min(64, dims().width - (2 + logoWidth + 2 + 16 + 2 + 2) - artWidth()))
  const vizGrid = createMemo(() => {
    const frame = viz()?.frame
    const width = vizWidth()
    if (!frame || width < 16) return []
    return renderBars(frame.bars, frame.palette.map((c) => c as [number, number, number]), width, VIZ_ROWS)
  })
  const vizTitle = createMemo(() => {
    const frame = viz()?.frame
    if (!frame) return ""
    return clipText(`♪ ${frame.title}${frame.artist ? ` — ${frame.artist}` : ""}`, vizWidth())
  })
  const vizProgress = createMemo(() => {
    const frame = viz()?.frame
    return frame ? progressParts(frame, vizWidth()) : null
  })
  const vizAccent = createMemo(() => {
    const palette = viz()?.frame?.palette
    return palette && palette.length > 0 ? toHex(palette[palette.length - 1] as [number, number, number]) : colors.purple
  })

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
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} gap={2}>
        <box>
          <For each={logo}>
            {(row) => (
              <text wrapMode="none">
                <span style={{ fg: row.leftColor }}>{row.left}</span>
                <span style={{ fg: row.rightColor }}>{row.right}</span>
              </text>
            )}
          </For>
        </box>
        <image source="C:/Users/ashwi/Downloads/breutt8ycg2f1.png" width={16} height={8} fit="fit" />
        <box flexGrow={1} />
        <box flexDirection="row" flexShrink={0} gap={2}>
          <Show when={viz() !== null && vizWidth() >= 16 && art().length > 0 && viz()?.frame}>
            <box flexDirection="column" width={ART_COLS} height={8} flexShrink={0}>
              <Index each={art()}>
                {(row) => (
                  <text wrapMode="none">
                    <Index each={row()}>{(cell) => <span style={{ fg: cell()[0], bg: cell()[1] }}>▀</span>}</Index>
                  </text>
                )}
              </Index>
            </box>
          </Show>
          <Show when={viz() !== null && vizWidth() >= 16}>
            <box flexDirection="column" width={vizWidth()} height={8} flexShrink={0}>
              <Show
                when={viz()?.frame}
                fallback={
                  <text wrapMode="none" fg={colors.gray}>
                    ♪ nothing playing
                  </text>
                }
              >
                <Index each={vizGrid()}>
                  {(row) => (
                    <text wrapMode="none">
                      <Index each={row()}>{(cell) => <span style={{ fg: cell().fg }}>{cell().ch}</span>}</Index>
                    </text>
                  )}
                </Index>
                <text wrapMode="none" fg={colors.white}>
                  {vizTitle()}
                </text>
                <box flexDirection="row" height={1} flexShrink={0}>
                  {/* Clickable play/pause: the icon plus a trailing space, so it's easy to hit. */}
                  <box
                    width={3}
                    height={1}
                    onMouseDown={(e: TuMouseEvent) => {
                      if (e.button === 0) vizControl?.send("playpause")
                    }}
                  >
                    <text wrapMode="none" fg={vizAccent()}>
                      {vizProgress()?.icon}
                    </text>
                  </box>
                  <text wrapMode="none">
                    <span style={{ fg: vizAccent() }}>{vizProgress()?.played}</span>
                    <span style={{ fg: colors.white }}>{vizProgress()?.dot}</span>
                    <span style={{ fg: colors.gray }}>{vizProgress()?.rest}</span>
                    <span style={{ fg: colors.gray }}>{vizProgress()?.time}</span>
                  </text>
                </box>
              </Show>
            </box>
          </Show>
        </box>
      </box>

      <scrollbox
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width="100%"
        stickyScroll
        stickyStart="bottom"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
      >
        <For each={rows}>
          {(row) => {
            if (row.kind === "tool-call") {
              return <ToolCallRow row={row} pendingAsks={pendingAsks} onRespond={respondPermission} />
            }
            const label = rowLabel(row.kind, props.opts.getAgent())
            const labelSpan = label ? (
              // The <span> catalogue doesn't type attributes; set it via the
              // node ref so the label shares the row's emphasis.
              <span
                style={{ fg: label.fg }}
                ref={(node) => {
                  if (node) node.attributes = label.attrs
                }}
              >
                {label.prefix}
              </span>
            ) : undefined
            if (row.kind === "assistant") {
              return <MarkdownText text={row.text} baseColor={colors.white} leading={labelSpan} />
            }
            return (
              <text width="100%" wrapMode="word" fg={rowColor(row.kind)} attributes={rowAttributes(row.kind)}>
                {labelSpan}
                {row.text}
              </text>
            )
          }}
        </For>
      </scrollbox>

      <Show when={busy() && !askState() && pendingAsks().length === 0}>
        <text width="100%" flexShrink={0} wrapMode="none" truncate paddingLeft={2}>
          <For each={trail()}>{(cell) => <span style={{ fg: cell.fg }}>{cell.ch}</span>}</For>
          <span style={{ fg: colors.white }}> {splash()}</span>
          <span style={{ fg: colors.gray }}> ({elapsed()}s · esc to interrupt)</span>
        </text>
      </Show>

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
              onKeyDown={handleMainInputKeyDown}
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
