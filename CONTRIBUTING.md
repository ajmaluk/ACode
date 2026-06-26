# Contributing to Dalam

Thanks for your interest in contributing to Dalam! This guide will help you get set up and familiar with the project.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77
- [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Getting Started

```bash
# Clone the repository
git clone <repo-url>
cd Dalam

# Install dependencies
pnpm install

# Start the renderer dev server (no Rust backend needed)
pnpm dev

# Start full Tauri dev mode (with Rust backend)
pnpm tauri:dev
```

## Project Layout

Dalam is a monorepo managed by [Turborepo](https://turbo.build/) with pnpm workspaces.

| Package | Path | Description |
|---------|------|-------------|
| `@dalam/desktop` | `apps/desktop/` | Tauri desktop app (React + Rust) |
| `@dalam/shared-types` | `packages/shared-types/` | TypeScript types for the IPC surface |

### Renderer (`apps/desktop/src/renderer/`)

- `components/` — React UI components (editor, sidebar, terminal, chat, settings, etc.)
- `lib/` — Core logic modules:
  - `dalamAPI.ts` — The IPC bridge implementation (mock API for renderer)
  - `agents.ts` — Agent definitions and permission system
  - `skills.ts` — Skill loading and invocation
  - `contextManager.ts` — Context window management
  - `memoryStore.ts` — SQLite + markdown hybrid memory
  - `instructions.ts` — 4-layer instruction hierarchy
  - `dreamAgent.ts` — Background memory consolidation
  - `genes.ts` — Self-evolving agent intelligence
  - `hookBus.ts` — Lifecycle event bus
- `store/` — Zustand state stores (`useAppStore.ts`)
- `index.css` — Global styles and prose-dalam theme

### Tauri Backend (`apps/desktop/src-tauri/src/`)

Rust commands for git operations, clipboard, system info, file reveal, and process management.

### Shared Types (`packages/shared-types/src/`)

All TypeScript interfaces and types shared between the renderer and backend (e.g., `DalamAPI`, `ChatMessage`, `StreamEvent`, `AgentInfo`).

## Code Conventions

- **TypeScript strict mode** — The project uses `strict: true` in tsconfig.
- **No `any` types** — Prefer proper typing. Use `unknown` if the type is truly unknown.
- **Import paths** — Use `@/` alias for renderer imports (e.g., `import { ensureDalamAPI } from "@/lib/dalamAPI"`).
- **Tailwind classes** — Use the `dalam-*` color namespace (e.g., `bg-dalam-bg-primary`, `text-dalam-text-primary`).
- **Component style** — Functional components with hooks. No class components.
- **State management** — Zustand stores in `store/`. Use selector patterns to avoid unnecessary re-renders.

## Scripts

```bash
pnpm dev              # Start Vite dev server
pnpm build            # Build renderer (tsc + vite)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm typecheck        # TypeScript type checking
pnpm lint             # ESLint on renderer source
pnpm lint:fix         # Auto-fix lint issues
pnpm tauri:dev        # Full Tauri dev mode
pnpm tauri:build      # Production build
```

## Testing

Tests live alongside source files as `*.test.ts` and in `__tests__/` directories. The test framework is [Vitest](https://vitest.dev/).

```bash
pnpm test             # Run all tests
pnpm test:watch       # Watch mode
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes following the conventions above
3. Run `pnpm typecheck` and `pnpm test` to verify
4. Run `pnpm lint` and fix any issues
5. Submit your pull request with a clear description

## Architecture Notes

### Agent System

Dalam uses a multi-agent architecture inspired by MiMo-Code. Each agent has:
- A **permission ruleset** controlling what tools it can access
- A **category** (build, plan, explore, etc.) determining its role
- A **mode** (primary, subagent, or all)

Primary agents (`build`, `plan`, `yolo`) are user-selectable. The agent loop handles streaming, tool execution, and permission approval.

### Skill System

Skills are markdown files with YAML frontmatter stored in `.dalam/skills/`. They're loaded at runtime and injected into the agent's system prompt when invoked. Skills can be:
- **Bundled** — shipped with Dalam
- **Project-level** — stored in `.dalam/skills/`
- **User-global** — stored in `~/.dalam/skills/`

### Memory System

Dalam maintains a hybrid memory system:
- **SQLite + FTS5** — Full-text search over structured memory entries
- **Markdown files** — Git-friendly source of truth in `.dalam/memories/`
- **Workspace memory** — JSON-based quick-access memory in `.dalam/memory.json`

## License

MIT — see [LICENSE](LICENSE).
