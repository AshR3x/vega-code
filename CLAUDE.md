# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

vega-code is a small, single-package clone of the core mechanisms behind [opencode](https://github.com/sst/opencode)
(an agentic coding CLI): tool-calling loop, wildcard permission system, context compaction, and subagents — built
on Bun + TypeScript + the Vercel AI SDK, deliberately kept as a single package with none of the
service-layer complexity.
It is a readable, hackable REPL, not a drop-in replacement for a hosted product.

## Commands

```
bun install                                        # install deps
bun run src/index.ts                                # interactive REPL
bun run src/index.ts "fix the bug in src/foo.ts"    # one-shot prompt, no REPL
bun run src/index.ts --continue                     # resume the most recent .vega/sessions/*.json
bun run src/index.ts --provider ollama              # override provider (anthropic|openai|ollama)
bun run src/index.ts --model <id>                   # override model
bun x tsc --noEmit                                  # typecheck (also `bun run typecheck`)
```

There is no test suite and no lint config in this repo yet — `tsc --noEmit` is the only current verification step.
Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment (see `.env.example`); the `ollama` provider
needs no key but does need the `ollama` CLI on PATH with the daemon reachable at `ollamaHost` (default
`http://localhost:11434`).

## Architecture

**Request flow**: `src/index.ts` (REPL/CLI entry) → `src/loop.ts` (`runAgentLoop`, the actual agentic loop —
builds system prompt, resolves the model, calls `streamText` with tools, loops on `stopWhen: stepCountIs(30)`) →
tool execution via `src/tool/registry.ts` → results streamed back to the terminal.

**Tool pattern** (`src/tool/types.ts`): every tool is a plain `ToolDef` — `{ id, description, parameters (zod),
execute(args, ctx) }` — independent of the AI SDK. `src/tool/registry.ts` wraps each one into an AI SDK `tool()`
at call time. The model never sees `ToolContext` (permission service, sessionID, cwd, abort signal); it's threaded
through `streamText`'s `experimental_context` option and read back out inside the wrapped `execute` via
`options.experimental_context`. Add a new tool by writing a `ToolDef` in `src/tool/`, adding it to `ALL` in
`registry.ts`, and adding its id to the relevant `AgentDef.tools` list in `src/agent.ts`.

**Permissions** (`src/permission.ts`): a wildcard `(permission, pattern) -> allow|deny|ask` ruleset
(`DEFAULT_RULESET`), evaluated last-match-wins. Tools call `ctx.ask({ permission, patterns, always })` before
doing anything effectful; the `PermissionService` prompts interactively and remembers "always" approvals for the
rest of the session. `setAutoApprove(true)` (wired to the `/auto` command) widens `ask` to `allow` but still
honors explicit `deny` rules — it's not a full bypass.

**Agents** (`src/agent.ts`): `AgentDef` has a `mode: "primary" | "subagent"` and a `tools` allowlist. `build`
(full access) and `plan` (read-only, primary) are user-selectable via `/agent`,
`/plan`, `/build`. `general` is `subagent`-only, used by the `task` tool. The `task` tool (`src/tool/task.ts`)
spawns a nested `runAgentLoop` with a restricted agent; it `await import("@/loop")` dynamically specifically to
break the `loop.ts` → `registry.ts` → `task.ts` → `loop.ts` circular import.

**Context/compaction** (`src/context.ts`): system prompt = fixed preamble + agent-specific prompt fragment + env
block + project `AGENTS.md` contents (if present in cwd — note this is *vega-code's own* runtime-loaded
instructions file, unrelated to this CLAUDE.md). `isOverflow()` is a cheap chars/4 token estimate against
`cfg.contextLimit`; `compact()` summarizes everything except the last 10 messages via a `generateText` call and
replaces them with one synthetic summary message. Oversized individual tool outputs are separately truncated to
a head/tail preview with the full text written to `.vega/tmp/` (`src/util/truncate.ts`).

**Provider/model switching** (`src/provider.ts`, `src/config.ts`, `src/models.ts`): provider and model are not
passed as explicit parameters through the call chain — `loadConfig()` reads `VEGA_PROVIDER`/`VEGA_MODEL` env vars
every time it's called (from `loop.ts`, on every turn). CLI flags (`--provider`/`--model`) and the `/provider`
and `/models` REPL commands both work by mutating `process.env` and re-calling `loadConfig()`, not by passing
config objects around. `/models` lists models live from the provider's own API (Anthropic/OpenAI `GET
/v1/models`) or `ollama list` for the ollama provider — never a hardcoded model list, matching the project's
general preference for live discovery over static tables that go stale (see `src/ollama.ts`,
`src/tool/websearch.ts`'s keyless `ddgs` search likewise avoids a paid API).

**Session persistence** (`src/session.ts`): one JSON file per session under `.vega/sessions/<id>.json`
containing the raw `ModelMessage[]` array (the AI SDK's own message format — no custom message-parts model).

## Known sharp edges (don't "fix" these without understanding why)

- **`@ai-sdk/openai-compatible` is pinned to `1.0.54`**, not the latest. Newer versions (2.x/3.x) depend on a
  newer `@ai-sdk/provider` spec (`LanguageModelV3`/`V4`) than `ai@5`/`@ai-sdk/anthropic@2`/`@ai-sdk/openai@2` in
  this project support (`LanguageModelV2`). Bumping it naively reintroduces a `LanguageModelV2` vs `V3` type
  error and will likely break at runtime too — check `@ai-sdk/provider` dependency versions match across all
  `@ai-sdk/*` packages before upgrading any one of them.
- **`src/index.ts`'s `ask()` is a custom line queue, not `rl.question()`.** Plain `readline.question()` only
  captures the *next* `'line'` event at the moment it's called; input arriving faster than the REPL re-calls it
  (pasted multi-line input, piped/scripted stdin) gets silently dropped, and a pending `question()` never
  resolves once stdin hits EOF, which kills the process with no error. The queue + `'close'` handler in
  `index.ts` fixes both. Don't replace it with a bare `rl.question()` loop.
- **`websearch` and `webfetch` shell out to Python** (`src/tool/py.ts`) and need `pip install ddgs trafilatura`.
  Packages are probed separately: without `trafilatura`, `webfetch` falls back to the regex `htmlToText`; without
  `ddgs`, only `websearch` fails. Options go in as one JSON argv blob and page bytes over stdin (Windows argv cap).
  `ddgs` silently returns `[]` when DDG fingerprint-blocks a request, so `websearch` retries once before saying
  "no results".
- **The header visualizer is `visualizer/feed.py`** (Windows-only, self-contained): a Python child process started by
  `src/tui/visualizer.ts` that streams spectrum/now-playing/album-art as JSON lines and accepts `playpause|next|prev`
  on stdin. Needs `pip install -r visualizer/requirements.txt`; `VEGA_VISUALIZER=off` disables it, and if anything
  is missing the panel just doesn't appear. SMTC's reported position only updates every few seconds, so the feed
  extrapolates from `last_updated_time` instead of re-reading it raw (reading it raw makes the scrubber jump).
- **`webfetch` follows redirects by hand** so a cross-host hop re-prompts for `webfetch` permission — don't switch
  it back to `redirect: "follow"`. Pages are extracted once, cached per session (url + mode + include), and the
  optional `query` picks sections with a small BM25 scorer in TS; the outline's line ranges must match what
  `read` shows, so cleanup happens in `normalize()` before line numbers are assigned.

## Project conventions

- Keep changes minimal and consistent with existing style; prefer editing existing files over creating new ones.
- Don't add tests or docs unless asked.
