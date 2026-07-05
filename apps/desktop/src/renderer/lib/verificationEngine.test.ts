import { describe, it, expect, beforeEach } from "vitest";
import {
  runVerificationCommand,
  checkActualFileChanges,
  setCommandRunner,
  resetCommandRunner,
} from "./verificationEngine";
import type { DoneCriteria, VerificationCommand } from "./doneCriteria";
import type { FileChange } from "@dalam/shared-types";

describe("verificationEngine", () => {
  beforeEach(() => {
    resetCommandRunner();
  });

  describe("runVerificationCommand", () => {
    it("passes when exit code is 0 for exit-code checks", async () => {
      setCommandRunner(async () => ({
        exitCode: 0,
        stdout: "All good",
        stderr: "",
      }));

      const cmd: VerificationCommand = {
        command: "pnpm typecheck",
        label: "TypeScript type check",
        required: true,
        checkType: "exit-code",
      };

      const result = await runVerificationCommand(cmd);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("fails when exit code is non-zero for exit-code checks", async () => {
      setCommandRunner(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Type error: foo is not a function",
      }));

      const cmd: VerificationCommand = {
        command: "pnpm typecheck",
        label: "TypeScript type check",
        required: true,
        checkType: "exit-code",
      };

      const result = await runVerificationCommand(cmd);
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it("passes when output matches pattern for output-pattern checks", async () => {
      setCommandRunner(async () => ({
        exitCode: 0,
        stdout: "All tests passed! 42 tests total",
        stderr: "",
      }));

      const cmd: VerificationCommand = {
        command: "npm test",
        label: "Run tests",
        required: true,
        checkType: "output-pattern",
        expectedPattern: "tests passed",
      };

      const result = await runVerificationCommand(cmd);
      expect(result.passed).toBe(true);
    });

    it("fails when output does not match pattern", async () => {
      setCommandRunner(async () => ({
        exitCode: 0,
        stdout: "No tests found",
        stderr: "",
      }));

      const cmd: VerificationCommand = {
        command: "npm test",
        label: "Run tests",
        required: true,
        checkType: "output-pattern",
        expectedPattern: "tests passed",
      };

      const result = await runVerificationCommand(cmd);
      expect(result.passed).toBe(false);
    });

    it("handles command runner errors gracefully", async () => {
      setCommandRunner(async () => {
        throw new Error("Command not found");
      });

      const cmd: VerificationCommand = {
        command: "nonexistent-command",
        label: "Custom check",
        required: false,
        checkType: "exit-code",
      };

      const result = await runVerificationCommand(cmd);
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("Command not found");
    });
  });

  describe("checkActualFileChanges", () => {
    it("reports no issues when all expected files are changed", async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/foo.ts", action: "modified" },
          { path: "src/bar.ts", action: "created" },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/foo.ts", action: "modified", additions: 10, deletions: 2 },
        { path: "src/bar.ts", action: "created", additions: 50, deletions: 0 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(0);
    });

    it("reports missing files", async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/foo.ts", action: "modified" },
          { path: "src/missing.ts", action: "created" },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/foo.ts", action: "modified", additions: 10, deletions: 0 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(1);
      expect(unmet[0].criteria).toContain("missing.ts");
      expect(unmet[0].status).toBe("missing");
    });

    it("reports insufficient additions", async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/foo.ts", action: "modified", minAdditions: 5 },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/foo.ts", action: "modified", additions: 2, deletions: 0 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(1);
      expect(unmet[0].criteria).toContain("≥5 additions");
      expect(unmet[0].status).toBe("insufficient");
    });

    it("reports insufficient deletions", async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/foo.ts", action: "deleted", minDeletions: 3 },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/foo.ts", action: "deleted", additions: 0, deletions: 1 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(1);
      expect(unmet[0].criteria).toContain("≥3 deletions");
    });

    it('accepts "any" action type', async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/foo.ts", action: "any" },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/foo.ts", action: "modified", additions: 5, deletions: 0 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(0);
    });

    it("returns multiple unmet criteria", async () => {
      const criteria: DoneCriteria = {
        expectedFiles: [
          { path: "src/a.ts", action: "modified" },
          { path: "src/b.ts", action: "created" },
          { path: "src/c.ts", action: "modified", minAdditions: 10 },
        ],
        verificationCommands: [],
        requiredDiffProperties: [],
        checklist: [],
        conditions: [],
      };

      const changes: FileChange[] = [
        { path: "src/a.ts", action: "modified", additions: 1, deletions: 0 },
      ];

      const unmet = await checkActualFileChanges(criteria, changes);
      expect(unmet).toHaveLength(2);
      expect(unmet.map((u) => u.status).sort()).toEqual(["missing", "missing"]);
    });
  });
});
