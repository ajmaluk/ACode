/**
 * Dalam Skills system.
 *
 * Skills are markdown files with a YAML frontmatter:
 * ---
 * name: my-skill
 * description: A short tagline
 * ---
 *
 * The body is the prompt that gets injected when the skill is invoked.
 *
 * Skills are scanned from:
 *   - `.dalam/skills/<name>/SKILL.md` (project-level, highest priority)
 *   - BUNDLED_SKILLS (shipped with Dalam, lowest priority)
 */
import type { SkillInfo } from "@dalam/shared-types";
import { joinPath } from "@/lib/pathUtils";

// ---------------------------------------------------------------------------
// YAML frontmatter parser (lightweight, no external deps)
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Supports simple `key: value` pairs. Values can be quoted or unquoted.
 * Returns { frontmatter, body } where frontmatter is a record of parsed
 * key-value pairs and body is the markdown content after the closing `---`.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: raw };

  const fmBlock = match[1];
  const body = raw.slice(match[0].length).trimStart();
  const frontmatter: Record<string, string> = {};

  for (const line of fmBlock.split(/\r?\n/)) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip continuation lines (indented)
    if (line.match(/^\s+/)) continue;

    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    let value = kvMatch[2].trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Unescape escaped quotes and backslashes
    value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    frontmatter[kvMatch[1]] = value;
  }

  return { frontmatter, body };
}

/**
 * Validate and extract SkillInfo from parsed frontmatter + body.
 * Returns null if the frontmatter is missing required fields.
 */
export function skillInfoFromParsed(
  frontmatter: Record<string, string>,
  body: string,
  location: string,
  source: SkillInfo["source"],
): SkillInfo | null {
  const name = frontmatter.name?.trim();
  if (!name) return null; // name is required

  return {
    name,
    description: frontmatter.description?.trim() || name,
    content: body,
    location,
    source,
  };
}

// ---------------------------------------------------------------------------
// Skill Validation
// ---------------------------------------------------------------------------

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a SKILL.md file format.
 * Checks for required frontmatter fields, valid structure, and content quality.
 */
