// Byte-order-mark helpers, ported from opencode's util/bom. A file that starts
// with U+FEFF should keep it across edits/writes; split() peels it off so the
// rest of the tooling works on BOM-less text and join() puts it back.

const value = "\uFEFF"

export function split(text: string): { bom: boolean; text: string } {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

export function join(text: string, bom: boolean): string {
  const stripped = split(text).text
  return bom ? value + stripped : stripped
}

export const Bom = { split, join }
