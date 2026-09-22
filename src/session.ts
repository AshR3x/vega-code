import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { ModelMessage } from "ai"
import { Paths } from "@/config"

export interface SessionData {
  id: string
  createdAt: number
  messages: ModelMessage[]
}

export class Session {
  data: SessionData

  private constructor(data: SessionData) {
    this.data = data
  }

  static async create(id: string): Promise<Session> {
    return new Session({ id, createdAt: Date.now(), messages: [] })
  }

  static async resume(id: string): Promise<Session | undefined> {
    const file = path.join(Paths.sessions, `${id}.json`)
    if (!existsSync(file)) return undefined
    const raw = await readFile(file, "utf-8")
    return new Session(JSON.parse(raw))
  }

  static async mostRecent(): Promise<Session | undefined> {
    if (!existsSync(Paths.sessions)) return undefined
    const { readdir, stat } = await import("node:fs/promises")
    const files = await readdir(Paths.sessions)
    const jsonFiles = files.filter((f) => f.endsWith(".json"))
    if (jsonFiles.length === 0) return undefined
    const withStat = await Promise.all(
      jsonFiles.map(async (f) => ({ f, mtime: (await stat(path.join(Paths.sessions, f))).mtimeMs })),
    )
    withStat.sort((a, b) => b.mtime - a.mtime)
    const id = withStat[0].f.replace(/\.json$/, "")
    return Session.resume(id)
  }

  async save(): Promise<void> {
    await mkdir(Paths.sessions, { recursive: true })
    const file = path.join(Paths.sessions, `${this.data.id}.json`)
    await writeFile(file, JSON.stringify(this.data, null, 2), "utf-8")
  }
}

export function newSessionID(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
