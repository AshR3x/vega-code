import path from "node:path"
import os from "node:os"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"

const root = path.join(process.cwd(), ".vega")

export const Paths = {
  root,
  sessions: path.join(root, "sessions"),
  tmp: path.join(root, "tmp"),
}

export type ProviderID = "anthropic" | "openai" | "ollama" | "groq"

export interface VegaConfig {
  provider: ProviderID
  model: string
  smallModel?: string
  subagentDepth: number
  contextLimit: number
  ollamaHost: string
}

export const PROVIDERS: ProviderID[] = ["anthropic", "openai", "ollama", "groq"]

const DEFAULT_MODEL: Record<ProviderID, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4.1",
  // Groq and Ollama have no fixed default — Groq's lineup turns over too
  // often to hardcode (old ids get retired), and Ollama's depends entirely
  // on what's pulled locally. Callers should resolve one live (see
  // src/models.ts's listModels) and pass it explicitly through VEGA_MODEL.
  groq: "",
  ollama: "",
}

const DEFAULTS: Omit<VegaConfig, "provider" | "model"> = {
  subagentDepth: 1,
  contextLimit: 180_000,
  ollamaHost: "http://localhost:11434",
}

export function homeConfigDir() {
  return path.join(os.homedir(), ".vega-code")
}

// The last provider/model explicitly chosen via /models, /provider, or the
// Ollama picker — remembered per-provider (not just a single last-used
// pair) so switching from e.g. ollama to anthropic and back doesn't forget
// which ollama model you'd picked. Global (home dir), not per-project:
// "which model I prefer" is a personal habit, not a project setting —
// that's what vega.config.json is for.
export interface SavedPreferences {
  provider?: ProviderID
  models?: Partial<Record<ProviderID, string>>
}

const PREFERENCES_FILE = path.join(homeConfigDir(), "preferences.json")

export async function loadPreferences(): Promise<SavedPreferences> {
  try {
    return JSON.parse(await readFile(PREFERENCES_FILE, "utf-8"))
  } catch {
    return {}
  }
}

// Deliberately NOT called for one-off `--provider`/`--model` CLI flags —
// those are session overrides, not a change to your remembered default
// (same convention as e.g. `kubectl --context=x` not rewriting your default
// context). Only explicit interactive selection persists.
export async function saveModelPreference(provider: ProviderID, model: string): Promise<void> {
  const current = await loadPreferences()
  const next: SavedPreferences = {
    provider,
    models: { ...current.models, [provider]: model },
  }
  await mkdir(homeConfigDir(), { recursive: true })
  await writeFile(PREFERENCES_FILE, JSON.stringify(next, null, 2), "utf-8")
}

export async function loadConfig(): Promise<VegaConfig> {
  await mkdir(Paths.root, { recursive: true })
  const file = path.join(process.cwd(), "vega.config.json")
  let fromFile: Partial<VegaConfig> = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(await readFile(file, "utf-8"))
    } catch {
      // ignore malformed config, fall back to defaults + env
    }
  }

  const prefs = await loadPreferences()

  const envModel = process.env["VEGA_MODEL"]
  const envProvider = process.env["VEGA_PROVIDER"] as ProviderID | undefined
  const envOllamaHost = process.env["VEGA_OLLAMA_HOST"]

  // Precedence: CLI flag / env var > project vega.config.json > your saved
  // preference from last time > hardcoded default.
  const provider = envProvider ?? fromFile.provider ?? prefs.provider ?? "anthropic"
  const model = envModel ?? fromFile.model ?? prefs.models?.[provider] ?? DEFAULT_MODEL[provider]

  return {
    ...DEFAULTS,
    ...fromFile,
    provider,
    model,
    ...(envOllamaHost ? { ollamaHost: envOllamaHost } : {}),
  }
}
