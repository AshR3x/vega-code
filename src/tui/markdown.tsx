import { createMemo, For, Show, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { colors } from "@/tui/theme"

// A small, deliberately non-CommonMark-complete markdown renderer for model
// output in the TUI scrollback. Handles the subset LLMs actually produce:
// headings, fenced code, bullet/numbered lists, blockquotes, horizontal
// rules, pipe tables, and inline bold/italic/strikethrough/code/links.
// Anything fancier (nested lists, footnotes) just falls through as a plain
// paragraph instead of erroring — good enough beats exact.

type ListItem = { text: string; ordered: boolean; marker: string; indent: number }
type Align = "left" | "center" | "right"

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "paragraph"; text: string }

const FENCE_RE = /^```(\w*)\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/
const QUOTE_RE = /^>\s?/
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/
// A separator row like `| --- | :---: | ---: |` (alignment colons optional).
const TABLE_SEP_RE = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/

function splitTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|")) t = t.slice(0, -1)
  return t.split("|").map((cell) => cell.trim())
}

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    if (trimmed === "") {
      i++
      continue
    }

    const fence = FENCE_RE.exec(trimmed)
    if (fence) {
      const lang = fence[1] ?? ""
      const codeLines: string[] = []
      i++
      while (i < lines.length && lines[i]!.trim() !== "```") {
        codeLines.push(lines[i]!)
        i++
      }
      i++ // skip closing fence (or just stop at EOF while still streaming)
      blocks.push({ kind: "code", lang, lines: codeLines })
      continue
    }

    const heading = HEADING_RE.exec(trimmed)
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! })
      i++
      continue
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ kind: "hr" })
      i++
      continue
    }

    if (trimmed.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!.trim())) {
      const header = splitTableRow(raw)
      const align: Align[] = splitTableRow(lines[i + 1]!).map((cell) => {
        const left = cell.startsWith(":")
        const right = cell.endsWith(":")
        if (left && right) return "center"
        if (right) return "right"
        return "left"
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!))
        i++
      }
      blocks.push({ kind: "table", header, align, rows })
      continue
    }

    if (QUOTE_RE.test(trimmed)) {
      const quoteLines: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i]!.trim())) {
        quoteLines.push(lines[i]!.trim().replace(QUOTE_RE, ""))
        i++
      }
      blocks.push({ kind: "quote", lines: quoteLines })
      continue
    }

    if (LIST_RE.test(raw)) {
      const items: ListItem[] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!)
        if (!m) break
        const marker = m[2]!
        items.push({ text: m[3]!, ordered: /\d+\./.test(marker), marker, indent: Math.floor((m[1]?.length ?? 0) / 2) })
        i++
      }
      blocks.push({ kind: "list", items })
      continue
    }

    const paraLines: string[] = [raw]
    i++
    while (i < lines.length) {
      const t = lines[i]!.trim()
      const startsTable = t.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!.trim())
      if (t === "" || FENCE_RE.test(t) || HEADING_RE.test(t) || HR_RE.test(t) || QUOTE_RE.test(t) || LIST_RE.test(lines[i]!) || startsTable) break
      paraLines.push(lines[i]!)
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") })
  }

  return blocks
}

