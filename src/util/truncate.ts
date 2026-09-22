import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { Paths } from "@/config"

const MAX_CHARS = 20_000
const HEAD_CHARS = 4_000

let counter = 0

export interface TruncateResult {
  content: string
  truncated: boolean
  outputPath?: string
}

export async function output(text: string): Promise<TruncateResult> {
  if (text.length <= MAX_CHARS) return { content: text, truncated: false }

  await mkdir(Paths.tmp, { recursive: true })
  const file = path.join(Paths.tmp, `output-${Date.now()}-${counter++}.txt`)
  await writeFile(file, text, "utf-8")

  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-HEAD_CHARS)
  const content = [
    head,
    ``,
    `... (truncated ${text.length - HEAD_CHARS * 2} chars; full output saved to ${file}) ...`,
    ``,
    tail,
  ].join("\n")

  return { content, truncated: true, outputPath: file }
}

export const Truncate = { output }
