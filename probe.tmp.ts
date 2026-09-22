import { readFileSync } from "node:fs"
const lines = readFileSync("C:/Users/ashwi/OneDrive/Documents/vega-code.txt", "utf-8").split(/\r?\n/).filter(Boolean)
console.log("widths:", lines.map((l) => l.length))
console.log("count:", lines.length)
for (let c = 22; c <= 40; c++) {
  const allSpace = lines.every((l) => (l[c] ?? " ") === " ")
  if (allSpace) console.log("space col:", c)
}
for (const l of lines) {
  const left = l.slice(0, 33)
  const right = l.slice(33)
  console.log("[" + left.trimEnd() + "]  |  [" + right.trimStart() + "]")
}