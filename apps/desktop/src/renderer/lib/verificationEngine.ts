/**
 * ============================================================
 * DALAM VERIFICATION ENGINE — Verify → Execute → Finalize Pipeline
 * ============================================================
 *
 * Orchestrates the verification pipeline: after a plan is approved
 * and the agent executes the changes, this engine runs configured
 * verification commands, checks expected file changes, and reports
 * results back to the conversation so the agent can self-correct.
 *
 * Integrates with doneCriteria.ts types for structured verification.
 * ============================================================
 */

import type { FileChange } from "@dalam/shared-types";
import {
  checkExpectedFiles,
  summarizeVerification,
  type DoneCriteria,
  type VerificationCommand,
  type VerificationResult,
  type UnmetCriteria,
} from "./doneCriteria";

// ─── Terminal Execution ──────────────────────────────────────
// Simple shell executor that works in both Tauri and test environments.

let _terminalCommandRunner: ((command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>) | null = null;

/**
 * Set a custom command runner for testing environments.
 * Falls back to `runBashCommand` when in a real Tauri context.
 */
export function setCommandRunner(
  runner: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): void {
  _terminalCommandRunner = runner;
}

/**
 * Reset command runner to default (falls back to Tauri API or creates a runtime
 * executor that uses the dalamAPI system shell).
 */
export function resetCommandRunner(): void {
  _terminalCommandRunner = null;
}

async function runShellCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (_terminalCommandRunner) {
    return _terminalCommandRunner(command);
  }

  // Real Tauri environment: use the system shell through dalamAPI
  try {
    // Wrap command in a shell invocation that captures exit code
    // Use double-quoting for safer escaping that handles $'...' and backticks
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    const wrapped = `bash -c "${escaped} 2>&1; echo "\\n__EXIT_CODE__=$?""`;
    // Use a system.exec-like approach — we'll use the agent's runCommand tool
    // which returns stdout/stderr. For now, return a promise that resolves
    // by running the command through the available system API.
    const { invoke } = await import("@tauri-apps/api/core");
    const output = await invoke<string>("execute_command", { command: wrapped });
    const lines = output.split("\n");
    const exitCodeMatch = lines.pop()?.match(/__EXIT_CODE__=(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : -1;
    const stdout = exitCode === 0 ? output : "";
    const stderr = exitCode !== 0 ? output : "";
    return { exitCode, stdout, stderr };
  } catch {
    // Fallback for environments where Tauri is unavailable (test, web)
    // Use raw exec if available (Node.js test environment)
    try {
      const { execSync } = await import("child_process");
      const output = execSync(command, { encoding: "utf8", timeout: 30_000 });
      return { exitCode: 0, stdout: output, stderr: "" };
    } catch (execErr: unknown) {
      const errorOutput = (execErr as { stdout?: string; stderr?: string; status?: number })?.stderr
        ?? (execErr as Error)?.message
        ?? "Unknown execution error";
      return {
        exitCode: (execErr as { status?: number })?.status ?? 1,
        stdout: (execErr as { stdout?: string })?.stdout ?? "",
        stderr: typeof errorOutput === "string" ? errorOutput : String(errorOutput),
      };
    }
  }
}

// ─── Command Execution ───────────────────────────────────────

/**
 * Run a single verification command.
 */
export async function runVerificationCommand(
  vc: VerificationCommand
): Promise<VerificationResult> {
  const startTime = Date.now();
  try {
    const { exitCode, stdout, stderr } = await runShellCommand(vc.command);

    let passed = false;
    if (vc.checkType === "exit-code") {
      passed = exitCode === 0;
    } else if (vc.checkType === "output-pattern" && vc.expectedPattern) {
      const { getCachedRegex } = await import("./regexCache");
      const regex = getCachedRegex(vc.expectedPattern);
      passed = regex ? regex.test(stdout) : false;
    }

    return {
      command: vc.command,
      label: vc.label,
      passed,
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      command: vc.command,
      label: vc.label,
      passed: false,
      stderr: (err as Error)?.message ?? String(err),
      exitCode: -1,
      durationMs: Date.now() - startTime,
    };
  }
}

// ─── File Change Checking ────────────────────────────────────

/**
 * Compare expected file changes (from DoneCriteria) with actual changes
 * (from _pendingChanges or git diff). Returns unmet criteria.
 */
export async function checkActualFileChanges(
  criteria: DoneCriteria,
  actualChanges: FileChange[],
  readFileFn?: (path: string) => Promise<string>
): Promise<UnmetCriteria[]> {
  // Provide a default readFileFn that reads from the filesystem if none provided.
  // This ensures contentPattern is always validated when specified in ExpectedFileChange.
  if (!readFileFn) {
    readFileFn = async (filePath: string) => {
      try {
        const api = await import("@/lib/dalamAPI").then(m => m.createDalamAPI());
        return await api.fs.readFile(filePath);
      } catch {
        return "";
      }
    };
  }
  return checkExpectedFiles(criteria, actualChanges, readFileFn);
}

// ─── Pipeline Orchestration ─────────────────────────────────

/**
 * Full verification pipeline result.
 */
export interface VerificationPipelineResult {
  /** Results from running verification commands */
  commandResults: VerificationResult[];
  /** Unmet file change criteria */
  unmetFileChanges: UnmetCriteria[];
  /** Overall status */
  status: "passed" | "failed" | "partial";
  /** Human-readable summary */
  summary: string;
  /** Duration of the entire pipeline */
  durationMs: number;
}

/**
 * Run the full verification pipeline.
 *
 * Steps:
 *   1. Detect verification commands from the workspace package.json
 *   2. Run all verification commands
 *   3. Check expected file changes against actual changes
 *   4. Summarize results
 */
export async function runVerificationPipeline(
  criteria: DoneCriteria,
  actualChanges: FileChange[],
  _workspacePath?: string,
  readFileFn?: (path: string) => Promise<string>
): Promise<VerificationPipelineResult> {
  const startTime = Date.now();

  // Step 2: Run verification commands
  const commandResults: VerificationResult[] = [];
  if (criteria.verificationCommands.length > 0) {
    const results = await Promise.all(
      criteria.verificationCommands.map((vc) => runVerificationCommand(vc))
    );
    commandResults.push(...results);
  }

  // Step 3: Check expected file changes
  const unmetFileChanges = await checkActualFileChanges(criteria, actualChanges, readFileFn);
  const fileSummary = unmetFileChanges.length === 0
    ? "✅ All expected file changes found"
    : `⚠️ ${unmetFileChanges.length} file change(s) missing or insufficient`;

  // Step 4: Summarize results
  const cmdSummary = summarizeVerification(commandResults);
  const allFailed = cmdSummary.failed > 0 || unmetFileChanges.length > 0;

  let status: "passed" | "failed" | "partial";
  if (cmdSummary.passed > 0 && allFailed) {
    status = "partial";
  } else if (allFailed) {
    status = "failed";
  } else {
    status = "passed";
  }

  const summary = [
    `## Verification Results`,
    ``,
    `**Commands:** ${cmdSummary.summary}`,
    `**Files:** ${fileSummary}`,
    ``,
  ];

  // Add command details
  if (commandResults.length > 0) {
    summary.push(`### Commands\n`);
    for (const r of commandResults) {
      const icon = r.passed ? "✅" : "❌";
      summary.push(`${icon} **${r.label}** — ${r.passed ? "passed" : `failed (exit code ${r.exitCode ?? -1})`} (${r.durationMs}ms)`);
    }
    summary.push(``);
  }

  // Add unmet file criteria
  if (unmetFileChanges.length > 0) {
    summary.push(`### Unmet File Criteria\n`);
    for (const u of unmetFileChanges) {
      summary.push(`- ❌ ${u.criteria} (${u.status}: ${u.detail})`);
    }
    summary.push(``);
  }

  // Add checklist items
  if (criteria.checklist.length > 0) {
    summary.push(`### Checklist\n`);
    for (const item of criteria.checklist) {
      summary.push(`- [ ] ${item}`);
    }
    summary.push(``);
  }

  // Add conditions summary
  if (criteria.conditions.length > 0) {
    summary.push(`### Conditions\n`);
    summary.push(`The following conditions should be met:`);
    for (const cond of criteria.conditions) {
      summary.push(`- ${cond}`);
    }
    summary.push(``);
  }

  return {
    commandResults,
    unmetFileChanges,
    status,
    summary: summary.join("\n"),
    durationMs: Date.now() - startTime,
  };
}

// ─── Auto-Detection Helpers ──────────────────────────────────

/**
 * Auto-detect verification commands from a project config.
 * Parses package.json scripts to find typecheck, lint, test, build.
 */
export async function detectCommandsFromWorkspace(
  workspacePath?: string
): Promise<VerificationCommand[]> {
  if (!workspacePath) return [];

  const api = await import("@/lib/dalamAPI").then(m => m.createDalamAPI());
  const allCommands: VerificationCommand[] = [];

  // JavaScript/TypeScript (package.json)
  try {
    const pkgJsonPath = `${workspacePath}/package.json`;
    const content = await api.fs.readFile(pkgJsonPath);
    const pkg = JSON.parse(content);
    const { detectVerificationCommands } = await import("./doneCriteria");
    allCommands.push(...detectVerificationCommands({
      scripts: pkg.scripts || {},
      devDependencies: pkg.devDependencies || {},
      dependencies: pkg.dependencies || {},
    }));
  } catch { /* not a JS project */ }

  // Rust (Cargo.toml)
  try {
    await api.fs.readFile(`${workspacePath}/Cargo.toml`);
    allCommands.push(
      { command: "cargo check", label: "Rust check", required: true, checkType: "exit-code" },
      { command: "cargo test", label: "Rust tests", required: false, checkType: "exit-code" },
      { command: "cargo clippy", label: "Rust lint", required: false, checkType: "exit-code" },
    );
  } catch { /* not a Rust project */ }

  // Python (pyproject.toml or setup.py)
  try {
    await api.fs.readFile(`${workspacePath}/pyproject.toml`);
    allCommands.push(
      { command: "mypy .", label: "Python type check", required: false, checkType: "exit-code" },
      { command: "ruff check .", label: "Python lint", required: false, checkType: "exit-code" },
      { command: "pytest", label: "Python tests", required: false, checkType: "exit-code" },
    );
  } catch {
    try {
      await api.fs.readFile(`${workspacePath}/setup.py`);
      allCommands.push(
        { command: "mypy .", label: "Python type check", required: false, checkType: "exit-code" },
        { command: "ruff check .", label: "Python lint", required: false, checkType: "exit-code" },
        { command: "pytest", label: "Python tests", required: false, checkType: "exit-code" },
      );
    } catch { /* not a Python project */ }
  }

  // Go (go.mod)
  try {
    await api.fs.readFile(`${workspacePath}/go.mod`);
    allCommands.push(
      { command: "go build ./...", label: "Go build", required: true, checkType: "exit-code" },
      { command: "go test ./...", label: "Go tests", required: false, checkType: "exit-code" },
      { command: "go vet ./...", label: "Go vet", required: false, checkType: "exit-code" },
    );
  } catch { /* not a Go project */ }

  // Monorepo (turbo.json)
  try {
    await api.fs.readFile(`${workspacePath}/turbo.json`);
    allCommands.push(
      { command: "turbo build", label: "Monorepo build", required: true, checkType: "exit-code" },
      { command: "turbo lint", label: "Monorepo lint", required: false, checkType: "exit-code" },
      { command: "turbo test", label: "Monorepo tests", required: false, checkType: "exit-code" },
    );
  } catch { /* not a monorepo */ }

  return allCommands;
}

/**
 * Build a default DoneCriteria from workspace configuration.
 * Auto-detects verification commands and sets up basic checks.
 */
export async function buildDefaultCriteria(
  workspacePath?: string,
  overrides?: Partial<DoneCriteria>
): Promise<DoneCriteria> {
  const { buildDoneCriteria } = await import("./doneCriteria");
  const commands = await detectCommandsFromWorkspace(workspacePath);

  return buildDoneCriteria({
    verificationCommands: commands,
    checklist: ["Changes compile without errors", "All tests pass"],
    ...overrides,
  });
}
