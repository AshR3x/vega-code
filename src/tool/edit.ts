import { z } from "zod"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { defineTool } from "./types"
import { Lsp } from "@/lsp/lsp"
import { Bom } from "@/util/bom"

const Parameters = z.object({
  filePath: z.string().describe("The absolute or relative path to the file to edit"),
  oldString: z.string().describe("The exact text to find and replace. Line breaks are written as \\n; the file's existing CRLF or LF endings are matched and preserved."),
  newString: z.string().describe("The text to replace oldString with (must differ from oldString)"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences instead of requiring exactly one match"),
  reason: z.string().describe("Brief, one-line explanation of why this edit is needed, shown to the user in the approval prompt"),
})

// ---------------------------------------------------------------------------
// Matching, ported 1:1 from opencode's edit tool. The oldString the model
// sends is matched against the LF "view" of the file (Read shows LF), then
// offsets are mapped back to the real bytes so CRLF/mixed endings neither
// block a match nor leak into untouched regions. If there is no exact match it
// retries ignoring typographic quote/dash/space variants, then per-line
// trailing whitespace.
// ---------------------------------------------------------------------------

const crlf = "\r\n"

interface Match {
  readonly start: number
  readonly end: number
}

const normalizeForMatch = (value: string) =>
  value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

function findOccurrences(content: string, search: string): Match[] {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

function findLineOccurrences(content: string, search: string): Match[] {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (!actual.every((item, lineIndex) => normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex]!.trimEnd())))
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

/** The dominant line ending in text, or fallback when there is none. */
function lineEnding(text: string, fallback: string): string {
  const crlfCount = text.split(crlf).length - 1
  const lfCount = text.split("\n").length - 1 - crlfCount
  if (crlfCount === lfCount) return fallback
  return crlfCount > lfCount ? crlf : "\n"
}

/**
 * Joins the replacement's lines with line endings taken from the matched source
 * region. A replacement line that keeps a region line (LCS, compared like the
 * trailing-whitespace tier) reuses that line's ending; a line that changes in
 * place reuses the ending of the line it replaces; only lines beyond those take
 * `fallback`. Unchanged context inside a match therefore keeps its bytes even
 * in a mixed-ending file.
 */
function withRegionEndings(region: string, replacement: string, fallback: string): string {
  const before = region.split(/\r?\n/)
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0])
  const after = replacement.split("\n")
  const key = (line: string) => normalizeForMatch(line.trimEnd())
  const source = alignLines(before.map(key), after.map(key))
  return after.map((line, index) => (index === after.length - 1 ? line : line + (endings[source[index]!] ?? fallback))).join("")
}

function alignLines(before: string[], after: string[]): (number | undefined)[] {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] = before[i] === after[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const result: (number | undefined)[] = []
  const gap = { before: [] as number[], after: [] as number[] }
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]))
    gap.before = []
    gap.after = []
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result[j++] = i++
      continue
    }
    if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) gap.before.push(i++)
    else gap.after.push(j++)
  }
  while (i < before.length) gap.before.push(i++)
  while (j < after.length) gap.after.push(j++)
  flush()
  return result
}

function matchView(source: string, oldString: string, newString: string): { matches: Match[]; replace: (match: Match) => string } {
  const view = source.replaceAll(crlf, "\n")
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index)
  const fileEnding = lineEnding(source, "\n")
  const search = oldString.replaceAll(crlf, "\n")
  const replacement = newString.replaceAll(crlf, "\n")
  const exact = findOccurrences(view, search)
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search)
  return {
    matches: (exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing).map((match) => ({
      start: match.start + countBefore(removed, match.start),
      end: match.end + countBefore(removed, match.end),
    })),
    replace: (match: Match) => {
      const region = source.slice(match.start, match.end)
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding))
    },
  }
}

/** Number of sorted positions strictly before offset. */
function countBefore(positions: number[], offset: number): number {
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (positions[middle]! < offset) low = middle + 1
    else high = middle
  }
  return low
}

export const EditTool = defineTool({
  id: "edit",
  description:
    "Edit a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation and omit the line-number prefix. Write line breaks as \\n; the file's existing CRLF or LF endings are matched and preserved. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. By default oldString must match exactly once; multiple matches fail unless replaceAll is true.",
  parameters: Parameters,
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(ctx.cwd, params.filePath)
    const title = path.relative(ctx.cwd, filepath)

    await ctx.ask({ permission: "edit", patterns: [filepath], always: [path.dirname(filepath) + "/*"], metadata: { reason: params.reason } })

    if (params.oldString === params.newString) throw new Error("No changes to apply: oldString and newString are identical.")
    if (params.oldString === "") throw new Error("oldString must not be empty. Use write to create or overwrite a file.")

    const raw = await readFile(filepath, "utf-8").catch(() => {
      throw new Error(`File not found: ${filepath}`)
    })
    const original = Bom.split(raw)
    const source = original.text

    // Strings that differ only in \r ask to change line endings themselves, so
    // they apply to the exact bytes. Every other edit matches the LF view.
    const endingsOnly = params.oldString.replaceAll("\r", "") === params.newString.replaceAll("\r", "")
    const { matches, replace } = endingsOnly
      ? { matches: findOccurrences(source, params.oldString), replace: () => params.newString }
      : matchView(source, params.oldString, params.newString)

    const replacements = matches.length
    const replaced = (params.replaceAll === true ? matches : matches.slice(0, 1))
      .slice()
      .reverse()
      .reduce((content, match) => `${content.slice(0, match.start)}${replace(match)}${content.slice(match.end)}`, source)

    if (replacements === 0) {
      throw new Error(`Could not find oldString in ${filepath}. It must match exactly, including whitespace and indentation.`)
    }
    if (replacements > 1 && params.replaceAll !== true) {
      throw new Error(`Found ${replacements} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true.`)
    }
    if (replaced === source) {
      throw new Error(
        endingsOnly
          ? `No changes to apply: ${filepath} already has those line endings.`
          : `No changes to apply: the edit leaves ${filepath} unchanged.`,
      )
    }

    const replacementBom = replaced.startsWith("\uFEFF")
    await writeFile(filepath, Bom.join(replaced, original.bom || replacementBom), "utf-8")

    const diagnostics = await Lsp.touchFile(filepath, ctx.cwd).catch(() => "")
    const output = `Edited ${filepath} (${replacements} replacement${replacements === 1 ? "" : "s"})` + (diagnostics ? `\n\n${diagnostics}` : "")

    return {
      title,
      output,
      metadata: { replacements },
    }
  },
})
