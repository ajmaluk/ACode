# Dalam

**AI-Native IDE / Agentic Development Environment**

Dalam is a desktop IDE built with [Tauri](https://tauri.app/ v2), React 19, and TypeScript. It integrates an AI coding assistant directly into your development workflow with streaming responses, tool execution, memory systems, and a self-evolving skill architecture.

**Current Status:** 1,014 tests passing, 0 TypeScript errors, 31 test files

## Features

- **AI Chat & Agent Loop** — Multi-turn conversation with streaming LLM responses (OpenAI & Anthropic). The agent can read, write, edit, search, and execute commands in your workspace. 11-phase state machine enforces correct tool lifecycle (streaming → approval → execution → results → retry/timeout).
- **Undo Change Stack** — `/undo` reverts the last file change (LIFO stack, 50-entry cap). Two-phase undo: file-level revert via change stack, then message-level fallback.
- **Cost Tracking** — Per-session token count and cost tracking for OpenAI and Anthropic models (configurable pricing). `/cost` command shows detailed per-model breakdown. Live display in chat header.
- **Error Recovery** — 20+ error pattern matchers with auto-fix suggestions (missing modules, type errors, Python/Rust/Go errors, network issues).
- **Multi-Tab Terminal** — Persistent terminal instances with shell integration (zsh, bash, powershell, cmd, fish).
- **Monaco Editor** — Full-featured code editor with syntax highlighting, diff viewer, breadcrumb navigation, and find/replace.
- **File Explorer** — Sidebar tree view with git status indicators (modified, added, deleted, untracked).
- **Workspace Memory** — Persistent workspace memory via SQLite + FTS5 full-text search. The AI remembers rules, key files, and learned preferences across sessions. Hybrid markdown/SQLite architecture.
- **Skill System** — Bundled, project-level, and user-global skills (markdown prompt files with YAML frontmatter) that extend the agent's capabilities. Skills can be auto-crystallized from session transcripts.
- **Gene System** — Self-evolving agent intelligence that adapts behavior based on conversation patterns. Genes observe → validate → solidify → express new behaviors.
- **Dream Agent** — Background memory consolidation and skill deduplication during idle time. Runs phased lifecycle: purge → validate → rescore → dedup → consolidate.
- **MCP Server Support** — Connect external tool servers via stdio or HTTP transports (JSON-RPC protocol).
- **Task Plan Checklist** — Visual task tracking with progress indicators for multi-step operations.
- **Real-Time Activity UI** — Live streaming of agent thinking, tool calls, exploration status, bash output, and plan progress.
- **Diff Proposals** — Review and approve file changes before they're written to disk. Tracks pending diffs with `streaming-pending-diffs` phase.
- **Git Integration** — Status, commit, log, branch management, file diff viewing, and creation.
- **4-Layer Instructions** — Hierarchical rule system: Global → Organization → Project → Local (with legacy `.cursorrules`/`.agentrules` fallback). Path-scoped rules via `@path: <glob>` syntax.
- **Command Palette** — Quick access to files, commands, and settings via `Cmd+K`.
- **Regex Caching** — Pre-compiled regex cache prevents ReDoS and speeds up verification commands.
- **Cancellation Token** — Cooperative cancellation primitive for clean abort of async operations.
- **Auto-Update** — Checks for and installs updates via `tauri-plugin-updater` on supported platforms.
- **Permission System** — Granular tool-level permissions with allow/deny/ask modes and always-allow rules.
- **40+ Tool Schemas** — Zod-validated tool arguments with path traversal protection, dangerous command detection, and URL validation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | [Tauri v2](https://tauri.app/) (Rust backend) |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS |
| Editor | Monaco Editor |
| Terminal | xterm.js |
| State Management | Zustand |
| Database | SQLite via `@tauri-apps/plugin-sql`, FTS5 full-text search |
| Tokenization | js-tiktoken (real BPE tokenizer for OpenAI models) |
| Validation | Zod (40+ tool schemas with security checks) |
| Package Manager | pnpm (Turborepo monorepo) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77
- [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
# Install dependencies
pnpm install

# Start the dev server (renderer only)
pnpm dev

# Start Tauri in dev mode (with Rust backend)
pnpm tauri:dev
```

### Build

```bash
pnpm tauri:build
```

The built application will be in `apps/desktop/src-tauri/target/release/bundle/`.

## Project Structure

```
Dalam/
├── apps/
│   └── desktop/               # Tauri desktop application
│       ├── src/
│       │   ├── renderer/      # React frontend
│       │   │   ├── components/  # UI components (editor, sidebar, terminal, chat, settings)
│       │   │   ├── lib/         # Core logic (dalamAPI, agents, skills, memory, state machine)
│       │   │   └── store/       # Zustand state stores (useAppStore — 5,564 lines)
│       │   └── tauri/         # Rust backend
│       │       └── src/         # Tauri commands (git, clipboard, system — 1,404 lines)
│       └── package.json
├── packages/
│   └── shared-types/          # Shared TypeScript types for IPC
└── package.json
```

## Configuration

Dalam stores workspace configuration in a `.dalam/` directory at your project root:

```
.dalam/
├── DALAM.md         # Project-level instructions (checked in)
├── local/
│   └── DALAM.md     # Local overrides (gitignored)
├── org/
│   └── DALAM.md     # Organization-level instructions
├── skills/          # Project-level skills (auto-crystallized)
├── memories/        # Markdown memory files (source of truth)
├── plans/           # AI-generated plans
├── memory.json      # Workspace memory state
├── context.json     # Pinned files and context
├── project.db       # SQLite database (FTS5 search)
└── config.json      # Project-level config
```

Global configuration lives at `~/.dalam/`.

## LLM Provider Setup

Dalam works with any OpenAI-compatible API or Anthropic API:

1. Open **Settings** (`Cmd+,`)
2. Add a provider with your base URL and API key
3. Select a model from the dropdown
4. Start chatting

Supported formats: `openai`, `anthropic`

## Test Suite

```bash
pnpm test              # Run all tests (vitest) — 1,014 tests, 31 files
pnpm test:watch        # Watch mode
pnpm typecheck         # TypeScript checking — 0 errors
pnpm lint              # ESLint on renderer source
```

### Test Coverage (Lib Modules + Stores)

| Module | Tests | Coverage |
|--------|-------|----------|
| Agent runtime contract | 18 tests | State machine, phases, invariants |
| Tool schemas | 45 tests | All 40+ schemas, security, dangerous commands |
| Error patterns | 22 tests | 20+ error matchers with auto-fix |
| Platform detection | 22 tests | macOS/Windows/Linux, shortcuts, command wrapping |
| Security | 20 tests | Private host, SSRF, audit logging |
| Instructions | 18 tests | 4-layer loading, parsing, glob matching |
| Tokenizer | 15 tests | Token counting, message overhead, budget |
| Cost tracker | 15 tests | Token parsing, cost calculation, pricing |
| Change stack | 12 tests | LIFO undo, peek, clear, capping |
| Safety timer | 12 tests | Timeout creation, clearance, handler |
| **dalamAPI** | **22 tests** | ProviderError, getRecentFiles, getActiveProvider, corsFetch, createDalamAPI |
| **useAppStore** | **59 tests** | stripXmlToolCallTags, parseXmlToolCalls, useGit, useCommandPalette |

## License

MIT — see [LICENSE](LICENSE).

Dalam's agent runtime is forked from [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) by Xiaomi Corporation, itself a fork of OpenCode. See [ATTRIBUTION.md](ATTRIBUTION.md) for details.
