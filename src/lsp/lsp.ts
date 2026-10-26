import path from "node:path"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { pathToFileURL, fileURLToPath } from "node:url"
import { serversForExtension, languageIdFor, type ServerDef } from "./server"
import { LspClient, type Diagnostic, type Location } from "./client"

interface ClientEntry {
  client: LspClient
  root: string
}

const clients = new Map<string, Promise<ClientEntry | undefined>>() // key: `${serverID}:${root}`
const broken = new Set<string>()
// Tracked outside the async `clients` map so the synchronous 'exit' handler
// below can kill them even mid-spawn (a Promise resolving after the process
// has already exited can't run cleanup — plain process handles can).
const liveProcesses = new Set<ChildProcessWithoutNullStreams>()

function findRoot(file: string, markers: string[], cwd: string): string {
  let dir = path.dirname(file)
  while (true) {
    if (markers.some((m) => existsSync(path.join(dir, m)))) return dir
    if (dir === cwd) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cwd
}

async function getClient(file: string, server: ServerDef, cwd: string): Promise<ClientEntry | undefined> {
  const root = findRoot(file, server.rootMarkers, cwd)
  const key = `${server.id}:${root}`
  if (broken.has(key)) return undefined

  let entry = clients.get(key)
  if (entry) return entry

  entry = (async () => {
    const resolved = await server.resolve()
    if (!resolved) {
      broken.add(key)
      return undefined
    }
    let proc
    try {
      proc = spawn(resolved.command, resolved.args, { cwd: root })
    } catch {
      broken.add(key)
      return undefined
    }
    liveProcesses.add(proc)
    const client = new LspClient(server.id, proc)
    proc.on("exit", () => {
      clients.delete(key)
      liveProcesses.delete(proc)
    })
    proc.on("error", () => {
      broken.add(key)
      clients.delete(key)
      liveProcesses.delete(proc)
    })
    try {
      await client.initialize(root)
    } catch {
      broken.add(key)
      client.dispose()
      return undefined
    }
    return { client, root }
  })()
  clients.set(key, entry)
  return entry
}

function severityLabel(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error"
    case 2:
      return "warning"
    case 3:
      return "info"
    default:
      return "hint"
  }
}

function formatDiagnostics(filepath: string, diagnostics: Diagnostic[]): string {
  const lines = diagnostics
    .slice(0, 20)
    .map((d) => {
      const line = d.range.start.line + 1
      const col = d.range.start.character + 1
      const source = d.source ? ` (${d.source})` : ""
      return `${severityLabel(d.severity)} [${line}:${col}] ${d.message}${source}`
    })
    .join("\n")
  const more = diagnostics.length > 20 ? `\n... and ${diagnostics.length - 20} more` : ""
  return `<diagnostics file="${filepath}">\n${lines}${more}\n</diagnostics>`
}

// Opens/updates `filepath` in every language server that claims its
// extension and reports back any error/warning diagnostics. Spawns (and, if
// missing, downloads/installs) a server on first touch per project root;
// subsequent touches reuse the running client. Best-effort: swallows errors
// from servers that fail to install or crash, since diagnostics are a nice-
// to-have, not a tool-blocking requirement.
export async function touchFile(filepath: string, cwd: string): Promise<string> {
  const ext = path.extname(filepath)
  const servers = serversForExtension(ext)
  if (servers.length === 0) return ""

  const text = await readFile(filepath, "utf-8").catch(() => undefined)
  if (text === undefined) return ""
  const uri = pathToFileURL(filepath).toString()
  const languageId = languageIdFor(ext) ?? ext.slice(1)

  const reports: string[] = []
  for (const server of servers) {
    try {
      const entry = await getClient(filepath, server, cwd)
      if (!entry) continue
      entry.client.open(uri, languageId, text)
      const diagnostics = await entry.client.waitForDiagnostics(uri)
      const relevant = diagnostics.filter((d) => (d.severity ?? 1) <= 2)
      if (relevant.length > 0) reports.push(formatDiagnostics(filepath, relevant))
    } catch {
      // best-effort — a broken/uninstallable server shouldn't fail the tool call
    }
  }
  return reports.join("\n\n")
}

async function ensureOpen(filepath: string, cwd: string): Promise<{ entry: ClientEntry; uri: string } | undefined> {
  const ext = path.extname(filepath)
  const server = serversForExtension(ext)[0]
  if (!server) return undefined
  const entry = await getClient(filepath, server, cwd)
  if (!entry) return undefined
  const text = await readFile(filepath, "utf-8").catch(() => undefined)
  if (text === undefined) return undefined
  const uri = pathToFileURL(filepath).toString()
  entry.client.open(uri, languageIdFor(ext) ?? ext.slice(1), text)
  return { entry, uri }
}

function stringifyHoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) return contents.map(stringifyHoverContents).join("\n\n")
  if (contents && typeof contents === "object") {
    if ("value" in (contents as any)) return String((contents as any).value)
    if ("language" in (contents as any)) return String((contents as any).value ?? "")
  }
  return ""
}

export async function hover(filepath: string, line: number, character: number, cwd: string): Promise<string> {
  const opened = await ensureOpen(filepath, cwd)
  if (!opened) return "No language server available for this file type."
  const result = await opened.entry.client.hover(opened.uri, { line, character }).catch(() => null)
  if (!result || !result.contents) return "No hover information at this position."
  const text = stringifyHoverContents(result.contents)
  return text.trim() || "No hover information at this position."
}

function formatLocation(loc: Location, cwd: string): string {
  let file: string
  try {
    file = path.relative(cwd, fileURLToPath(loc.uri))
  } catch {
    file = loc.uri
  }
  return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
}

export async function definition(filepath: string, line: number, character: number, cwd: string): Promise<string> {
  const opened = await ensureOpen(filepath, cwd)
  if (!opened) return "No language server available for this file type."
  const result = await opened.entry.client.definition(opened.uri, { line, character }).catch(() => null)
  if (!result) return "No definition found at this position."
  const locations = Array.isArray(result) ? result : [result]
  if (locations.length === 0) return "No definition found at this position."
  return locations.map((loc) => formatLocation(loc, cwd)).join("\n")
}

export const Lsp = { touchFile, hover, definition }

// Cleanup so `bunx`-spawned servers don't linger after vega exits. `exit`
// handlers must be synchronous — `kill()` itself is (it just sends a
// signal), so this works even if a client is still mid-initialize.
process.on("exit", () => {
  for (const proc of liveProcesses) proc.kill()
})
