import { theme, fromRgb } from "./theme"
import { renderLogo, renderPromptFrame, promptBoxWidth, promptBoxTextWidth } from "./logo"
import { visibleWidth, centerBlock, truncateWithEllipsis } from "./layout"
import { AGENTS } from "../agent"

// A non-interactive, no-network diagnostic dump of every layout primitive —
// exists because we can't see a real TTY from this environment while
// building this. Run with `bun run src/index.ts --test`. Prints rulers and
// exact computed widths/indents next to the actual rendered output, and the
// raw escaped strings, so a mismatch is verifiable by eye or by grep instead
// of by guessing at what a screenshot would look like.

function ruler(width: number): string {
  const tens = Array.from({ length: Math.ceil(width / 10) }, (_, i) => String(i).padEnd(10, " ")).join("").slice(0, width)
  const ones = "0123456789".repeat(Math.ceil(width / 10)).slice(0, width)
  return theme.dim(tens) + "\n" + theme.dim(ones)
}

function labeled(label: string) {
  console.log()
  console.log(theme.bold(theme.purple(`── ${label} `)) + theme.dim("─".repeat(Math.max(0, 60 - label.length))))
}

function dumpLines(lines: string[], width: number) {
  console.log(ruler(width))
  for (const line of lines) {
    const w = visibleWidth(line)
    console.log(line + theme.dim(`  [${w}w]`))
  }
}

function rawEscaped(line: string) {
  console.log(theme.dim("raw: ") + JSON.stringify(line))
}

export function runLayoutDebug(terminalWidthOverride?: number): void {
  const columns = terminalWidthOverride ?? process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24

  console.log(theme.bold("VEGA-CODE LAYOUT DEBUG"))
  console.log(theme.dim(`detected terminal: ${columns}x${rows}${terminalWidthOverride ? " (overridden width)" : ""}`))
  console.log(theme.dim(`stdout.isTTY: ${Boolean(process.stdout.isTTY)}  colorEnabled depends on TTY + NO_COLOR + TERM`))

  labeled("Logo")
  const logoLines = renderLogo()
  dumpLines(centerBlock(logoLines, columns), columns)
  console.log(theme.dim(`natural width (uncentered): ${visibleWidth(logoLines[0] ?? "")}`))

  for (const agentKey of ["build", "plan"] as const) {
    const agent = AGENTS[agentKey]!
    const agentColor = fromRgb(...agent.color)

    for (const sessionActive of [false, true]) {
      labeled(`Prompt box — agent=${agent.name} sessionActive=${sessionActive}`)
      const boxWidth = promptBoxWidth(sessionActive, columns)
      const textWidth = promptBoxTextWidth(sessionActive, columns)
      console.log(theme.dim(`boxWidth=${boxWidth} textWidth=${textWidth} indent=${Math.max(0, Math.floor((columns - boxWidth) / 2))}`))

      const longStatus = `${agent.name}  anthropic/claude-opus-4-5-this-is-a-deliberately-long-model-id-to-test-truncation`
      const status = truncateWithEllipsis(longStatus, textWidth)
      const hint = truncateWithEllipsis("/help commands   /models models   /agent agents", boxWidth)

      const frame = renderPromptFrame({ status, hint, agentColor, terminalWidth: columns, sessionActive })

      dumpLines(frame.top, columns)
      console.log(agentColor(frame.inputPrefix) + theme.dim("<cursor here>") + theme.dim(`  [prefix ${visibleWidth(frame.inputPrefix)}w]`))
      rawEscaped(frame.inputPrefix)
      dumpLines(frame.bottom, columns)

      const capRow = frame.bottom[frame.bottom.length - 2] ?? ""
      const capWidth = visibleWidth(capRow)
      console.log(theme.dim(`cap row width: ${capWidth} (expect indent + boxWidth = ${Math.max(0, Math.floor((columns - boxWidth) / 2)) + boxWidth})`))
    }
  }

  labeled("Truncation edge cases")
  const cases = [
    { text: "short", max: 20 },
    { text: "exactly-twenty-chars", max: 20 },
    { text: "this is definitely longer than the budget allows", max: 20 },
    { text: "x", max: 0 },
  ]
  for (const c of cases) {
    const result = truncateWithEllipsis(c.text, c.max)
    console.log(`truncateWithEllipsis(${JSON.stringify(c.text)}, ${c.max}) = ${JSON.stringify(result)}  [${visibleWidth(result)}w]`)
  }

  labeled("Session-box width scaling (home=fixed 75, session=terminalWidth-4)")
  console.log(theme.dim("width  | home box | session box"))
  for (const w of [80, 100, 120, 160, 200]) {
    const home = promptBoxWidth(false, w)
    const active = promptBoxWidth(true, w)
    console.log(`${String(w).padEnd(6)} | ${String(home).padEnd(8)} | ${active}`)
  }

  console.log()
  console.log(theme.bold("Done. No network calls were made; this never touches a real provider or session."))
}
