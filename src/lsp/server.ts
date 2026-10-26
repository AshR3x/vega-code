import path from "node:path"
import { existsSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { which } from "@/util/which"
import { languageIdFor } from "./language"

export interface Resolved {
  command: string
  args: string[]
}

export interface ServerDef {
  id: string
  extensions: string[]
  rootMarkers: string[]
  // Finds (or installs) the server binary. Memoized per server id so a
  // project touching 50 TypeScript files only triggers one install attempt.
  resolve(): Promise<Resolved | undefined>
}

const resolveCache = new Map<string, Promise<Resolved | undefined>>()

function once(id: string, fn: () => Promise<Resolved | undefined>): () => Promise<Resolved | undefined> {
  return () => {
    let cached = resolveCache.get(id)
    if (!cached) {
      cached = fn()
      resolveCache.set(id, cached)
    }
    return cached
  }
}

// npm-distributed servers: prefer an already-installed global binary, else
// fall back to `npx` which fetches-and-caches on first run (Bun's analogue
// of opencode's Npm.which-then-install dance, without us reimplementing npm
// resolution ourselves). Deliberately `npx`, not `bunx`: both
// typescript-language-server and pyright fork a second process internally
// (tsserver / pyright's own server) using plain Node child_process
// semantics, which crashes immediately under Bun's fork() — confirmed by
// testing both. `npx` needs Node on PATH, which is a safe assumption
// alongside npm-distributed tooling.
async function resolveTypescript(): Promise<Resolved | undefined> {
  const bin = await which("typescript-language-server")
  if (bin) return { command: bin, args: ["--stdio"] }
  return { command: "npx", args: ["--yes", "typescript-language-server", "--stdio"] }
}

async function resolvePyright(): Promise<Resolved | undefined> {
  const bin = await which("pyright-langserver")
  if (bin) return { command: bin, args: ["--stdio"] }
  return { command: "npx", args: ["--yes", "--package", "pyright", "pyright-langserver", "--stdio"] }
}

async function resolveGopls(): Promise<Resolved | undefined> {
  const existing = await which("gopls")
  if (existing) return { command: existing, args: [] }

  const go = await which("go")
  if (!go) return undefined

  await new Promise<void>((resolve) => {
    const proc = spawn(go, ["install", "golang.org/x/tools/gopls@latest"], { stdio: "ignore" })
    proc.on("close", () => resolve())
    proc.on("error", () => resolve())
  })

  const gopath = spawnSync(go, ["env", "GOPATH"]).stdout?.toString().trim()
  if (!gopath) return undefined
  const bin = path.join(gopath, "bin", process.platform === "win32" ? "gopls.exe" : "gopls")
  return existsSync(bin) ? { command: bin, args: [] } : undefined
}

export const SERVERS: ServerDef[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "package.json"],
    resolve: once("typescript", resolveTypescript),
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    resolve: once("python", resolvePyright),
  },
  {
    id: "go",
    extensions: [".go"],
    rootMarkers: ["go.mod"],
    resolve: once("go", resolveGopls),
  },
]

export function serversForExtension(ext: string): ServerDef[] {
  return SERVERS.filter((s) => s.extensions.includes(ext))
}

export { languageIdFor }