// `**bold**`/`__bold__`, `*italic*`/`_italic_`, `***both***`, `` `code` ``,
// `~~strike~~`, `[text](url)`. Deliberately excludes newlines from each
// marker's contents so an unmatched `*` mid-paragraph doesn't swallow the
// rest of the block.
const INLINE_RE =
  /(?<code>`[^`\n]+`)|(?<bolditalic>\*\*\*[^*\n]+\*\*\*)|(?<bold>\*\*[^*\n]+\*\*|__[^_\n]+__)|(?<italic>\*[^*\n]+\*|_[^_\n]+_)|(?<strike>~~[^~\n]+~~)|(?<link>\[[^\]\n]+\]\([^)\n]+\))/g

function renderInline(text: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = []
  let lastIndex = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > lastIndex) out.push(text.slice(lastIndex, m.index))
    const g = m.groups!
    if (g["code"]) {
      out.push(
        <span style={{ fg: colors.accent, bg: colors.codeBg }}>{g["code"]!.slice(1, -1)}</span>,
      )
    } else if (g["bolditalic"]) {
      out.push(<span style={{ bold: true, italic: true }}>{g["bolditalic"]!.slice(3, -3)}</span>)
    } else if (g["bold"]) {
      out.push(<span style={{ bold: true }}>{g["bold"]!.slice(2, -2)}</span>)
    } else if (g["italic"]) {
      out.push(<span style={{ italic: true }}>{g["italic"]!.slice(1, -1)}</span>)
    } else if (g["strike"]) {
      out.push(<span style={{ strikethrough: true }}>{g["strike"]!.slice(2, -2)}</span>)
    } else if (g["link"]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(g["link"]!)
      out.push(<span style={{ fg: colors.cyan, underline: true }}>{link ? link[1] : g["link"]}</span>)
    }
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex))
  return out
}

// Same marker-stripping as renderInline, but returns plain text — used to
// measure a cell's actual rendered width for table column alignment (the
// raw markdown source is longer than what ends up on screen).
function stripInlineMarkdown(text: string): string {
  let out = ""
  let lastIndex = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text))) {
    out += text.slice(lastIndex, m.index)
    const g = m.groups!
    if (g["code"]) out += g["code"]!.slice(1, -1)
    else if (g["bolditalic"]) out += g["bolditalic"]!.slice(3, -3)
    else if (g["bold"]) out += g["bold"]!.slice(2, -2)
    else if (g["italic"]) out += g["italic"]!.slice(1, -1)
    else if (g["strike"]) out += g["strike"]!.slice(2, -2)
    else if (g["link"]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(g["link"]!)
      out += link ? link[1] : g["link"]!
    }
    lastIndex = m.index + m[0].length
  }
  out += text.slice(lastIndex)
  return out
}

// Pads each cell to its column width (measured on the stripped text, since
// that's what actually ends up on screen) and joins with " │ " to line up
// with the "─┼─" the separator row below draws.
function renderTableRow(cells: string[], widths: number[], aligns: Align[], bold?: boolean): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = []
  for (let c = 0; c < widths.length; c++) {
    if (c > 0) out.push(" │ ")
    const raw = cells[c] ?? ""
    const stripped = stripInlineMarkdown(raw)
    const width = widths[c]!
    const align = aligns[c] ?? "left"
    const padTotal = Math.max(0, width - stripped.length)
    const padLeft = align === "right" ? padTotal : align === "center" ? Math.floor(padTotal / 2) : 0
    const padRight = padTotal - padLeft
    if (padLeft) out.push(" ".repeat(padLeft))
    out.push(bold ? <span style={{ bold: true }}>{stripped}</span> : renderInline(raw))
    if (padRight) out.push(" ".repeat(padRight))
  }
  return out
}

function TableBlock(props: { header: string[]; align: Align[]; rows: string[][] }) {
  const widths = createMemo(() => {
    const colCount = Math.max(props.header.length, props.align.length, ...props.rows.map((r) => r.length))
    const w: number[] = []
    for (let c = 0; c < colCount; c++) {
      let max = stripInlineMarkdown(props.header[c] ?? "").length
      for (const row of props.rows) max = Math.max(max, stripInlineMarkdown(row[c] ?? "").length)
      w.push(Math.max(max, 3))
    }
    return w
  })
  const aligns = createMemo(() => widths().map((_, c) => props.align[c] ?? "left"))
  const separator = createMemo(() => widths().map((w) => "─".repeat(w)).join("─┼─"))

  return (
    <box width="100%" flexDirection="column" border borderColor={colors.purpleDim} paddingX={1}>
      <text wrapMode="none" fg={colors.accent}>
        {renderTableRow(props.header, widths(), aligns(), true)}
      </text>
      <text wrapMode="none" fg={colors.purpleDim}>
        {separator()}
      </text>
      <For each={props.rows}>{(row) => <text wrapMode="none" fg={colors.white}>{renderTableRow(row, widths(), aligns())}</text>}</For>
    </box>
  )
}

function CodeBlock(props: { lang: string; lines: string[] }) {
  return (
    <box width="100%" flexDirection="column" border borderColor={colors.purpleDim} paddingX={1}>
      <Show when={props.lang}>
        <text wrapMode="none" fg={colors.gray}>
          {props.lang}
        </text>
      </Show>
      <For each={props.lines}>{(line) => <text width="100%" wrapMode="word" fg={colors.white}>{line}</text>}</For>
    </box>
  )
}

function ListBlock(props: { items: ListItem[] }) {
  return (
    <box width="100%" flexDirection="column">
      <For each={props.items}>
        {(item) => (
          <text width="100%" wrapMode="word" fg={colors.white}>
            <span style={{ fg: colors.purpleBright }}>
              {"  ".repeat(item.indent)}
              {item.ordered ? `${item.marker} ` : "• "}
            </span>
            {renderInline(item.text)}
          </text>
        )}
      </For>
    </box>
  )
}

function QuoteBlock(props: { lines: string[] }) {
  return (
    <box width="100%" flexDirection="column" border={["left"]} borderColor={colors.purpleDim} paddingLeft={1}>
      <For each={props.lines}>
        {(line) => (
          <text width="100%" wrapMode="word" fg={colors.gray} attributes={TextAttributes.ITALIC}>
            {renderInline(line)}
          </text>
        )}
      </For>
    </box>
  )
}

// `leading` is an optional inline prefix (e.g. the "agent › " row label) that
// gets folded into the first line of text instead of sitting on its own row,
// matching how plain (non-markdown) rows render their label.
export function MarkdownText(props: { text: string; baseColor?: string; leading?: JSX.Element }) {
  const blocks = createMemo(() => parseBlocks(props.text))
  const firstIsInline = createMemo(() => {
    const first = blocks()[0]
    return first?.kind === "paragraph" || first?.kind === "heading"
  })

  return (
    <box width="100%" flexDirection="column">
      <Show when={props.leading && !firstIsInline()}>
        <text wrapMode="none">{props.leading}</text>
      </Show>
      <For each={blocks()}>
        {(block, index) => {
          const leading = index() === 0 && firstIsInline() ? props.leading : undefined
          switch (block.kind) {
            case "code":
              return <CodeBlock lang={block.lang} lines={block.lines} />
            case "heading":
              return (
                <text
                  width="100%"
                  wrapMode="word"
                  fg={colors.accent}
                  attributes={block.level <= 2 ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.BOLD}
                >
                  {leading}
                  {renderInline(block.text)}
                </text>
              )
            case "hr":
              return <box width="100%" height={1} border={["top"]} borderColor={colors.purpleDim} />
            case "quote":
              return <QuoteBlock lines={block.lines} />
            case "list":
              return <ListBlock items={block.items} />
            case "table":
              return <TableBlock header={block.header} align={block.align} rows={block.rows} />
            default:
              return (
                <text width="100%" wrapMode="word" fg={props.baseColor ?? colors.white}>
                  {leading}
                  {renderInline(block.text)}
                </text>
              )
          }
        }}
      </For>
    </box>
  )
}
