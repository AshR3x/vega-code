import { spawn } from "node:child_process"

export interface OllamaListError extends Error {
  code: "NOT_INSTALLED" | "NOT_RUNNING" | "EMPTY"
}

function makeError(code: OllamaListError["code"], message: string): OllamaListError {
  const err = new Error(message) as OllamaListError
  err.code = code
  return err
}

// Runs `ollama list` and parses its table output into model names. The first
// column is the name (e.g. "llama3.1:8b"); columns are separated by 2+ spaces.
export async function listOllamaModels(): Promise<string[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ollama", ["list"], { env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(makeError("NOT_INSTALLED", "The `ollama` CLI was not found on PATH. Install it from https://ollama.com."))
        return
      }
      reject(err)
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(makeError("NOT_RUNNING", stderr.trim() || `ollama list exited with code ${code}`))
        return
      }
      resolve(stdout)
    })
  })

  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  // First line is the header ("NAME  ID  SIZE  MODIFIED"); drop it.
  const rows = lines.slice(1)
  const names = rows.map((line) => line.split(/\s{2,}/)[0]!.trim()).filter(Boolean)

  if (names.length === 0) {
    throw makeError("EMPTY", "No local Ollama models found. Pull one first, e.g. `ollama pull llama3.1`.")
  }

  return names
}

// A Modelfile can pin the runtime window with `num_ctx`; it shows up as a bare
// "num_ctx <n>" line in /api/show's `parameters` blob.
function parseNumCtx(parameters: string | undefined): number | undefined {
  const match = parameters?.match(/^\s*num_ctx\s+(\d+)\s*$/m)
  return match ? Number(match[1]) : undefined
}

// Otherwise the model's trained maximum is reported under a per-architecture
// key like "qwen35.context_length" (or "llama.context_length", ...).
function parseContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

// Cache keyed by host+model so a long session doesn't re-hit /api/show every
// turn (loadConfig runs once per turn). Cleared only on process restart.
const contextLengthCache = new Map<string, number | undefined>()

// Reads a model's context window from Ollama's /api/show. Prefers an explicit
// Modelfile `num_ctx` (the window Ollama actually allocates) and falls back to
// the model's reported max context. Returns undefined when the host is
// unreachable or the model is unknown, so callers keep their own default.
export async function ollamaContextLength(model: string, host: string): Promise<number | undefined> {
  const key = `${host}|${model}`
  if (contextLengthCache.has(key)) return contextLengthCache.get(key)

  let result: number | undefined
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const info = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown> }
      result = parseNumCtx(info.parameters) ?? parseContextLength(info.model_info)
    }
  } catch {
    // Host down / not running — leave undefined and let the caller fall back.
  }

  contextLengthCache.set(key, result)
  return result
}

