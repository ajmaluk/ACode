/**
 * Model Router — routes prompts to the appropriate model based on task complexity.
 *
 * Supports three tiers:
 * - simple: quick lookups, simple questions, formatting
 * - complex: architecture, debugging, multi-file changes
 * - code: code generation, refactoring, testing
 */

import type { ModelProfile } from "@dalam/shared-types";

export type TaskComplexity = "simple" | "code" | "complex";

// Re-export for backward compatibility
export type { ModelProfile };

/** Keywords that indicate simple tasks (quick questions, formatting, etc.) */
const SIMPLE_KEYWORDS = [
  "what is", "what are", "how do", "how to", "explain", "define",
  "format", "lint", "fix formatting", "sort", "rename",
  "list", "show", "print", "display", "read",
  "yes", "no", "ok", "sure", "thanks",
  "help", "continue", "next", "skip",
];

/** Keywords that indicate complex tasks (architecture, debugging, etc.) */
const COMPLEX_KEYWORDS = [
  "refactor", "architect", "design", "plan", "strategy",
  "debug", "investigate", "analyze", "trace", "profile",
  "optimize", "performance", "scale", "migrate",
  "security", "audit", "vulnerability",
  "explain why", "root cause", "trade-off", "compare",
  "review", "improve", "rewrite",
];

/** Keywords that indicate code generation tasks */
const CODE_KEYWORDS = [
  "write", "create", "implement", "add", "build", "generate",
  "function", "class", "component", "module", "file",
  "test", "spec", "mock", "fixture",
  "import", "export", "interface", "type",
  "fix bug", "fix error", "fix issue", "patch",
  "edit", "modify", "update", "change",
];

/**
 * Classify the complexity of a user prompt.
 */
export function classifyPromptComplexity(prompt: string): TaskComplexity {
  const lower = prompt.toLowerCase();
  const words = lower.split(/\s+/);
  const wordCount = words.length;

  // Very short prompts are usually simple
  if (wordCount <= 5) return "simple";

  // Count keyword matches per category
  let simpleScore = 0;
  let complexScore = 0;
  let codeScore = 0;

  for (const kw of SIMPLE_KEYWORDS) {
    if (lower.includes(kw)) simpleScore++;
  }
  for (const kw of COMPLEX_KEYWORDS) {
    if (lower.includes(kw)) complexScore++;
  }
  for (const kw of CODE_KEYWORDS) {
    if (lower.includes(kw)) codeScore++;
  }

  // Code blocks or file paths suggest code tasks
  if (lower.includes("```") || lower.includes("function ") || lower.includes("class ")) {
    codeScore += 2;
  }

  // Long prompts with multiple sentences tend to be complex
  if (wordCount > 50) complexScore += 1;
  if (wordCount > 100) complexScore += 2;

  // Questions ending with ? tend to be simple
  if (prompt.trim().endsWith("?") && wordCount < 20) simpleScore += 2;

  // Select highest scoring category
  const max = Math.max(simpleScore, complexScore, codeScore);
  if (max === 0) return "code"; // Default to code for a coding assistant
  if (simpleScore === max) return "simple";
  if (complexScore === max) return "complex";
  return "code";
}

/**
 * Select the best model for a given prompt based on configured profiles.
 * Falls back to the default model if no profile matches.
 */
export function selectModelForPrompt(
  prompt: string,
  profiles: ModelProfile[],
  defaultModelId: string,
): { modelId: string; providerId: string; complexity: TaskComplexity } {
  const complexity = classifyPromptComplexity(prompt);

  // Find enabled profiles that cover this complexity tier
  const matching = profiles.filter(
    (p) => p.enabled && p.useFor.includes(complexity),
  );

  if (matching.length === 0) {
    return { modelId: defaultModelId, providerId: "", complexity };
  }

  // Pick the first matching profile (user can order by priority)
  const selected = matching[0];
  return {
    modelId: selected.modelId,
    providerId: selected.providerId,
    complexity,
  };
}
