import { spawn } from "node:child_process"

const cache = new Map<string, Promise<string | undefined>>()

// Resolves a binary's absolute path via the shell's own lookup (`where` on
// Windows, `which` elsewhere) so we inherit the same PATH resolution rules
// (including PATHEXT) the user's shell would use. Memoized per process.
export function which(bin: string): Promise<string | undefined> {
  const cached = cache.get(bin)
  if (cached) return cached
  const result = new Promise<string | undefined>((resolve) => {
    const isWin = process.platform === "win32"
    const proc = spawn(isWin ? "where" : "which", [bin])
    let out = ""
    proc.stdout?.on("data", (chunk) => (out += chunk.toString()))
    proc.on("close", (code) => {
      if (code !== 0) return resolve(undefined)
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      resolve(first)
    })
    proc.on("error", () => resolve(undefined))
  })
  cache.set(bin, result)
  return result
}
