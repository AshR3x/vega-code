// Cheap token estimate. Good enough for compaction/pruning decisions —
// exact provider tokenization isn't worth the dependency weight here.
export function estimate(text: string): number {
  return Math.ceil(text.length / 4)
}

export const Token = { estimate }
