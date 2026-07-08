/**
 * Dalam Instructions system — 4-layer hierarchy.
 *
 * Instructions are loaded from multiple locations, merged in priority order
 * (lowest to highest):
 *
 *   1. Global   — <homeDir>/.dalam/DALAM.md (user-level, all projects)
 *   2. Project  — <workspace>/DALAM.md (project root, checked in)
 *   3. Local    — <workspace>/.dalam/local/DALAM.md (user-specific, gitignored)
 *   4. Path-scoped — Inline @path: <glob> blocks within any layer
 *
 * Legacy fallback (backwards compat): .cursorrules, .agentrules, .dalam/rules.md
 *
 * Path-scoped rules use this syntax inside any DALAM.md:
 *
 *   @path: src/components/<name>.tsx
 *   - Use functional components with hooks
 *   - Name files PascalCase
 *
 *   @path: <name>.test.ts
 *   - Always use vitest
 *   - Mock external dependencies
 *
 * Rules outside any @path block are global (apply to all files).
 */
import { joinPath } from "@/lib/pathUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstructionLayer = "global" | "org" | "project" | "local";

export interface LoadedInstructions {
  /** The merged global rules (all files) */
  globalRules: string;
  /** Path-scoped rules indexed by glob pattern */
  pathScopedRules: Map<string, string>;
  /** Metadata about which files were loaded */
  loadedPaths: string[];
  /** Raw content from each layer, keyed by layer name */
  layers: Record<InstructionLayer, string>;
}

export interface InstructionFsAdapter {
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  getHomeDir?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Path-scoped rule parser
// ---------------------------------------------------------------------------

/**
 * Parse a rules file into global rules and path-scoped rules.
 *
 * Syntax:
 *   @path: <glob>
 *   - rule 1
 *   - rule 2
 *
 * Rules before any @path block are global.
 * Multiple @path blocks can appear; each applies to its glob.
 */
export function parsePathScopedRules(
  content: string
): { globalRules: string; pathScopedRules: Map<string, string> } {
  const lines = content.split(/\r?\n/);
  const globalLines: string[] = [];
  const pathScopedRules = new Map<string, string>();
  let currentGlob: string | null = null;
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (currentGlob && currentBlock.length > 0) {
      const existing = pathScopedRules.get(currentGlob);
      const block = currentBlock.join("\n").trim();
      pathScopedRules.set(
        currentGlob,
        existing ? existing + "\n" + block : block
      );
    }
    currentBlock = [];
  };

  for (const line of lines) {
    const pathMatch = line.match(/^@path:\s+(.+?)\s*$/);
    if (pathMatch) {
      flushBlock();
      currentGlob = pathMatch[1];
      continue;
    }

    if (currentGlob) {
      currentBlock.push(line);
    } else {
      globalLines.push(line);
    }
  }

  flushBlock();

  return {
    globalRules: globalLines.join("\n").trim(),
    pathScopedRules,
  };
}

// ---------------------------------------------------------------------------
// Layer loading
// ---------------------------------------------------------------------------

// Cache for loaded instructions per workspace path (avoids disk I/O on every LLM turn)
const _instructionCache = new Map<string, { instructions: LoadedInstructions; timestamp: number }>();
const INSTRUCTION_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Load instructions from the 4-layer hierarchy.
 *
 * Priority (higher overrides lower for global rules):
 *   global < project < local
 *
 * Path-scoped rules from ALL layers are merged by glob pattern,
 * with higher-priority layers appending to the same glob.
 *
 * Results are cached for 30 seconds to avoid repeated disk I/O
 * during multi-turn agent loops.
 */
