// Truecolor purple palette. picocolors only gives us the 16 basic ANSI colors
// (closest is "magenta"), which doesn't match a real purple — so this speaks
// SGR truecolor escapes directly. Falls back to plain text when the terminal
// doesn't advertise color support (NO_COLOR, dumb terminals, non-TTY pipes).

const supportsColor = Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb"

function rgb(r: number, g: number, b: number) {
  return (text: string) => (supportsColor ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text)
}

function sgr(code: number) {
  return (text: string) => (supportsColor ? `\x1b[${code}m${text}\x1b[0m` : text)
}

// Single source of truth for the palette. Both the ANSI helpers below and the
// hex strings OpenTUI consumes are derived from these RGB values so they can
// never drift apart.
export const palette = {
  // Core purple ramp
  purple: [168, 133, 255] as const,
  purpleBright: [200, 170, 255] as const,
  purpleDim: [120, 95, 190] as const,
  // A darker "shadow" tone, used for the bevel effect on block-letter logos —
  // text blends toward its own rendered background color for this, which we
  // can't do here (a plain ANSI CLI doesn't own/know the
  // terminal's actual background), so this approximates it by just going
  // darker instead, which reads fine on the dark terminal themes most people
  // code in but won't blend correctly on a light-background terminal.
  purpleShadow: [70, 55, 110] as const,
  // Accents
  accent: [255, 158, 100] as const, // orange, for warnings/permission prompts (the amber accent)
  cyan: [94, 200, 255] as const, // user-message labels
  error: [255, 110, 110] as const,
  success: [130, 220, 160] as const,
  // Neutrals
  white: [235, 235, 240] as const,
  gray: [140, 140, 150] as const,
  // Subtle tint behind inline code spans in rendered markdown.
  codeBg: [42, 34, 62] as const,
} as const

// ANSI truecolor helpers for the console path.
export const theme = {
  purple: rgb(...palette.purple),
  purpleBright: rgb(...palette.purpleBright),
  purpleDim: rgb(...palette.purpleDim),
  purpleShadow: rgb(...palette.purpleShadow),
  accent: rgb(...palette.accent),
  cyan: rgb(...palette.cyan),
  error: rgb(...palette.error),
  success: rgb(...palette.success),
  white: rgb(...palette.white),
  gray: rgb(...palette.gray),
  dim: sgr(2),
  bold: sgr(1),
}

// Hex strings for the OpenTUI path. OpenTUI parses hex via parseColor.
export const colors: Record<keyof typeof palette, string> = Object.fromEntries(
  Object.entries(palette).map(([name, [r, g, b]]) => {
    const hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
    return [name, `#${hex}`]
  }),
) as Record<keyof typeof palette, string>

export function colorEnabled(): boolean {
  return supportsColor
}

// For colors that aren't part of the fixed palette above (e.g. per-agent
// accent colors).
export function fromRgb(r: number, g: number, b: number): (text: string) => string {
  return rgb(r, g, b)
}
