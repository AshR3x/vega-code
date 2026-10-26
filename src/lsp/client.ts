import path from "node:path"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { pathToFileURL, fileURLToPath } from "node:url"

// Servers are free to re-encode the URIs we send them when echoing them back
// (typescript-language-server, for one, lowercases the drive letter and
// percent-encodes the colon on Windows: `file:///F:/x` -> `file:///f%3A/x`).
// Map every URI to the underlying filesystem path before using it as a
// lookup key, so publishDiagnostics for "our" file actually matches.
function keyFor(uri: string): string {
  try {
    const p = fileURLToPath(uri)
    return process.platform === "win32" ? p.toLowerCase() : p
  } catch {
    return uri
  }
}

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Diagnostic {
  range: Range
  severity?: number // 1 error, 2 warning, 3 info, 4 hint
  message: string
  source?: string
  code?: string | number
}

export interface Location {
  uri: string
  range: Range
}

interface PendingRequest {
  resolve(value: any): void
  reject(err: Error): void
}

// Minimal JSON-RPC-over-stdio LSP client: initialize, didOpen/didChange,
// publishDiagnostics, hover, and definition. No incremental sync, no
// workspace/configuration handling, no dynamic capability registration —
// just enough for diagnostics-on-touch plus on-demand hover/definition
// lookups, which is all vega-code's tools need.
export class LspClient {
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, PendingRequest>()
  private openDocs = new Map<string, number>()
  private diagnosticsByUri = new Map<string, Diagnostic[]>()
  private diagnosticsWaiters = new Map<string, Array<() => void>>()

  constructor(
    readonly serverID: string,
    private child: ChildProcessWithoutNullStreams,
  ) {
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk))
    this.child.stderr.on("data", (c) => process.env.VEGA_LSP_DEBUG && console.error("[lsp stderr]", c.toString()))
    this.child.on("error", () => this.rejectAll(new Error(`${serverID} process error`)))
    this.child.on("close", () => this.rejectAll(new Error(`${serverID} process closed`)))
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8")
      const match = /Content-Length: (\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number.parseInt(match[1]!, 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8")
      this.buffer = this.buffer.subarray(bodyStart + length)
      try {
        this.handleMessage(JSON.parse(body))
      } catch {
        // malformed frame from the server — drop it and keep going
      }
    }
  }

  private handleMessage(msg: any) {
    if (process.env.VEGA_LSP_DEBUG) console.error("[lsp recv]", JSON.stringify(msg).slice(0, 500))
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message ?? "LSP error"))
      else pending.resolve(msg.result)
      return
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const key = keyFor(msg.params.uri as string)
      this.diagnosticsByUri.set(key, msg.params.diagnostics ?? [])
      const waiters = this.diagnosticsWaiters.get(key)
      if (waiters) {
        this.diagnosticsWaiters.delete(key)
        for (const wake of waiters) wake()
      }
      return
    }
    // window/logMessage, window/showMessage, server->client requests we
    // don't support, etc. — safe to ignore for diagnostics/hover/definition.
  }

  private write(obj: unknown) {
    const json = JSON.stringify(obj)
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`
    if (process.env.VEGA_LSP_DEBUG) console.error("[lsp send]", json.slice(0, 500))
    this.child.stdin.write(header + json)
  }

  private notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  private request<T = any>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  async initialize(root: string): Promise<void> {
    const rootUri = pathToFileURL(root).toString()
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
        },
      },
    })
    this.notify("initialized", {})
  }

  open(uri: string, languageId: string, text: string) {
    const version = this.openDocs.get(uri)
    if (version === undefined) {
      this.openDocs.set(uri, 1)
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
    } else {
      const next = version + 1
      this.openDocs.set(uri, next)
      this.notify("textDocument/didChange", { textDocument: { uri, version: next }, contentChanges: [{ text }] })
    }
  }

  // Resolves once publishDiagnostics fires for `uri`, or after `timeoutMs`
  // with whatever we last have (possibly none) — most servers publish
  // diagnostics within a few hundred ms of didOpen/didChange.
  waitForDiagnostics(uri: string, timeoutMs = 3000): Promise<Diagnostic[]> {
    const key = keyFor(uri)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.diagnosticsByUri.get(key) ?? []), timeoutMs)
      const waiters = this.diagnosticsWaiters.get(key) ?? []
      waiters.push(() => {
        clearTimeout(timer)
        resolve(this.diagnosticsByUri.get(key) ?? [])
      })
      this.diagnosticsWaiters.set(key, waiters)
    })
  }

  hover(uri: string, position: Position): Promise<{ contents: unknown } | null> {
    return this.request("textDocument/hover", { textDocument: { uri }, position })
  }

  definition(uri: string, position: Position): Promise<Location | Location[] | null> {
    return this.request("textDocument/definition", { textDocument: { uri }, position })
  }

  dispose() {
    this.rejectAll(new Error(`${this.serverID} disposed`))
    this.request("shutdown", undefined, 2000)
      .catch(() => {})
      .finally(() => {
        this.notify("exit")
        this.child.kill()
      })
  }
}
