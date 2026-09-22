import { z } from "zod"
import { spawn } from "node:child_process"
import { defineTool } from "./types"
import { Truncate } from "@/util/truncate"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_OUTPUT_CHARS = 30_000

const Parameters = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().int().positive().optional().describe("Timeout in milliseconds (default 120000)"),
  workdir: z.string().optional().describe("Working directory for the command (defaults to the project directory)"),
})

function prefixPattern(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 2).join(" ")
  return `${first} *`
}

export const BashTool = defineTool({
  id: "bash",
  description: "Executes a shell command (PowerShell on Windows, sh elsewhere) and returns its output. Long-running or interactive commands should not be used.",
  parameters: Parameters,
  async execute(params, ctx) {
    await ctx.ask({
      permission: "bash",
      patterns: [params.command],
      always: [prefixPattern(params.command)],
      metadata: { command: params.command },
    })

    const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS
    const cwd = params.workdir ?? ctx.cwd

    const result = await new Promise<{ stdout: string; code: number | null; timedOut: boolean }>((resolve) => {
      const isWin = process.platform === "win32"
      const child = spawn(isWin ? "powershell.exe" : "sh", isWin ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", params.command] : ["-c", params.command], {
        cwd,
        env: process.env,
      })

      let out = ""
      let settled = false
      const finish = (code: number | null, timedOut = false) => {
        if (settled) return
        settled = true
        resolve({ stdout: out, code, timedOut })
      }

      child.stdout?.on("data", (chunk) => (out += chunk.toString()))
      child.stderr?.on("data", (chunk) => (out += chunk.toString()))
      child.on("close", (code) => finish(code))
      child.on("error", (err) => {
        out += `\n[spawn error: ${err.message}]`
        finish(1)
      })

      const timer = setTimeout(() => {
        child.kill()
        finish(null, true)
      }, timeout)
      child.on("close", () => clearTimeout(timer))

      ctx.abort.addEventListener("abort", () => {
        child.kill()
        finish(null)
      })
    })

    let output = result.stdout.length > MAX_OUTPUT_CHARS ? (await Truncate.output(result.stdout)).content : result.stdout
    if (!output.trim()) output = "(no output)"
    if (result.timedOut) output += `\n\n[command terminated after exceeding timeout of ${timeout}ms]`

    return {
      title: params.command,
      output,
      metadata: { exitCode: result.code },
    }
  },
})