export async function loadInstructions(
  workspacePath: string,
  fsAdapter: InstructionFsAdapter
): Promise<LoadedInstructions> {
  // Check cache first
  const cached = _instructionCache.get(workspacePath);
  if (cached && Date.now() - cached.timestamp < INSTRUCTION_CACHE_TTL_MS) {
    return cached.instructions;
  }

  const loadedPaths: string[] = [];
  const layers: Record<InstructionLayer, string> = {
    global: "",
    org: "",
    project: "",
    local: "",
  };

  // --- Layer 1: Global (~/.dalam/DALAM.md) ---
  if (fsAdapter.getHomeDir) {
    try {
      const homeDir = await fsAdapter.getHomeDir();
      const globalPath = joinPath(homeDir, ".dalam", "DALAM.md");
      if (await fsAdapter.exists(globalPath)) {
        layers.global = await fsAdapter.readFile(globalPath);
        loadedPaths.push(globalPath);
      }
    } catch {
      // Global dir may not exist — not an error
    }
  }

  // --- Layer 2: Org ({workspace}/.dalam/org/DALAM.md) ---
  try {
    const orgPath = joinPath(workspacePath, ".dalam", "org", "DALAM.md");
    if (await fsAdapter.exists(orgPath)) {
      layers.org = await fsAdapter.readFile(orgPath);
      loadedPaths.push(orgPath);
    }
  } catch {
    // Not an error if org DALAM.md doesn't exist
  }

  // --- Layer 3: Project ({workspace}/DALAM.md) ---
  try {
    const projectPath = joinPath(workspacePath, "DALAM.md");
    if (await fsAdapter.exists(projectPath)) {
      layers.project = await fsAdapter.readFile(projectPath);
      loadedPaths.push(projectPath);
    }
  } catch {
    // Not an error if project DALAM.md doesn't exist
  }

  // --- Layer 3b: Legacy fallback ---
  // If no project DALAM.md, check legacy rule files for backwards compat
  if (!layers.project) {
    try {
      const legacyPaths = [
        joinPath(workspacePath, ".cursorrules"),
        joinPath(workspacePath, ".agentrules"),
        joinPath(workspacePath, ".dalam", "rules.md"),
      ];
      for (const legacyPath of legacyPaths) {
        if (await fsAdapter.exists(legacyPath)) {
          layers.project = await fsAdapter.readFile(legacyPath);
          loadedPaths.push(legacyPath);
          break; // first match wins
        }
      }
    } catch {
      // Not an error
    }
  }

  // --- Layer 4: Local ({workspace}/.dalam/local/DALAM.md) ---
  try {
    const localPath = joinPath(workspacePath, ".dalam", "local", "DALAM.md");
    if (await fsAdapter.exists(localPath)) {
      layers.local = await fsAdapter.readFile(localPath);
      loadedPaths.push(localPath);
    }
  } catch {
    // Not an error
  }

  // --- Merge layers ---
  const result = mergeLayers(layers, loadedPaths);

  // Cache the result
  _instructionCache.set(workspacePath, { instructions: result, timestamp: Date.now() });

  return result;
}

/**
 * Clear the instruction cache for a workspace.
 * Call when DALAM.md files are modified.
 */
export function clearInstructionCache(workspacePath?: string): void {
  if (workspacePath) {
    _instructionCache.delete(workspacePath);
  } else {
    _instructionCache.clear();
  }
}

/**
 * Merge instruction layers into a single LoadedInstructions.
 * Higher-priority layers override/extend lower ones.
 */
function mergeLayers(
  layers: Record<InstructionLayer, string>,
  loadedPaths: string[]
): LoadedInstructions {
  // Parse path-scoped rules from each layer
  const allPathScoped = new Map<string, string>();
  const globalParts: string[] = [];

  // Process in priority order: global → project → local
  const order: InstructionLayer[] = ["global", "org", "project", "local"];
  for (const layer of order) {
    const content = layers[layer];
    if (!content) continue;

    const parsed = parsePathScopedRules(content);

    if (parsed.globalRules) {
      globalParts.push(parsed.globalRules);
    }

    // Merge path-scoped rules: higher layers append to same glob
    for (const [glob, rules] of parsed.pathScopedRules) {
      const existing = allPathScoped.get(glob);
      allPathScoped.set(
        glob,
        existing ? existing + "\n" + rules : rules
      );
    }
  }

  return {
    globalRules: globalParts.join("\n\n").trim(),
    pathScopedRules: allPathScoped,
    loadedPaths,
    layers,
  };
}

