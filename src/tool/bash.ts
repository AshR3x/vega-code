import { z } from "zod"
import path from "node:path"
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { defineTool } from "./types"
import { Truncate } from "@/util/truncate"
import { Paths } from "@/config"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_OUTPUT_CHARS = 30_000

const Parameters = z.object({
  command: z.string().describe("The shell command to execute"),
  reason: z.string().describe("Brief, one-line explanation of why this command is needed, shown to the user in the approval prompt"),
  timeout: z.number().int().nonnegative().optional().describe("Timeout in milliseconds; 0 disables the timeout (default 120000). Background commands have no timeout."),
  workdir: z.string().optional().describe("Working directory for the command (defaults to the project directory)"),
  background: z.boolean().optional().describe("Run in the background and return immediately; output streams to a file. Use for dev servers and long builds. Do not poll for completion."),
})

function prefixPattern(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 2).join(" ")
  return `${first} *`
}

function shellFor(command: string) {
  const isWin = process.platform === "win32"
  return isWin ? { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] } : { file: "sh", args: ["-c", command] }
}

export const BashTool = defineTool({
  id: "bash",
  description:
    "Executes a shell command (PowerShell on Windows, sh elsewhere) and returns its output. Prefer dedicated tools over shell commands when possible. Set background=true for long-running commands; do not poll their output file.",
  parameters: Parameters,
  async execute(params, ctx) {
    await ctx.ask({
      permission: "bash",
      patterns: [params.command],
      always: [prefixPattern(params.command)],
      metadata: { reason: params.reason, command: params.command },
    })

    const cwd = params.workdir ?? ctx.cwd
    const { file, args } = shellFor(params.command)

    if (params.background) {
      await mkdir(Paths.tmp, { recursive: true })
      const logFile = path.join(Paths.tmp, `shell-${Date.now()}.log`)
      const stream = createWriteStream(logFile)
      const child = spawn(file, args, { cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      child.stdout?.pipe(stream)
      child.stderr?.pipe(stream)
      child.unref()
      return {
        title: params.command,
        output: [
          `Command started in the background (pid ${child.pid ?? "?"}).`,
          `Output is streaming to: ${logFile}`,
          "Read that file for output when you need it; do not poll it in a tight loop.",
        ].join("\n"),
        metadata: { background: true, pid: child.pid, logFile },
      }
    }

    const timeout = params.timeout === undefined ? DEFAULT_TIMEOUT_MS : params.timeout

    const result = await new Promise<{ stdout: string; code: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(file, args, { cwd, env: process.env })

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

      if (timeout > 0) {
        const timer = setTimeout(() => {
          child.kill()
          finish(null, true)
        }, timeout)
        child.on("close", () => clearTimeout(timer))
      }

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
