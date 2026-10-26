import path from "node:path"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { Database } from "bun:sqlite"
import type { ModelMessage } from "ai"
import { Paths } from "@/config"

export interface SessionData {
  id: string
  createdAt: number
  messages: ModelMessage[]
}

interface SessionRow {
  id: string
  created_at: number
  messages: string
}

let db: Database | undefined

function getDb(): Database {
  if (db) return db
  mkdirSync(Paths.root, { recursive: true })
  db = new Database(Paths.db)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, messages TEXT NOT NULL)",
  )
  migrateLegacyJsonSessions(db)
  return db
}

// One-time import of sessions from the old `.vega/sessions/*.json` layout.
// Left in place (not deleted) as a backup; INSERT OR IGNORE makes this a
// no-op on every run after the first.
function migrateLegacyJsonSessions(db: Database) {
  if (!existsSync(Paths.sessions)) return
  const files = readdirSync(Paths.sessions).filter((f) => f.endsWith(".json"))
  if (files.length === 0) return
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sessions (id, created_at, updated_at, messages) VALUES (?, ?, ?, ?)",
  )
  const importAll = db.transaction((rows: SessionData[]) => {
    for (const row of rows) insert.run(row.id, row.createdAt, row.createdAt, JSON.stringify(row.messages))
  })
  const parsed: SessionData[] = []
  for (const f of files) {
    try {
      parsed.push(JSON.parse(readFileSync(path.join(Paths.sessions, f), "utf-8")))
    } catch {
      // skip corrupt/unreadable legacy file
    }
  }
  if (parsed.length > 0) importAll(parsed)
}

function fromRow(row: SessionRow): SessionData {
  return { id: row.id, createdAt: row.created_at, messages: JSON.parse(row.messages) }
}

export class Session {
  data: SessionData

  private constructor(data: SessionData) {
    this.data = data
  }

  static async create(id: string): Promise<Session> {
    const data: SessionData = { id, createdAt: Date.now(), messages: [] }
    getDb().run("INSERT INTO sessions (id, created_at, updated_at, messages) VALUES (?, ?, ?, ?)", [
      data.id,
      data.createdAt,
      data.createdAt,
      JSON.stringify(data.messages),
    ])
    return new Session(data)
  }

  static async resume(id: string): Promise<Session | undefined> {
    const row = getDb()
      .query("SELECT id, created_at, messages FROM sessions WHERE id = ?")
      .get(id) as SessionRow | null
    if (!row) return undefined
    return new Session(fromRow(row))
  }

  static async mostRecent(): Promise<Session | undefined> {
    const row = getDb()
      .query("SELECT id, created_at, messages FROM sessions ORDER BY updated_at DESC LIMIT 1")
      .get() as SessionRow | null
    if (!row) return undefined
    return new Session(fromRow(row))
  }

  async save(): Promise<void> {
    getDb().run("UPDATE sessions SET updated_at = ?, messages = ? WHERE id = ?", [
      Date.now(),
      JSON.stringify(this.data.messages),
      this.data.id,
    ])
  }
}

export function newSessionID(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