// ---------------------------------------------------------------------------
// Formatting for system prompt injection
// ---------------------------------------------------------------------------

/**
 * Format loaded instructions into a system prompt block.
 * Includes both global rules and applicable path-scoped rules.
 *
 * @param instructions - The loaded instructions
 * @param activeFilePath - Optional: the currently active file path.
 *   If provided, path-scoped rules whose glob matches this file are included.
 */
export function formatInstructionsForPrompt(
  instructions: LoadedInstructions,
  activeFilePath?: string
): string {
  const parts: string[] = [];

  // Global rules
  if (instructions.globalRules) {
    parts.push(instructions.globalRules);
  }

  // Path-scoped rules for the active file
  if (activeFilePath && instructions.pathScopedRules.size > 0) {
    const matchingRules: string[] = [];
    for (const [glob, rules] of instructions.pathScopedRules) {
      if (matchGlob(glob, activeFilePath)) {
        matchingRules.push(rules);
      }
    }
    if (matchingRules.length > 0) {
      parts.push(matchingRules.join("\n\n"));
    }
  }

  if (parts.length === 0) return "";

  return (
    `\n\n=== WORKSPACE INSTRUCTIONS ===\n` +
    `The following rules and conventions apply to this project. ` +
    `Follow them when writing, editing, or reviewing code.\n\n` +
    parts.join("\n\n") +
    `\n================================`
  );
}

/**
 * List all path-scoped rule globs (for UI display / diagnostics).
 */
export function listPathScopedGlobs(
  instructions: LoadedInstructions
): string[] {
  return Array.from(instructions.pathScopedRules.keys());
}

// ---------------------------------------------------------------------------
// Simple glob matching (for path-scoped rules)
// Supports: *, **, and file extension patterns
// ---------------------------------------------------------------------------

function matchGlob(glob: string, filePath: string): boolean {
  // Normalize separators
  const normalizedGlob = glob.replace(/\\/g, "/");
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Pre-expand brace patterns {a,b,c} into alternation
  const expandedGlobs = expandBraces(normalizedGlob);
  return expandedGlobs.some(g => matchSingleGlob(g, normalizedPath));
}

function expandBraces(glob: string): string[] {
  const braceStart = glob.indexOf("{");
  if (braceStart === -1) return [glob];

  const braceEnd = glob.indexOf("}", braceStart);
  if (braceEnd === -1) return [glob];

  const prefix = glob.slice(0, braceStart);
  const suffix = glob.slice(braceEnd + 1);
  const alternatives = glob.slice(braceStart + 1, braceEnd).split(",");

  const results: string[] = [];
  for (const alt of alternatives) {
    const expanded = expandBraces(prefix + alt.trim() + suffix);
    results.push(...expanded);
  }
  return results;
}

function matchSingleGlob(normalizedGlob: string, normalizedPath: string): boolean {
  if (!normalizedGlob || !normalizedPath) return false;

  // Step 1: Use unique placeholders for glob wildcards to prevent subsequent replacement clashes
  let regexStr = normalizedGlob
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "__STAR__")
    .replace(/\?/g, "__QUESTION__");

  // Step 2: Escape standard regex special characters
  regexStr = regexStr.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Step 3: Replace placeholders with their regex equivalents
  regexStr = regexStr
    .replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/__STAR__/g, "[^/]*")
    .replace(/__QUESTION__/g, "[^/]");

  // Step 4: Anchor the regex
  // If the glob does not contain any slashes (e.g. "*.test.ts"), it matches
  // any file with that name in any directory (like gitignore).
  // Otherwise, it must match the path from the root.
  if (!normalizedGlob.includes("/")) {
    regexStr = "(^|/)" + regexStr + "$";
  } else {
    // If it starts with a slash, strip it since normalizedPath typically doesn't start with a slash
    if (regexStr.startsWith("/")) {
      regexStr = "^" + regexStr.slice(1) + "$";
    } else {
      regexStr = "^" + regexStr + "$";
    }
  }

  try {
    const regex = new RegExp(regexStr);
    return regex.test(normalizedPath);
  } catch {
    return false;
  }
}
