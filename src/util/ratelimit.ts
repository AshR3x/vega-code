import { APICallError } from "ai"

// Every provider (Anthropic/OpenAI/Groq) throws APICallError with statusCode
// 429 on rate limiting; the AI SDK's own maxRetries (default 2, applied per
// request inside streamText/generateText) already retries transient ones
// with backoff. This only fires once that's exhausted, so it's the "still
// rate limited after retrying" case — surfaced with a specific, actionable
// message (using the provider's Retry-After header when it sends one)
// instead of the generic "Error: <raw SDK message>" catch-all.
export function describeRateLimitError(err: unknown): string | undefined {
  if (!APICallError.isInstance(err) || err.statusCode !== 429) return undefined
  const wait = parseRetryAfter(findHeader(err.responseHeaders, "retry-after"))
  return wait
    ? `Rate limited by the provider (HTTP 429). Try again in about ${wait}.`
    : "Rate limited by the provider (HTTP 429). Wait a moment, then try again."
}

function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

// Retry-After is either a number of seconds or an HTTP-date.
function parseRetryAfter(value: string | undefined): string | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return formatSeconds(seconds)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const diffSeconds = Math.ceil((date.getTime() - Date.now()) / 1000)
  return diffSeconds > 0 ? formatSeconds(diffSeconds) : undefined
}

function formatSeconds(total: number): string {
  const seconds = Math.round(total)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}
