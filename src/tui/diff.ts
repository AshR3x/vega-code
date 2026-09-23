export type DiffLine = { type: "add" | "del" | "ctx"; text: string }

// LCS-based line diff (same idea as `diff -u`), used to show the edit
// tool's oldString -> newString as red/green lines instead of dumping both
// raw strings. O(n*m) DP — fine for the snippet-sized strings the edit tool
// actually deals with; large inputs fall back to a plain remove-all/add-all
// diff rather than paying for (or blocking on) a huge DP table.
const MAX_DP_CELLS = 200 * 200

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  const n = oldLines.length
  const m = newLines.length

  if (n * m > MAX_DP_CELLS) {
    return [...oldLines.map((text): DiffLine => ({ type: "del", text })), ...newLines.map((text): DiffLine => ({ type: "add", text }))]
  }

  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "ctx", text: oldLines[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "del", text: oldLines[i]! })
      i++
    } else {
      result.push({ type: "add", text: newLines[j]! })
      j++
    }
  }
  while (i < n) {
    result.push({ type: "del", text: oldLines[i]! })
    i++
  }
  while (j < m) {
    result.push({ type: "add", text: newLines[j]! })
    j++
  }
  return result
}
