import { readFileSync } from "node:fs"
const lines = readFileSync("C:/Users/ashwi/OneDrive/Documents/vega-code.txt", "utf-8").split(/\r?\n/).filter(Boolean)
for (const l of lines) {
  console.log("[" + l.slice(0, 25).trimEnd() + "] | [" + l.slice(25).trimStart() + "]")
}
