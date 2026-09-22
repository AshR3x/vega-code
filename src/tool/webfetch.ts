import { z } from "zod"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { defineTool } from "./types"

const PREVIEW_CHARS = 1500

const Parameters = z.object({
  url: z.string().url().describe("The URL to fetch"),
})

// Strips HTML to a plain-text file whose LINE BREAKS line up with content
// rows (block elements become newlines), so the model can then `grep` that
// temp file to locate the relevant section and `read` a tight line range
// instead of ingesting the whole page. This is the whole point of the
// save-to-temp design: `grep`/`read` can only target lines that exist.
function htmlToText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Block boundaries -> line breaks (before tag stripping, so the opening
    // and closing tags don't get glued to neighbouring inline content).
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote|pre|section|article|aside|header|footer|form|fieldset|figure|figcaption)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")

  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

export const WebFetchTool = defineTool({
  id: "webfetch",
  description:
    "Fetches a URL and saves its stripped text to a temp file, returning the file path plus a short preview and line count. " +
    "For large pages, do NOT read the whole thing — use grep on that file to find the relevant lines, then read the file with offset/limit to pull just that range.",
  parameters: Parameters,
  async execute(params, ctx) {
    await ctx.ask({ permission: "webfetch", patterns: [new URL(params.url).hostname], always: [new URL(params.url).hostname] })

    const res = await fetch(params.url, { signal: ctx.abort })
    const contentType = res.headers.get("content-type") ?? ""
    const raw = await res.text()
    const text = contentType.includes("html") ? htmlToText(raw) : raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n")
    const lines = text.split("\n")

    const dir = path.join(os.tmpdir(), "vega-sessions", ctx.sessionID)
    const file = path.join(dir, `${createHash("sha1").update(params.url).digest("hex").slice(0, 16)}.txt`)
    await mkdir(dir, { recursive: true })
    await writeFile(file, text, "utf-8")

    const preview = lines.slice(0, 30).join("\n").slice(0, PREVIEW_CHARS)
    const previewNote = lines.length > 30 ? `... (${lines.length - 30} more lines)` : ""

    return {
      title: params.url,
      output: `Saved ${lines.length} lines to ${file}.\n\n<preview>\n${preview}${previewNote}\n</preview>`,
      metadata: { path: file, lines: lines.length, status: res.status, contentType },
    }
  },
})