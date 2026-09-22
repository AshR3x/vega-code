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
