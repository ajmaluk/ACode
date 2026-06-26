# Dalam

**AI-Native IDE / Agentic Development Environment**

Dalam is a desktop IDE built with [Tauri](https://tauri.app/), React, and TypeScript. It integrates an AI coding assistant directly into your development workflow with streaming responses, tool execution, memory systems, and a self-evolving skill architecture.

## Features

- **AI Chat & Agent Loop** — Multi-turn conversation with streaming LLM responses (OpenAI & Anthropic). The agent can read, write, edit, search, and execute commands in your workspace.
- **Multi-Tab Terminal** — Persistent terminal instances with shell integration (zsh, bash, powershell, cmd).
- **Monaco Editor** — Full-featured code editor with syntax highlighting, diff viewer, and breadcrumb navigation.
- **File Explorer** — Sidebar tree view with git status indicators (modified, added, deleted, untracked).
- **Workspace Memory** — Persistent workspace memory via SQLite + FTS5. The AI remembers rules, key files, and learned preferences across sessions.
- **Skill System** — Bundled and project-level skills (markdown prompt files) that extend the agent's capabilities. Skills can be auto-crystallized from session transcripts.
- **Gene System** — Self-evolving agent intelligence that adapts behavior based on conversation patterns.
- **Dream Agent** — Background memory consolidation and skill deduplication during idle time.
- **MCP Server Support** — Connect external tool servers via stdio or HTTP transports.
- **Task Plan Checklist** — Visual task tracking with progress indicators for multi-step operations.
- **Real-Time Activity UI** — Live streaming of agent thinking, tool calls, and exploration status.
- **Diff Proposals** — Review and approve file changes before they're written to disk.
- **Git Integration** — Status, commit, log, branch management, and file diff viewing.
- **4-Layer Instructions** — Hierarchical rule system: Global → Organization → Project → Local (with legacy `.cursorrules` fallback).
- **Command Palette** — Quick access to files, commands, and settings via `Cmd+K`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | [Tauri v2](https://tauri.app/) (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Styling | Tailwind CSS |
| Editor | Monaco Editor |
| Terminal | xterm.js |
| State Management | Zustand |
| Database | SQLite via `@tauri-apps/plugin-sql` |
| Package Manager | pnpm |

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
│       │   │   ├── components/  # UI components
│       │   │   ├── lib/         # Core logic (API, agents, skills, memory)
│       │   │   └── store/       # Zustand state stores
│       │   └── tauri/         # Rust backend
│       │       └── src/         # Tauri commands (git, clipboard, system)
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
├── skills/          # Project-level skills
├── memories/        # Markdown memory files
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

## License

MIT — see [LICENSE](LICENSE).Dalam's agent runtime is forked from [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)
by Xiaomi Corporation, itself a fork of OpenCode. See [ATTRIBUTION.md](ATTRIBUTION.md) for details.
