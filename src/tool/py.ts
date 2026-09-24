import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const RESOLVE_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

type PythonRunnable = { cmd: string; pre: string[] }
let resolvedPython: PythonRunnable | undefined
const verified = new Set<string>()

async function resolvePython(): Promise<PythonRunnable> {
  if (resolvedPython) return resolvedPython
  const candidates: PythonRunnable[] = [
    { cmd: "python", pre: [] },
    { cmd: "python3", pre: [] },
    { cmd: "py", pre: ["-3"] },
  ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.cmd, [...candidate.pre, "-c", "print('OK')"], {
        timeout: RESOLVE_TIMEOUT_MS,
        windowsHide: true,
      })
      if (stdout.trim() === "OK") {
        resolvedPython = candidate
        return candidate
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("this tool requires Python 3 on PATH")
}

// Checked per package so a missing one only breaks the tool that needs it.
async function requirePackage(python: PythonRunnable, pkg: string): Promise<void> {
  if (verified.has(pkg)) return
  try {
    await execFileAsync(python.cmd, [...python.pre, "-c", `import ${pkg}`], { timeout: RESOLVE_TIMEOUT_MS, windowsHide: true })
    verified.add(pkg)
  } catch {
    throw new Error(`requires the Python package \`${pkg}\` (install with: pip install ${pkg})`)
  }
}

export interface RunPythonInput {
  script: string
  // Small JSON options blob, passed as argv[1]. Never interpolated into the script or a shell.
  options: unknown
  // Large payloads (e.g. HTML) go through stdin: the Windows command line caps at ~32 KB.
  stdin?: string | Uint8Array
  requires: string[]
  timeoutMs: number
  signal?: AbortSignal
}

export async function runPython(input: RunPythonInput): Promise<unknown> {
  const python = await resolvePython()
  for (const pkg of input.requires) await requirePackage(python, pkg)

  const { stdout, stderr, code, timedOut } = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>(
    (resolve, reject) => {
      const child = spawn(python.cmd, [...python.pre, "-c", input.script, JSON.stringify(input.options)], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      let timedOut = false
      const kill = () => child.kill()
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, input.timeoutMs)
      input.signal?.addEventListener("abort", kill, { once: true })
      child.stdout.on("data", (b: Buffer) => {
        size += b.length
        if (size > MAX_OUTPUT_BYTES) kill()
        else out.push(b)
      })
      child.stderr.on("data", (b: Buffer) => err.push(b))
      child.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", kill)
        resolve({ stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8"), code, timedOut })
      })
      child.stdin.on("error", () => {})
      child.stdin.end(input.stdin ?? "")
    },
  )

  if (input.signal?.aborted) throw new Error("aborted")
  if (timedOut) throw new Error("python helper timed out")
  if (code !== 0) {
    let detail = stderr.trim()
    try {
      const parsed = JSON.parse(detail) as { error?: string }
      if (parsed.error) detail = parsed.error
    } catch {
      // stderr wasn't JSON; use as-is
    }
    throw new Error(detail || `python helper exited with code ${code}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error("python helper returned unexpected output (not valid JSON)")
  }
}
