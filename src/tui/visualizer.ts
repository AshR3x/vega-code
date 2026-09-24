import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"
import { resolvePython } from "@/tool/py"

// Talks to visualizer/feed.py, which streams the terminal-visualizer project's
// live spectrum + now-playing data as one JSON object per line. Everything is
// best-effort: if Python, the deps or the project dir are missing, the child
// exits and the header panel simply never appears.

export type RGB = [number, number, number]

export interface VisualizerFrame {
  bars: number[]
  palette: RGB[]
  title: string
  artist: string
  playing: boolean
  position: number
  duration: number
  // Present only on the first frame of a track: [top, bottom] hex per half-block cell.
  art?: [string, string][][]
}

export const ART_COLS = 16

export interface VisualizerEvent {
  frame?: VisualizerFrame
  idle?: boolean
}

export const VISUALIZER_BARS = 48
const FPS = 15
const FEED_SCRIPT = path.resolve(import.meta.dir, "../../visualizer/feed.py")

export function visualizerEnabled(): boolean {
  return (process.env["VEGA_VISUALIZER"] ?? "on").toLowerCase() !== "off"
}

export type VisualizerCommand = "playpause" | "next" | "prev"

export interface VisualizerHandle {
  send(command: VisualizerCommand): void
  stop(): void
}

export function startVisualizer(onEvent: (event: VisualizerEvent | null) => void): VisualizerHandle {
  let child: ChildProcess | undefined
  let stopped = false

  const kill = () => {
    if (child && !child.killed) child.kill()
  }
  process.once("exit", kill)

  void (async () => {
    let python
    try {
      python = await resolvePython()
    } catch {
      return
    }
    if (stopped) return

    child = spawn(python.cmd, [...python.pre, FEED_SCRIPT, String(VISUALIZER_BARS), String(FPS)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    })
    child.stdin?.on("error", () => {})
    child.on("error", () => onEvent(null))
    child.on("close", () => onEvent(null))

    let buffered = ""
    child.stdout?.setEncoding("utf-8")
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk
      let nl: number
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim()
        buffered = buffered.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          if (msg["error"]) onEvent(null)
          else if (msg["idle"]) onEvent({ idle: true })
          else if (Array.isArray(msg["bars"])) onEvent({ frame: msg as unknown as VisualizerFrame })
        } catch {
          // partial or garbled line; the next frame replaces it
        }
      }
    })
  })()

  return {
    send(command) {
      if (child?.stdin?.writable) child.stdin.write(`${command}
`)
    },
    stop() {
      stopped = true
      process.removeListener("exit", kill)
      kill()
    },
  }
}

const EIGHTHS = " ▁▂▃▄▅▆▇█"

function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")
}

function gradient(palette: RGB[], t: number): RGB {
  if (palette.length === 1) return palette[0]!
  const seg = Math.max(0, Math.min(1, t)) * (palette.length - 1)
  const i = Math.min(Math.floor(seg), palette.length - 2)
  const f = seg - i
  const a = palette[i]!
  const b = palette[i + 1]!
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

export interface Cell {
  ch: string
  fg: string
}

// Resamples the feed's fixed-size spectrum to `width` columns and renders it as
// `rows` rows of eighth-block cells, tinted along the album-art palette.
export function renderBars(bars: number[], palette: RGB[], width: number, rows: number): Cell[][] {
  const cols: number[] = []
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * bars.length) / width)
    const to = Math.max(from + 1, Math.floor(((x + 1) * bars.length) / width))
    let peak = 0
    for (let i = from; i < to && i < bars.length; i++) peak = Math.max(peak, bars[i] ?? 0)
    cols.push(peak * rows)
  }
  const colors = cols.map((_, x) => toHex(gradient(palette, x / Math.max(1, width - 1))))
  const out: Cell[][] = []
  for (let r = 0; r < rows; r++) {
    const fromBottom = rows - 1 - r
    out.push(
      cols.map((h, x) => {
        const level = h - fromBottom
        if (level <= 0) return { ch: " ", fg: colors[x]! }
        return { ch: EIGHTHS[Math.min(8, Math.max(1, Math.round(Math.min(level, 1) * 8)))]!, fg: colors[x]! }
      }),
    )
  }
  return out
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function clipText(text: string, width: number): string {
  if (width <= 0) return ""
  return text.length <= width ? text : width > 1 ? text.slice(0, width - 1) + "…" : text.slice(0, width)
}

export interface ProgressParts {
  icon: string
  played: string
  dot: string
  rest: string
  time: string
}

// Thin-line scrubber with a playhead dot, like the standalone visualizer.
export function progressParts(frame: VisualizerFrame, width: number): ProgressParts {
  const time = ` ${fmtTime(frame.position)}/${fmtTime(frame.duration)}`
  const icon = frame.playing ? "▶ " : "⏸ "
  const line = Math.max(4, width - time.length - 3) // 3 = the clickable icon box
  const ratio = frame.duration > 0 ? Math.min(1, frame.position / frame.duration) : 0
  const at = Math.min(line - 1, Math.round(ratio * (line - 1)))
  return { icon, played: "━".repeat(at), dot: "●", rest: "─".repeat(line - at - 1), time }
}

export { toHex }
