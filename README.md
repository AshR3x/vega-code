# vega-code

A small, single-package clone of the core ideas behind [opencode](https://github.com/sst/opencode) — an agentic
coding CLI built on Bun + the Vercel AI SDK. Built after reading opencode's actual source (tool definitions,
permission ruleset, compaction strategy, subagent architecture) rather than guessing.

## What's implemented

- **Tools**: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `webfetch`, `todo`, `task` (subagent spawn)
- **Permissions**: wildcard `allow`/`deny`/`ask` ruleset, interactive CLI approval with "always allow"
- **Context management**: `AGENTS.md` project instructions, token-based overflow detection, LLM-summarized
  compaction that keeps the last 10 messages verbatim and folds the rest into a summary
- **Subagents**: the `task` tool spawns a nested agent loop (`general` agent: read-only, no further nesting)
- **Session persistence**: JSON files under `.vega/sessions/`, `--continue` resumes the most recent one

## Setup

```
bun install
cp .env.example .env   # fill in ANTHROPIC_API_KEY or OPENAI_API_KEY
```

## Usage

```
bun run src/index.ts                 # interactive REPL
bun run src/index.ts "fix the bug in src/foo.ts"   # one-shot
bun run src/index.ts --continue      # resume the most recent session
```

Slash commands in the REPL: `/exit`, `/clear`.

## What's deliberately left out (vs. real opencode)

Real opencode is a large team's Effect-TS production codebase with SQLite-backed durable sessions, an HTTP/SSE
server + separate TUI client, LSP integration, MCP servers, AST-based shell-command permission scanning, a
plugin system, and a dozen provider integrations. This project keeps the *mechanisms* (permission evaluation,
compaction, subagent isolation, tool truncation) but skips the infrastructure scale-out — it's meant as a
readable, hackable starting point, not a drop-in replacement.
