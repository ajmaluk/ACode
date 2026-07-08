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

let _terminalCommandRunner: ((command: string, cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>) | null = null;

/**
 * Set a custom command runner for testing environments.
 * Falls back to the Tauri shell plugin when in a real Tauri context.
 */
export function setCommandRunner(
  runner: (command: string, cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): void {
  _terminalCommandRunner = runner;
}

/**
 * Reset command runner to default (falls back to Tauri shell plugin).
 */
export function resetCommandRunner(): void {
  _terminalCommandRunner = null;
}

/**
 * Run a shell command with proper working directory support.
 * Uses @tauri-apps/plugin-shell for the real Tauri environment,
 * falls back to child_process for test/Node.js environments.
 */
async function runShellCommand(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (_terminalCommandRunner) {
    return _terminalCommandRunner(command, cwd);
  }

  // Real Tauri environment: use the shell plugin with working directory
  try {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.create("bash", ["-c", command], { cwd: cwd ?? undefined });
    const output = await cmd.execute();
    return {
      exitCode: output.code ?? -1,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  } catch {
    // Fallback for environments where Tauri is unavailable (test, web)
    try {
      const { execSync } = await import("child_process");
      const output = execSync(command, { encoding: "utf8", timeout: 30_000, cwd });
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
  vc: VerificationCommand,
  cwd?: string
): Promise<VerificationResult> {
  const startTime = Date.now();
  try {
    const { exitCode, stdout, stderr } = await runShellCommand(vc.command, cwd);

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
      required: vc.required,
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
      required: vc.required,
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
  workspacePath?: string,
  readFileFn?: (path: string) => Promise<string>
): Promise<VerificationPipelineResult> {
  const startTime = Date.now();

  // Step 2: Run verification commands in the workspace directory
  const commandResults: VerificationResult[] = [];
  if (criteria.verificationCommands.length > 0) {
    const results = await Promise.all(
      criteria.verificationCommands.map((vc) => runVerificationCommand(vc, workspacePath))
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
 * Detect project type from file extensions in the workspace.
 * Returns a set of detected project types: "js-ts", "python", "rust", "go".
 */
async function detectProjectTypes(workspacePath: string): Promise<Set<string>> {
  const types = new Set<string>();
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(workspacePath);
    for (const entry of entries.slice(0, 200)) {
      const name = entry.name || "";
      if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
        types.add("js-ts");
      } else if (name.endsWith(".py") || name.endsWith(".pyi")) {
        types.add("python");
      } else if (name.endsWith(".rs")) {
        types.add("rust");
      } else if (name.endsWith(".go")) {
        types.add("go");
      }
      if (name === "package.json" || name === "tsconfig.json" || name === "jsconfig.json") types.add("js-ts");
      if (name === "pyproject.toml" || name === "setup.py" || name === "requirements.txt" || name === "Pipfile") types.add("python");
      if (name === "Cargo.toml") types.add("rust");
      if (name === "go.mod") types.add("go");
    }
  } catch { /* ignore read errors */ }
  return types;
}

/**
 * Auto-detect verification commands from a project config.
 * Detects project type from both config files and source file extensions.
 */
export async function detectCommandsFromWorkspace(
  workspacePath?: string
): Promise<VerificationCommand[]> {
  if (!workspacePath) return [];

  const api = await import("@/lib/dalamAPI").then(m => m.createDalamAPI());
  const allCommands: VerificationCommand[] = [];
  const detectedTypes = await detectProjectTypes(workspacePath);

  // JavaScript/TypeScript (package.json)
  if (detectedTypes.has("js-ts")) {
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
    } catch { /* package.json not readable */ }
  }

  // Rust (Cargo.toml)
  if (detectedTypes.has("rust")) {
    try {
      await api.fs.readFile(`${workspacePath}/Cargo.toml`);
      allCommands.push(
        { command: "cargo check", label: "Rust check", required: true, checkType: "exit-code" },
        { command: "cargo test", label: "Rust tests", required: false, checkType: "exit-code" },
        { command: "cargo clippy", label: "Rust lint", required: false, checkType: "exit-code" },
      );
    } catch { /* not a Rust project */ }
  }

  // Python (.py files detected)
  if (detectedTypes.has("python")) {
    allCommands.push(
      { command: "python3 -c \"import py_compile; import glob; [py_compile.compile(f, doraise=True) for f in glob.glob('**/*.py', recursive=True)[:20]]\"", label: "Python syntax check", required: false, checkType: "exit-code" },
    );
  }

  // Go (go.mod)
  if (detectedTypes.has("go")) {
    try {
      await api.fs.readFile(`${workspacePath}/go.mod`);
      allCommands.push(
        { command: "go build ./...", label: "Go build", required: true, checkType: "exit-code" },
        { command: "go test ./...", label: "Go tests", required: false, checkType: "exit-code" },
        { command: "go vet ./...", label: "Go vet", required: false, checkType: "exit-code" },
      );
    } catch { /* not a Go project */ }
  }

  // Monorepo (turbo.json) — only if no language-specific commands found
  if (allCommands.length === 0) {
    try {
      await api.fs.readFile(`${workspacePath}/turbo.json`);
      allCommands.push(
        { command: "turbo build", label: "Monorepo build", required: true, checkType: "exit-code" },
        { command: "turbo lint", label: "Monorepo lint", required: false, checkType: "exit-code" },
        { command: "turbo test", label: "Monorepo tests", required: false, checkType: "exit-code" },
      );
    } catch { /* not a monorepo */ }
  }

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

  // Build checklist based on what commands were detected
  const checklist: string[] = [];
  if (commands.some(c => c.label.includes("type check") || c.label.includes("check"))) {
    checklist.push("Changes compile without errors");
  }
  if (commands.some(c => c.label.includes("test"))) {
    checklist.push("All tests pass");
  }
  if (commands.some(c => c.label.includes("lint"))) {
    checklist.push("Code passes linting");
  }
  if (checklist.length === 0) {
    checklist.push("Changes are correct");
  }

  return buildDoneCriteria({
    verificationCommands: commands,
    checklist,
    ...overrides,
  });
}
