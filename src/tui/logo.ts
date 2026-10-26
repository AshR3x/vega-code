import { colors, theme } from "./theme"

// The vega-code brand mark (from docs/vega-code.txt). Each line is one row of
// a contiguous ASCII-art wordmark. The columns up to SPLIT are the "vega"
// half and the remainder the "code" half, so the two words keep their own
// accent colors; the left half keeps its trailing spaces so the inter-word
// gap in the source art is preserved.
const LOGO_LINES = [
  " _    __                    ______          __   ",
  "| |  / /__  ____ _____ _   / ____/___  ____/ /__ ",
  "| | / / _ \\/ __ `/ __ `/  / /   / __ \\/ __  / _ \\",
  "| |/ /  __/ /_/ / /_/ /  / /___/ /_/ / /_/ /  __/",
  "|___/\\___/\\__, /\\__,_/   \\____/\\____/\\__,_/\\___/ ",
  "         /____/                                  ",
] as const

const SPLIT = 25

export function renderLogo(): string[] {
  return LOGO_LINES.map((line) => {
    const left = line.slice(0, SPLIT)
    const right = line.slice(SPLIT)
    if (!right.trim()) return theme.purpleDim(left)
    return theme.purpleDim(left) + theme.purpleBright(right)
  })
}

// The TUI draws the logo as adjacent colored spans inside one text line per
// row: the "vega" half in the dim tone, the "code" half in the bright one.
// Both halves keep their original whitespace byte-for-byte — the boundary
// column is a space on every row, so slicing there never nicks a glyph.
export interface LogoRow {
  left: string
  leftColor: string
  right: string
  rightColor: string
}

export function logoRows(): LogoRow[] {
  return LOGO_LINES.map((line) => ({
    left: line.slice(0, SPLIT),
    leftColor: colors.purpleDim,
    right: line.slice(SPLIT),
    rightColor: colors.purpleBright,
  }))
}

// The prompt box: a `border={["left"]}` box, content padded 2 cells from the
// bar. Row order inside: blank (paddingTop), the input/placeholder line, a
// blank gap, then the agent/model status line (paddingTop before it) — then
// the box closes with a 1-row cap whose bottom-left corner is overridden to
// "╹" instead of a normal corner (customBorderChars:
// `{ ...SplitBorder.customBorderChars, bottomLeft: "╹" }`), drawn by a
// sibling box.
//
// Width is NOT constant across the app — the layout changes after the first
// prompt, and this is deliberate, not a bug:
//   - Before any message is sent (the home splash): fixed 75 columns.
//   - Once a session is active: no max width at all — `width="100%"` inside
//     a container with `paddingLeft={2} paddingRight={2}`, so it expands to
//     fill nearly the full terminal width, not a narrow centered box.
const MIN_SESSION_BOX_WIDTH = 40

export function promptBoxWidth(sessionActive: boolean, terminalWidth: number): number {
  if (!sessionActive) return 75
  return Math.max(MIN_SESSION_BOX_WIDTH, terminalWidth - 4)
}

// Usable width for a single line of text content inside the box: box width
// minus the 1-col left border and the 2-col paddingLeft/paddingRight.
// Plain-text lines don't wrap, so callers should truncate to this instead of
// overflowing past the box's right edge (e.g. a long provider/model string
// in the status line).
export function promptBoxTextWidth(sessionActive: boolean, terminalWidth: number): number {
  return promptBoxWidth(sessionActive, terminalWidth) - 1 - 2 - 2
}

export interface PromptFrame {
  top: string[]
  // Use this as the actual readline prompt string, so the user's typed
  // input lands inline with the bar — this is what makes the box persist
  // through actual typing instead of being a one-time splash.
  inputPrefix: string
  bottom: string[]
}

// The prompt box isn't a home-screen-only splash — it's rendered on every
// turn, pinned at the bottom of the screen (a scrollbox with flexGrow=1
// above for history, this box flexShrink=0 fixed below it). A one-time
// splash box with a bare `agent > ` prompt for every turn after it is
// exactly the "leaks out of the box" gap — this redraws the same
// bar/status/cap frame around every single input.
export function renderPromptFrame(input: {
  status: string
  hint: string
  agentColor: (s: string) => string
  terminalWidth: number
  sessionActive: boolean
}): PromptFrame {
  const boxWidth = promptBoxWidth(input.sessionActive, input.terminalWidth)
  const indent = " ".repeat(Math.max(0, Math.floor((input.terminalWidth - boxWidth) / 2)))
  // U+2503 HEAVY VERTICAL bar glyph for the left border, not the light
  // │ (U+2502).
  const bar = input.agentColor("┃")

  return {
    top: [indent + bar],
    inputPrefix: indent + bar + "  ",
    bottom: [
      indent + bar,
      indent + bar + "  " + input.status,
      indent + input.agentColor("╹" + "▀".repeat(Math.max(0, boxWidth - 1))),
      indent + input.hint,
    ],
  }
}

// Rows the frame occupies once rendered — top(1) + the input row itself(1,
// printed by the live `ask()` call between top and bottom, not part of
// either array) + bottom(4: blank, status, cap, hint) — used by the
// one-time startup splash to size its vertical centering without actually
// printing a duplicate decorative copy of the box. Previously missed the
// input row, which under-sized the leading spacer by one row.
export const PROMPT_FRAME_HEIGHT = 6
