import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGroq } from "@ai-sdk/groq"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import type { VegaConfig } from "@/config"

export class MissingApiKeyError extends Error {
  constructor(envVar: string) {
    super(`Missing ${envVar}. Set it in your environment before running vega.`)
  }
}

export function resolveModel(cfg: VegaConfig, modelID?: string): LanguageModel {
  const id = modelID ?? cfg.model

  if (cfg.provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"]
    if (!key) throw new MissingApiKeyError("ANTHROPIC_API_KEY")
    return createAnthropic({ apiKey: key })(id)
  }

  if (cfg.provider === "openai") {
    const key = process.env["OPENAI_API_KEY"]
    if (!key) throw new MissingApiKeyError("OPENAI_API_KEY")
    return createOpenAI({ apiKey: key })(id)
  }

  if (cfg.provider === "groq") {
    const key = process.env["GROQ_API_KEY"]
    if (!key) throw new MissingApiKeyError("GROQ_API_KEY")
    return createGroq({ apiKey: key })(id)
  }

  if (cfg.provider === "ollama") {
    if (!id) throw new Error("No Ollama model selected. Pass --model, or omit it to pick from `ollama list`.")
    // Ollama exposes an OpenAI-compatible endpoint; no API key needed for local use.
    return createOpenAICompatible({ name: "ollama", baseURL: `${cfg.ollamaHost}/v1` })(id)
  }

  throw new Error(`Unknown provider: ${cfg.provider}`)
}