export function validateSkill(rawContent: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for frontmatter
  if (!rawContent.startsWith("---")) {
    errors.push("Missing YAML frontmatter (file must start with ---)");
    return { valid: false, errors, warnings };
  }

  const { frontmatter, body } = parseFrontmatter(rawContent);

  // Required fields
  if (!frontmatter.name?.trim()) {
    errors.push("Missing required field: name");
  } else if (frontmatter.name.length > 100) {
    warnings.push("Name is very long (>100 chars). Consider shortening.");
  }

  // Validate name format (alphanumeric, hyphens, underscores)
  if (frontmatter.name && !/^[a-zA-Z0-9_-]+$/.test(frontmatter.name)) {
    warnings.push(
      "Name contains special characters. Use only alphanumeric, hyphens, and underscores.",
    );
  }

  // Description validation
  if (!frontmatter.description?.trim()) {
    warnings.push(
      "Missing description field. Adding a description helps users understand the skill.",
    );
  } else if (frontmatter.description.length > 200) {
    warnings.push(
      "Description is very long (>200 chars). Consider shortening.",
    );
  }

  // Content validation
  if (!body.trim()) {
    errors.push(
      "Empty skill body. The skill must have content after the frontmatter.",
    );
  } else if (body.length < 50) {
    warnings.push(
      "Skill body is very short (<50 chars). Consider adding more detailed instructions.",
    );
  } else if (body.length > 10000) {
    warnings.push(
      "Skill body is very long (>10K chars). Consider breaking into multiple skills.",
    );
  }

  // Check for common issues
  if (body.includes("```") && (body.match(/```/g)?.length ?? 0) % 2 !== 0) {
    warnings.push(
      "Unclosed code fence detected. Check for matching opening/closing ```.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Dry-run a skill without executing it.
 * Parses and validates the skill, returns the prompt that would be injected.
 */
export function dryRunSkill(rawContent: string): {
  valid: boolean;
  prompt?: string;
  metadata?: Record<string, string>;
  errors: string[];
} {
  const validation = validateSkill(rawContent);
  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }

  const { frontmatter, body } = parseFrontmatter(rawContent);
  return {
    valid: true,
    prompt: body,
    metadata: frontmatter,
    errors: [],
  };
}

// ----------------------------------------------------------------------------
// Bundled skills — shipped with Dalam.
// ----------------------------------------------------------------------------

const SKILL_BODY_ACCESSIBILITY = `You are an accessibility auditor. Review the user's selected code against WCAG 2.1 AA standards.

For each issue you find, report:
1. **Severity** — blocker / serious / moderate / minor
2. **WCAG criterion** — e.g. "1.4.3 Contrast (Minimum)"
3. **Location** — file:line where the issue occurs
4. **Impact** — who is affected (screen reader users, low-vision, motor, etc.)
5. **Fix** — a concrete, runnable code change

Cover all four POUR principles: Perceivable, Operable, Understandable, Robust.
Prefer ARIA roles and semantic HTML over custom JS workarounds.`;

const SKILL_BODY_REFACTOR = `Analyze the selected code and propose refactors that improve readability and maintainability WITHOUT changing observable behavior.

Focus on:
- Naming (rename misleading identifiers)
- Function size (split functions > 40 lines)
- Duplication (extract repeated patterns)
- Coupling (reduce dependencies between modules)
- Magic values (extract named constants)
- Control flow (replace nested conditionals with early returns or polymorphism)

For each refactor:
1. Show the BEFORE (1-3 lines) and AFTER (1-3 lines)
2. Explain the benefit in 1 sentence
3. Flag any risk to behavior

Do NOT propose architectural rewrites unless the user explicitly asks.`;

const SKILL_BODY_EXPLAIN = `Explain the selected code in plain English, focusing on the "why" behind its design choices.

Cover:
- What it does (1-2 sentences)
- Why it's written this way (assumptions, constraints, trade-offs)
- How it fits in the larger system (callers, callees, side effects)
- Anything subtle or non-obvious (off-by-one, edge cases, race conditions)

Use simple language. Avoid jargon. Use analogies when helpful. Keep it under 200 words unless the code is genuinely complex.`;

const SKILL_BODY_TEST = `Write thorough unit tests for the provided function using the project's existing test framework.

If the framework is unknown, default to **Vitest** (works for both Vite and Node).

For each test:
1. Test the happy path
2. Test edge cases (empty, null, zero, max)
3. Test error conditions (throws, rejects)
4. Test boundary conditions (off-by-one)

Aim for 80%+ branch coverage. Mock external dependencies. Use descriptive test names (e.g. "rejects negative numbers" not "test1").`;

const SKILL_BODY_REVIEW = `Review the provided diff for correctness, security, and style.

Categorize each finding as **info**, **warn**, or **error**:
- **error**: must fix before merge (bugs, security issues, data loss)
- **warn**: should fix soon (perf, maintainability, test gaps)
- **info**: nice to have (naming, docs, polish)

For each finding:
1. **File:line** location
2. **Why it matters** (1 sentence)
3. **Suggested fix** (concrete code or steps)

Pay special attention to: SQL injection, XSS, race conditions, integer overflow, auth bypass, PII leakage, and unbounded loops.`;

const SKILL_BODY_DOCS = `Write clear, example-driven documentation for the selected API.

Produce:
1. **One-sentence summary** — what it does
2. **Signature** — TypeScript types for params and return
3. **Example** — minimal runnable usage (5-10 lines)
4. **Common pitfalls** — 2-3 things people get wrong
5. **Related APIs** — links to siblings

Update JSDoc/TSDoc comments AND any external docs (.md files) in the same change.`;

const SKILL_BODY_PERF = `Profile and optimize the selected code.

Workflow:
1. Identify the bottleneck (algorithmic complexity, I/O, allocations, sync vs async)
2. Measure before and after (use \`performance.now()\` or \`console.time\`)
3. Apply the optimization (cache, batch, lazy, parallel, native)
4. Verify the speedup and that behavior is unchanged

Prefer algorithmic improvements over micro-optimizations. Avoid premature optimization.`;

const SKILL_BODY_DEBUG = `Debug the failing test or reported issue.

Workflow:
1. Reproduce the bug with the smallest possible test case
2. Inspect the call stack, recent changes, and git log
3. Form 2-3 hypotheses about the root cause
4. Verify each hypothesis with a print/log/breakpoint
5. Fix the root cause (not the symptom)
6. Add a regression test
7. Verify the fix doesn't break other tests

Be methodical. Document your findings.`;

const SKILL_BODY_PLAN = `Create a detailed implementation plan for the user's request.

Structure:
1. **Goal** — restate what the user wants
2. **Constraints** — list non-negotiables (existing APIs, performance budget, etc.)
3. **Approach** — high-level strategy (1-3 paragraphs)
4. **Steps** — numbered list of concrete actions, each with:
   - Estimated effort (S/M/L)
   - Files to touch
   - Risks
5. **Test plan** — how you'll verify each step
6. **Rollout** — how to ship safely (feature flag, gradual, canary)

Do NOT write any code. The plan goes in \`.dalam/plans/\`.`;

export const BUNDLED_SKILLS: SkillInfo[] = [
  {
    name: "accessibility-compliance",
    description: "Audit code for WCAG 2.1 AA compliance",
    content: SKILL_BODY_ACCESSIBILITY,
    location: "bundled://accessibility-compliance/SKILL.md",
    source: "bundled",
  },
  {
    name: "refactor",
    description: "Suggest refactors for readability and maintainability",
    content: SKILL_BODY_REFACTOR,
    location: "bundled://refactor/SKILL.md",
    source: "bundled",
  },
  {
    name: "explain",
    description: "Explain code in plain English",
    content: SKILL_BODY_EXPLAIN,
    location: "bundled://explain/SKILL.md",
    source: "bundled",
  },
  {
    name: "test-writer",
    description: "Write unit tests for the given function",
    content: SKILL_BODY_TEST,
    location: "bundled://test-writer/SKILL.md",
    source: "bundled",
  },
  {
    name: "code-review",
    description: "Review changes for correctness and style",
    content: SKILL_BODY_REVIEW,
    location: "bundled://code-review/SKILL.md",
    source: "bundled",
  },
  {
    name: "docs-writer",
    description: "Write or update documentation",
    content: SKILL_BODY_DOCS,
    location: "bundled://docs-writer/SKILL.md",
    source: "bundled",
  },
  {
    name: "perf-audit",
    description: "Profile and optimize hot paths",
    content: SKILL_BODY_PERF,
    location: "bundled://perf-audit/SKILL.md",
    source: "bundled",
  },
  {
    name: "debug",
    description: "Debug a failing test or reported issue",
    content: SKILL_BODY_DEBUG,
    location: "bundled://debug/SKILL.md",
    source: "bundled",
  },
  {
    name: "plan",
    description: "Create a detailed implementation plan",
    content: SKILL_BODY_PLAN,
    location: "bundled://plan/SKILL.md",
    source: "bundled",
  },
];

// ----------------------------------------------------------------------------
// Skill registry (mutable so the UI can toggle / add / remove)
// ----------------------------------------------------------------------------

class SkillRegistry {
  private skills: Map<string, SkillInfo> = new Map();
  private backups: Map<string, { skill: SkillInfo; timestamp: number }[]> =
    new Map();
  private listeners = new Set<() => void>();
  private batchDepth = 0;

  constructor() {
    for (const s of BUNDLED_SKILLS) this.skills.set(s.name, s);
  }

  /** Suppress notifications during bulk operations. Emits once at the end. */
  batchUpdate(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.emit();
    }
  }

  /** Return every skill, sorted by name. */
  list(): SkillInfo[] {
    return Array.from(this.skills.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Return only skills the user has enabled (via Settings). */
  enabled(enabledNames: Set<string>): SkillInfo[] {
    return this.list().filter((s) => enabledNames.has(s.name));
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /**
   * Get backup history for a skill (most recent first).
   * Returns empty array if no backups exist.
   */
  getBackups(name: string): { skill: SkillInfo; timestamp: number }[] {
    return this.backups.get(name) ?? [];
  }

  /**
   * Restore a skill from backup by name and timestamp.
   * Returns the restored skill, or undefined if the backup was not found.
   */
  restoreFromBackup(name: string, timestamp: number): SkillInfo | undefined {
    const backups = this.backups.get(name);
    if (!backups) return undefined;
    const backup = backups.find((b) => b.timestamp === timestamp);
    if (!backup) return undefined;
    this.skills.set(name, backup.skill);
    this.emit();
    return backup.skill;
  }

  /**
   * Add a new skill (from a SKILL.md file or user import).
   * If a skill with the same name already exists, creates a timestamped backup
   * before overwriting. Keeps up to 10 backups per skill name.
   */
  add(skill: SkillInfo): void {
    const existing = this.skills.get(skill.name);
    if (existing) {
      // Create backup before overwrite
      if (!this.backups.has(skill.name)) {
        this.backups.set(skill.name, []);
      }
      const backupList = this.backups.get(skill.name)!;
      backupList.push({
        skill: { ...existing },
        timestamp: Date.now(),
      });
      // Keep only last 10 backups per skill to prevent unbounded growth
      if (backupList.length > 10) {
        backupList.splice(0, backupList.length - 10);
      }
    }
    this.skills.set(skill.name, skill);
    this.emit();
  }

  remove(name: string): void {
    this.skills.delete(name);
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    if (this.batchDepth > 0) return;
    for (const l of this.listeners) l();
  }
}

export const skillRegistry = new SkillRegistry();

// ---------------------------------------------------------------------------
// Project-level skill loading (from .dalam/skills/*/SKILL.md)
// ---------------------------------------------------------------------------

/**
 * Scan a directory for SKILL.md files and parse them into SkillInfo objects.
 * Each subdirectory of `skillsDir` is treated as a skill folder containing
 * a SKILL.md file with YAML frontmatter.
 *
 * Example layout:
 *   .dalam/skills/my-skill/SKILL.md
 *   .dalam/skills/another-skill/SKILL.md
 *
 * This is designed to be called from the Tauri backend via dalamAPI.fs.*
 * but since the renderer uses dynamic imports, we accept a filesystem
 * adapter that provides listDir and readFile.
 */
export async function loadSkillsFromDirectory(
  skillsDir: string,
  fsAdapter: {
    listDir: (
      path: string,
    ) => Promise<{ name: string; path: string; type: string }[]>;
    readFile: (path: string) => Promise<string>;
  },
  source: SkillInfo["source"],
): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  try {
    const entries = await fsAdapter.listDir(skillsDir);
    for (const entry of entries) {
      if (entry.type !== "directory") continue;

      const skillMdPath = joinPath(entry.path, "SKILL.md");
      try {
        const raw = await fsAdapter.readFile(skillMdPath);
        const { frontmatter } = parseFrontmatter(raw);
        // Progressive disclosure: store metadata only, load content on demand
        const info = skillInfoFromParsed(frontmatter, "", skillMdPath, source);
        if (info) skills.push(info);
      } catch (err) {
        console.warn("[Skills] Failed to parse skill:", err);
      }
    }
  } catch (err) {
    console.warn("[Skills] Failed to parse skill:", err);
  }

  return skills;
}

/**
 * Load project-level skills from .dalam/skills/ in the workspace.
 * Called during workspace init to populate the skill registry.
 */
export async function loadProjectSkills(
  workspacePath: string,
  fsAdapter: {
    listDir: (
      path: string,
    ) => Promise<{ name: string; path: string; type: string }[]>;
    readFile: (path: string) => Promise<string>;
  },
): Promise<SkillInfo[]> {
  const skillsDir = joinPath(workspacePath, ".dalam", "skills");
  return loadSkillsFromDirectory(skillsDir, fsAdapter, "project");
}

/**
 * Refresh the skill registry with project-level skills.
 * Removes any previously loaded project skills and re-adds from disk.
 * Project skills override bundled skills with the same name.
 */
export function refreshProjectSkills(
  projectSkills: SkillInfo[],
  registry: SkillRegistry = skillRegistry,
): void {
  registry.batchUpdate(() => {
    // Remove all existing project-level skills
    for (const existing of registry.list()) {
      if (existing.source === "project") {
        registry.remove(existing.name);
      }
    }
    // Re-register bundled skills that were shadowed by removed project skills
    for (const bs of BUNDLED_SKILLS) {
      if (!registry.get(bs.name)) registry.add(bs);
    }
    // Add the freshly loaded project skills (overrides bundled if same name)
    for (const skill of projectSkills) {
      registry.add(skill);
    }
  });
}

/**
 * Load the full content of a skill from disk (progressive disclosure).
 * If the skill already has content loaded, returns it immediately.
 * Otherwise reads the SKILL.md file from the skill's location.
 */
export async function loadSkillContent(
  skill: SkillInfo,
  fsAdapter?: {
    readFile: (path: string) => Promise<string>;
  },
  registry: SkillRegistry = skillRegistry,
): Promise<string> {
  // Already loaded (bundled skills always have content)
  if (skill.content) return skill.content;
  // Can't load without adapter or non-file location
  if (
    !fsAdapter ||
    !skill.location ||
    skill.location.startsWith("bundled://")
  ) {
    return skill.content || "";
  }
  try {
    const raw = await fsAdapter.readFile(skill.location);
    const { body } = parseFrontmatter(raw);
    // Cache the loaded content back into the registry so subsequent
    // invocations don't re-read from disk.
    const registered = registry.get(skill.name);
    if (registered) registered.content = body;
    skill.content = body;
    return body;
  } catch (e) {
    console.warn(`Failed to load skill content from ${skill.location}:`, e);
    return "";
  }
}

/**
 * Render the body of a skill into a system-prompt fragment. Mirrors how
 * Dalam injects skills — the description goes into the agent's prompt
 * and the content becomes available on demand.
 */
export function renderSkillForPrompt(skill: SkillInfo): string {
  return `\n\n# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.content}\n`;
}

/**
 * Match a "$skill-name args…" reference from a chat prompt to a loaded
 * skill. Returns the skill and the trailing args, or null if not found.
 */
export function matchSkillInvocation(
  text: string,
  registry: SkillInfo[],
): { skill: SkillInfo; args: string } | null {
  // First try explicit $skill-name invocation
  const m = text.match(
    /(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?:[ \t]+([^\n]+))?(?=[\s,.;:!?)}\]]|$)/i,
  );
  if (m) {
    const name = m[1].toLowerCase();
    const args = (m[2] ?? "").trim();
    const skill = registry.find((s) => s.name.toLowerCase() === name);
    if (skill) return { skill, args };
  }

  // Fallback: only match skill name as a whole word if the prompt is short
  // enough to look like a direct invocation (≤6 words). This prevents
  // false positives on common words like "explain", "plan", "debug".
  const words = text.trim().split(/\s+/);
  if (words.length > 6) return null;

  const lowerText = text.toLowerCase();
  // Sort by name length descending so "code-review" matches before "code"
  const sorted = [...registry].sort((a, b) => b.name.length - a.name.length);
  for (const skill of sorted) {
    const skillName = skill.name.toLowerCase();
    // Match skill name as a whole word (with optional trailing args)
    // Use word boundary assertions to prevent partial matches
    const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRegex = new RegExp(`(?:^|\\b)${escapedName}\\b`, "i");
    if (wordRegex.test(lowerText)) {
      // Extract everything after the skill name as args
      const match = lowerText.match(new RegExp(`${escapedName}\\s+(.*)`, "i"));
      const args = match?.[1]?.trim() ?? "";
      return { skill, args };
    }
  }

  return null;
}
