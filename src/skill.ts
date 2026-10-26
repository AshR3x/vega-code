import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { glob } from "glob"
import { homeConfigDir } from "@/config"

export interface SkillInfo {
  id: string
  name: string
  description: string
  // Whether the model may invoke this skill on its own (metadata
  // `opencode/autoinvoke`, or !disable-model-invocation).
  autoinvoke: boolean
  path: string
  content: string
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "")
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

// Minimal frontmatter reader: flat `key: value` lines plus one level of
// indentation for nested maps (e.g. `metadata:` -> `opencode/autoinvoke: true`).
function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: text }
  const data: Record<string, unknown> = {}
  let nested: Record<string, unknown> | undefined
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const kv = line.match(/^(\s*)([^:\s][^:]*?)\s*:\s*(.*)$/)
    if (!kv) continue
    const indented = kv[1]!.length > 0
    const key = kv[2]!.trim()
    const value = kv[3]!.trim()
    if (value === "") {
      nested = {}
      data[key] = nested
    } else if (indented && nested) {
      nested[key] = stripQuotes(value)
    } else {
      data[key] = stripQuotes(value)
      nested = undefined
    }
  }
  return { data, body: match[2] ?? "" }
}

function parseSkillFile(root: string, filepath: string, content: string): SkillInfo | undefined {
  const { data, body } = parseFrontmatter(content)
  const dirname = path.dirname(filepath)
  // A standalone *.md directly in the root is a skill named after the file;
  // a **/SKILL.md is a skill named after its containing directory.
  const id = dirname === root && path.basename(filepath) !== "SKILL.md" ? path.basename(filepath, ".md") : path.basename(dirname)
  if (!id) return undefined
  const metadata = data["metadata"]
  const autoinvokeMeta =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? booleanValue((metadata as Record<string, unknown>)["opencode/autoinvoke"])
      : undefined
  const disable = booleanValue(data["disable-model-invocation"])
  const autoinvoke = autoinvokeMeta ?? (disable ? false : true)
  return {
    id,
    name: typeof data["name"] === "string" && data["name"] ? data["name"] : id,
    description: typeof data["description"] === "string" ? data["description"] : "",
    autoinvoke,
    path: filepath,
    content: body.trim(),
  }
}

// Skill roots: project-local, the user's home config, then any directories
// listed under `skills` in vega.config.json (~/ is expanded).
function skillRoots(cwd: string): string[] {
  const roots = [path.join(cwd, ".vega", "skill"), path.join(cwd, ".vega", "skills"), path.join(homeConfigDir(), "skill"), path.join(homeConfigDir(), "skills")]
  try {
    const file = path.join(cwd, "vega.config.json")
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8")
      const parsed = JSON.parse(raw) as { skills?: unknown }
      if (Array.isArray(parsed.skills)) {
        for (const entry of parsed.skills) {
          if (typeof entry !== "string") continue
          const expanded = entry.startsWith("~/") ? path.join(homeConfigDir(), "..", entry.slice(2)) : entry
          roots.push(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
        }
      }
    }
  } catch {
    // ignore malformed config
  }
  return roots
}

let cache: { key: string; skills: SkillInfo[] } | undefined

export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  if (cache?.key === cwd) return cache.skills

  const skills: SkillInfo[] = []
  const seen = new Set<string>()
  for (const root of skillRoots(cwd)) {
    if (!existsSync(root)) continue
    const files = await glob("{*.md,**/SKILL.md}", { cwd: root, absolute: true, dot: true, nodir: true }).catch(() => [])
    for (const file of files.sort()) {
      const raw = await readFile(file, "utf-8").catch(() => undefined)
      if (raw === undefined) continue
      const skill = parseSkillFile(path.resolve(root), path.resolve(file), raw)
      if (!skill || seen.has(skill.id)) continue
      seen.add(skill.id)
      skills.push(skill)
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id))
  cache = { key: cwd, skills }
  return skills
}

export async function getSkill(id: string, cwd: string): Promise<SkillInfo | undefined> {
  return (await listSkills(cwd)).find((skill) => skill.id === id)
}

// Renders a skill as model content: the instructions plus a sampled list of
// the skill directory's other files (scripts/, references/, ...).
export async function renderSkill(skill: SkillInfo): Promise<string> {
  const directory = path.dirname(skill.path)
  let files: string[] = []
  if (path.basename(skill.path) === "SKILL.md") {
    files = (await glob("**/*", { cwd: directory, absolute: true, dot: true, nodir: true }).catch(() => []))
      .filter((file) => path.basename(file) !== "SKILL.md")
      .sort()
      .slice(0, 10)
  }
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content,
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}
