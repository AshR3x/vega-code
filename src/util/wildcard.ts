// Minimal glob-style matcher for permission patterns.
// `*` matches any run of characters (including path separators, for simplicity).
// `?` matches exactly one character. Everything else is matched literally.
export function match(text: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (pattern === text) return true

  const normalizedText = text.replace(/\\/g, "/")
  const normalizedPattern = pattern.replace(/\\/g, "/")

  let regexSource = ""
  for (const char of normalizedPattern) {
    if (char === "*") regexSource += ".*"
    else if (char === "?") regexSource += "."
    else regexSource += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  const regex = new RegExp(`^${regexSource}$`, "i")
  return regex.test(normalizedText)
}

export const Wildcard = { match }
