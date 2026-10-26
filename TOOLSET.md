# opencode toolset → vega-code-v2 parity checklist

This file tracks how much of **opencode's current toolset** (the V2 rewrite at
`opencode`, Effect-based plugin architecture) has been ported into
`vega-code-v2`.

Legend: **✅ ported** (behaviour matched) · **🟡 partial** (core present, gaps
noted) · **⬜ not ported** · **➕ vega-only** (no opencode counterpart).

---

## Native tools (opencode registers 12)

| Tool | opencode | vega-code-v2 | Notes / gaps |
|---|---|---|---|
| `read` | ✅ | 🟡 | Text + directory listing, 2000-line default, line-number prefixes, 50 KiB output cap, filename "did you mean" suggestions. **Gap:** no image/PDF multimodal ingest (vega tool results are strings). |
| `write` | ✅ | ✅ | BOM-preserving write, creates parent dirs. **Gap:** no formatter sync / diff preview. |
| `edit` | ✅ | ✅ | Full matcher ported: LF-view matching, CRLF & mixed-ending preservation, typographic quote/dash/space normalization, trailing-whitespace fallback, `endings-only` handling. **Gap:** no file lock / formatter. |
| `patch` | ✅ | ✅ | `*** Begin Patch` parser + deriver: Add / Delete / Update / **Move**, `@@` context, `*** End of File`, loose line matching. **Gap:** no file lock / formatter, and no GPT `edit`/`write`-swap model hook. |
| `shell` (renamed) | ✅ | 🟡 | Exposed as `bash`. Foreground exec + `background: true` (streams to a temp log, returns immediately) + `timeout: 0` to disable. **Gaps:** no job/notification system, no shell-command parser for permissions, no `AGENT`/`OPENCODE` env injection. |
| `glob` | ✅ | 🟡 | `pattern`, `path`, `hidden`, `limit` (default 100), truncation notice, mtime sort. **Gap:** uses node `glob` rather than ripgrep. |
| `grep` | ✅ | 🟡 | `pattern`, `path`, `include`, `literal`, `caseSensitive`, `limit`. **Gap:** hand-rolled scanner (2 MB/file skip) rather than ripgrep. |
| `question` | ✅ | ✅ | Multiple-choice + free-text, `multiple`, first-option "recommended" convention. |
| `skill` | ✅ | 🟡 | Discovery (`{*.md, **/SKILL.md}` roots), frontmatter (`name`, `description`, `opencode/autoinvoke`, `disable-model-invocation`), `skill` tool, available skills injected into the system prompt. **Gaps:** no URL skill sources, no built-in skills (opencode ships `opencode`/`report`). |
| `subagent` (renamed) | ✅ | 🟡 | Exposed as `task`. Depth limit (`subagentDepth`), `model` override, `askText` passthrough, per-agent tool lists. **Gaps:** no `background`, no `sessionID` continuation, no per-agent description injection. |
| `webfetch` | ✅ | 🟡 | vega has its own Python/trafilatura fetcher (outline + query sections + cache). Different implementation; not a byte-for-byte port. |
| `websearch` | ✅ | 🟡 | vega uses keyless DuckDuckGo (`ddgs`). opencode uses a selectable search-provider integration. Different backend. |

**➕ vega-only tools (no opencode counterpart):** `todo` (opencode V2 removed
`todowrite`), `hover`, `definition` (LSP; opencode has **no** LSP tools).

---

## CodeMode & namespaced tools

| Tool | Status | Notes |
|---|---|---|
| `execute` (CodeMode JS runtime, `tools.<path>` + `search()`) | ⬜ | Not ported — needs a confined JS sandbox + catalog. |
| `opencode_session_rename` | ⬜ | Session-management tool. |
| `opencode_session_move` | ⬜ | Session-management tool. |
| `opencode_worktree_create` / `_list` / `_remove` | ⬜ | Git worktree tools. |
| `opencode_models` | ⬜ | Model search tool (vega has `/models` as a slash command only). |
| `opencode_list_mcp_resources` / `opencode_read_mcp_resource` | ⬜ | MCP resource access. |

---

## Browser automation (`packages/plugin-browser`, ~44 tools)

⬜ **Not ported.** Requires the RPC/proxy/tunnel infrastructure and a live
browser. Operations: `browser_tabs_*`, `browser_preview`, `browser_navigate`
(+ back/forward/reload/stop), `browser_frames`, `browser_snapshot`,
`browser_find`, `browser_evaluate`, `browser_click/hover/drag/fill/fill_form/
select/check/press/scroll/wait`, `browser_screenshot`, `browser_dialog`,
`browser_files_*`, `browser_console`, `browser_network_*`,
`browser_trace_*`, `browser_cpu_*`, `browser_heap_*`, `browser_lighthouse`.

---

## MCP

| Capability | Status | Notes |
|---|---|---|
| Dynamic MCP server tools (`<server>_<tool>`) | ⬜ | Needs an MCP client + dynamic registration. |
| MCP resources (list/read) | ⬜ | See namespaced tools above. |

---

## Cross-cutting infrastructure

| Capability | Status | Notes |
|---|---|---|
| Tool registry / per-agent tool filtering | ✅ | `buildToolSet(agent.tools)` in `src/tool/registry.ts`. |
| Permission system (allow/deny/ask, wildcard, per-turn rejection) | ✅ | vega's own (`src/permission.ts`), different action names. |
| Global output bounding | 🟡 | vega truncates >20k chars head/tail to a temp file (`src/util/truncate.ts`); opencode uses 50 KiB / 2000 lines with 7-day retention. |
| File locking across concurrent edits | ⬜ | opencode `FileMutation.withLock`; vega has none. |
| Formatter integration after write/edit | ⬜ | Needs a formatter service. |
| BOM preservation | ✅ | `src/util/bom.ts`, used by `write`/`edit`/`patch`. |
| Model-conditional tool swaps (patch ↔ edit/write for GPT) | ⬜ | vega exposes both `edit` and `patch` at once. |
| `question` free-text prompt plumbing | ✅ | `ToolContext.askText`, wired to TUI + console. |
| Subagent nesting depth config | ✅ | `subagentDepth` in `vega.config.json`. |
| Skills surfaced in system prompt | ✅ | `buildSystemPrompt` adds `<available_skills>`. |

---

## Summary

- **Native tools:** 12 of 12 present (2 renamed: `shell`→`bash`, `subagent`→`task`);
  8 fully ✅, 4 🟡 (read image/PDF, ripgrep-backed grep/glob, skill URL sources +
  built-ins, subagent background/continue, webfetch/websearch backend parity).
- **➕ vega-only:** `todo`, `hover`, `definition`.
- **Not ported:** `execute`/CodeMode, MCP (tools + resources),
  `opencode_*` (session/worktree/models), and all ~44 `browser_*` tools.
- **Infra gaps:** file locking, formatter integration, ripgrep, 50 KiB output
  bounding, and the GPT `patch` tool-swap.
