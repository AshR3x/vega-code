import type { ProviderID } from "@/config"
import { listOllamaModels } from "@/ollama"

export class ModelListError extends Error {}

// Curated fallback used only if the live API call fails (network issue, etc.)
// so /models never leaves the user with nothing to pick from.
const FALLBACK: Record<Exclude<ProviderID, "ollama">, string[]> = {
  anthropic: ["claude-sonnet-4-5-20250929", "claude-opus-4-5-20250929", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  })
  if (!res.ok) throw new ModelListError(`Anthropic models API returned HTTP ${res.status}`)
  const json = (await res.json()) as { data: { id: string }[] }
  return json.data.map((m) => m.id)
}

async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new ModelListError(`OpenAI models API returned HTTP ${res.status}`)
  const json = (await res.json()) as { data: { id: string }[] }
  // The endpoint returns every model type (embeddings, tts, moderation, ...);
  // narrow to the chat-capable families so the picker isn't 90% noise.
  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"]
  return json.data.map((m) => m.id).filter((id) => chatPrefixes.some((p) => id.startsWith(p)))
}

async function listGroqModels(apiKey: string): Promise<string[]> {
  // Groq exposes an OpenAI-compatible /models endpoint.
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new ModelListError(`Groq models API returned HTTP ${res.status}`)
  const json = (await res.json()) as { data: { id: string }[] }
  return json.data.map((m) => m.id)
}

export async function listModels(provider: ProviderID): Promise<{ models: string[]; live: boolean }> {
  if (provider === "ollama") {
    return { models: await listOllamaModels(), live: true }
  }

  if (provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"]
    if (!key) throw new ModelListError("Missing ANTHROPIC_API_KEY.")
    try {
      return { models: await listAnthropicModels(key), live: true }
    } catch {
      return { models: FALLBACK.anthropic, live: false }
    }
  }

  if (provider === "openai") {
    const key = process.env["OPENAI_API_KEY"]
    if (!key) throw new ModelListError("Missing OPENAI_API_KEY.")
    try {
      return { models: await listOpenAIModels(key), live: true }
    } catch {
      return { models: FALLBACK.openai, live: false }
    }
  }

  if (provider === "groq") {
    const key = process.env["GROQ_API_KEY"]
    if (!key) throw new ModelListError("Missing GROQ_API_KEY.")
    try {
      return { models: await listGroqModels(key), live: true }
    } catch {
      return { models: FALLBACK.groq, live: false }
    }
  }

  throw new ModelListError(`Unknown provider: ${provider}`)
}
