import { z } from "zod"
import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { defineTool } from "./types"
import { Patch, type Hunk } from "@/util/patch"
import { Lsp } from "@/lsp/lsp"

const Parameters = z.object({
  patchText: z.string().describe("The full patch text describing add, update, and delete operations"),
  reason: z.string().describe("Brief, one-line explanation of why this patch is needed, shown to the user in the approval prompt"),
})

const DESCRIPTION = [
  "Use the `patch` tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:",
  "",
  "*** Begin Patch",
  "[ one or more file sections ]",
  "*** End Patch",
  "",
  "Each operation starts with one of three headers:",
  "",
  "*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).",
  "*** Delete File: <path> - remove an existing file. Nothing follows.",
  "*** Update File: <path> - patch an existing file in place (optionally with a *** Move to: <path> rename).",
  "",
  "Updates use @@ context markers with leading ' ' (context), '-' (removed), and '+' (added) lines.",
].join("\n")

interface Prepared {
  type: "add" | "delete" | "update"
  label: string
  target: string
  content: string
  moveTarget?: string
}

export const PatchTool = defineTool({
  id: "patch",
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    if (!params.patchText) throw new Error("patchText is required")

    let hunks: Hunk[]
    try {
      hunks = Patch.parse(params.patchText)
    } catch (err) {
      throw new Error(`patch verification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (hunks.length === 0) throw new Error("patch rejected: empty patch")

    const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p))

    // Build the list of changes first so a bad hunk fails before anything is
    // written, and gather every touched path for a single approval.
    const prepared: Prepared[] = []
    const updates = new Map<string, string>()
    for (const hunk of hunks) {
      const target = resolve(hunk.path)
      const label = path.relative(ctx.cwd, target) || hunk.path
      if (hunk.type === "add") {
        prepared.push({ type: "add", label, target, content: hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n` })
        continue
      }
      if (hunk.type === "delete") {
        prepared.push({ type: "delete", label, target, content: "" })
        continue
      }
      const original = updates.get(target) ?? (await readFile(target, "utf-8").catch(() => {
        throw new Error(`patch verification failed: Failed to read file to update ${label}`)
      }))
      let update
      try {
        update = Patch.derive(hunk.path, hunk.chunks, original)
      } catch (err) {
        throw new Error(`patch verification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      const content = Patch.joinBom(update.content, update.bom)
      if (!hunk.movePath) updates.set(target, content)
      prepared.push({
        type: "update",
        label: hunk.movePath ? path.relative(ctx.cwd, resolve(hunk.movePath)) || hunk.movePath : label,
        target,
        content,
        moveTarget: hunk.movePath ? resolve(hunk.movePath) : undefined,
      })
    }

    const paths = [...new Set(prepared.flatMap((p) => [p.target, ...(p.moveTarget ? [p.moveTarget] : [])]))]
    await ctx.ask({
      permission: "edit",
      patterns: paths,
      always: [...new Set(paths.map((p) => path.dirname(p) + "/*"))],
      metadata: { reason: params.reason },
    })

    const applied: string[] = []
    for (const change of prepared) {
      if (change.type === "delete") {
        await rm(change.target, { force: true })
        applied.push(`D ${change.label}`)
        continue
      }
      const dest = change.moveTarget ?? change.target
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, change.content, "utf-8")
      if (change.moveTarget) await rm(change.target, { force: true })
      applied.push(`${change.type === "add" ? "A" : "M"} ${change.label}`)
    }

    // Warm the language server for the files we touched so a follow-up edit or
    // hover is fast; diagnostics are intentionally not folded into the output.
    for (const change of prepared) {
      const dest = change.moveTarget ?? change.target
      if (change.type !== "delete") await Lsp.touchFile(dest, ctx.cwd).catch(() => "")
    }

    return {
      title: `${prepared.length} file(s)`,
      output: ["Success. Updated the following files:", ...applied].join("\n"),
      metadata: { files: applied.length },
    }
  },
})
