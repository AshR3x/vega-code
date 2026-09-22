const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length
}

export function centerLine(line: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2))
  return " ".repeat(pad) + line
}

export function centerBlock(lines: string[], width: number): string[] {
  return lines.map((line) => centerLine(line, width))
}

export function truncateWithEllipsis(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text
  if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth))
  return text.slice(0, maxWidth - 1) + "…"
}

// Collapse whitespace and cap the length so a single row stays on one line.
// The console REPL and the TUI both use this so scratchpad/output previews
// render identically.
export function truncateForDisplay(text: string, maxLength = 400): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}

export function terminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}
