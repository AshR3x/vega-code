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

// One-line, human-friendly rendering of a tool result. Web tool output is
// written for the model (tags, temp paths, outline), so summarize it instead of
// dumping the raw text into the scrollback.
export function summarizeToolResult(name: string, output: string): string {
  if (name === "webfetch") {
    const url = /<web_content url="([^"]+)"/.exec(output)?.[1]
    if (url) {
      let where = url
      try {
        const u = new URL(url)
        where = (u.hostname + u.pathname).replace(/\/$/, "")
      } catch {
        // keep the raw url
      }
      const title = /^Title: (.*?)(?: \| Site:| \| Lang:| \| HTTP|$)/m.exec(output)?.[1]
      const lines = /Saved (\d+) lines/.exec(output)?.[1]
      const query = /^Matches for "(.*)":$/m.exec(output)?.[1]
      const sections = (output.match(/^--- L/gm) ?? []).length
      const parts = [where]
      if (title) parts.push(`"${title}"`)
      if (lines) parts.push(`${lines} lines`)
      if (query) parts.push(sections > 0 ? `${sections} section${sections === 1 ? "" : "s"} matched "${query}"` : `no match for "${query}"`)
      if (/appears JS-rendered/.test(output)) parts.push("JS-rendered, likely incomplete")
      if (/\(cached\)/.test(output)) parts.push("cached")
      return truncateForDisplay(parts.join(" · "), 220)
    }
  }
  if (name === "websearch" && output.includes("<search_results")) {
    const titles = [...output.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!)
    if (titles.length > 0) return truncateForDisplay(`${titles.length} results · ${titles.slice(0, 3).join(" · ")}`, 220)
  }
  return truncateForDisplay(output)
}

export function terminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}
