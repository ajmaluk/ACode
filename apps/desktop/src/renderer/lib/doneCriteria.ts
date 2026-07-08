/**
 * ============================================================
 * DALAM DONE CRITERIA — Completion Verification Schema
 * ============================================================
 *
 * Defines a "done criteria" object that captures what constitutes
 * completion for a given task. Used by the verify → execute →
 * finalize pipeline to deterministically check if work is done.
 *
 * The agent is expected to output a done criteria object for
 * each task, which the system then verifies after execution.
 * ============================================================
 */

export interface DoneCriteria {
  /** Expected files that should be changed/created */
  expectedFiles: ExpectedFileChange[];
  /** Acceptance commands to run (e.g., typecheck, lint, test) */
  verificationCommands: VerificationCommand[];
  /** Required properties that the diffs must satisfy */
  requiredDiffProperties: DiffRequirement[];
  /** Optional checklist items */
  checklist: string[];
  /** Free-form conditions that must be met */
  conditions: string[];
}

export interface ExpectedFileChange {
  /** File path relative to workspace root */
  path: string;
  /** Expected change type */
  action: "created" | "modified" | "deleted" | "any";
  /** Optional: if changed, min additions expected */
  minAdditions?: number;
  /** Optional: if changed, min deletions expected */
  minDeletions?: number;
  /** Optional: expected content pattern (regex) to verify in final file */
  contentPattern?: string;
}

export interface VerificationCommand {
  /** The command to run (e.g., "pnpm typecheck", "npm test") */
  command: string;
  /** Friendly label for UI display */
  label: string;
  /** Whether this command is required to pass (vs optional/suggested) */
  required: boolean;
  /** How to interpret the result: exit code 0 = pass, or output check */
  checkType: "exit-code" | "output-pattern";
  /** For checkType "output-pattern": expected regex in stdout */
  expectedPattern?: string;
}

export interface DiffRequirement {
  /** Property name */
  property: string;
  /** Expected value or condition */
  condition: "exists" | "not-empty" | "equals" | "gte" | "lte";
  /** Value for equals/gte/lte conditions */
  value?: number | string;
}

/**
 * Build a DoneCriteria from common task patterns.
 */
export function buildDoneCriteria(config: Partial<DoneCriteria>): DoneCriteria {
  const cleaned = Object.fromEntries(
    Object.entries(config).filter(([_, v]) => v !== undefined)
  ) as Partial<DoneCriteria>;
  return {
    expectedFiles: [],
    verificationCommands: [],
    requiredDiffProperties: [],
    checklist: [],
    conditions: [],
    ...cleaned,
  };
}

/**
 * Detect available verification commands from the project's package.json or
 * similar configuration files. Returns a list of commands that can be run.
 */
export function detectVerificationCommands(
  projectConfig: {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  }
): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  const scripts = projectConfig.scripts ?? {};

  // Type check commands (check for TypeScript configuration)
  if (scripts.typecheck || scripts["type-check"]) {
    const cmd = scripts.typecheck ?? scripts["type-check"]!;
    commands.push({
      command: cmd,
      label: "TypeScript type check",
      required: true,
      checkType: "exit-code",
    });
  } else if (projectConfig.devDependencies?.typescript || projectConfig.dependencies?.typescript) {
    commands.push({
      command: "pnpm typecheck",
      label: "TypeScript type check",
      required: false,
      checkType: "exit-code",
    });
  }

  // Lint commands
  if (scripts.lint) {
    commands.push({
      command: scripts.lint,
      label: "Lint check",
      required: false,
      checkType: "exit-code",
    });
  }

  // Test commands
  if (scripts.test || scripts["test:run"]) {
    commands.push({
      command: scripts.test ?? scripts["test:run"]!,
      label: "Run tests",
      required: false,
      checkType: "exit-code",
    });
  }

  // Build command
  if (scripts.build) {
    commands.push({
      command: scripts.build,
      label: "Build check",
      required: true,
      checkType: "exit-code",
    });
  }

  return commands;
}

/**
 * Check if the given file changes satisfy the expected file change criteria.
 * Returns a list of unmet criteria.
 *
 * When readFileFn is provided, contentPattern fields are validated by reading
 * the file and testing the content against the regex pattern.
 */
export async function checkExpectedFiles(
  criteria: DoneCriteria,
  actualChanges: Array<{ path: string; action: string; additions?: number; deletions?: number }>,
  readFileFn?: (path: string) => Promise<string>
): Promise<UnmetCriteria[]> {
  const unmet: UnmetCriteria[] = [];

  for (const expected of criteria.expectedFiles) {
    const match = actualChanges.find(
      (c) => c.path === expected.path && (expected.action === "any" || c.action === expected.action)
    );

    if (!match) {
      unmet.push({
        criteria: `Expected file ${expected.path} (${expected.action})`,
        status: "missing",
        detail: `File change not found in actual changes`,
      });
      continue;
    }

    // Check minAdditions
    if (expected.minAdditions !== undefined && (match.additions ?? 0) < expected.minAdditions) {
      unmet.push({
        criteria: `Expected ≥${expected.minAdditions} additions in ${expected.path}`,
        status: "insufficient",
        detail: `Got ${match.additions ?? 0} additions`,
      });
    }

    // Check minDeletions
    if (expected.minDeletions !== undefined && (match.deletions ?? 0) < expected.minDeletions) {
      unmet.push({
        criteria: `Expected ≥${expected.minDeletions} deletions in ${expected.path}`,
        status: "insufficient",
        detail: `Got ${match.deletions ?? 0} deletions`,
      });
    }

    // Check contentPattern if provided and a file reader is available
    if (expected.contentPattern && readFileFn && (expected.action === "modified" || expected.action === "created" || expected.action === "any")) {
      // Skip content check for deleted files (even with action: "any")
      if (match.action === "deleted") continue;
      try {
        const content = await readFileFn(expected.path);
        const regex = new RegExp(expected.contentPattern);
        if (!regex.test(content)) {
          unmet.push({
            criteria: `Content pattern /${expected.contentPattern}/ in ${expected.path}`,
            status: "failed",
            detail: `File content does not match expected pattern`,
          });
        }
      } catch {
        unmet.push({
          criteria: `Content pattern /${expected.contentPattern}/ in ${expected.path}`,
          status: "failed",
          detail: `Could not read file to verify content pattern`,
        });
      }
    }
  }

  return unmet;
}

export interface UnmetCriteria {
  criteria: string;
  status: "missing" | "insufficient" | "failed";
  detail: string;
}

/**
 * Summarize verification results for UI display.
 */
export function summarizeVerification(
  results: VerificationResult[]
): { passed: number; failed: number; total: number; summary: string } {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const total = results.length;

  let summary: string;
  if (failed === 0) {
    summary = `✅ All ${total} checks passed`;
  } else {
    summary = `⚠️ ${failed}/${total} checks failed`;
  }

  return { passed, failed, total, summary };
}

export interface VerificationResult {
  command: string;
  label: string;
  required: boolean;
  passed: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs: number;
}
