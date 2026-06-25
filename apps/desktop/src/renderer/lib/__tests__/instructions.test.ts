import { describe, it, expect } from "vitest";
import {
  parsePathScopedRules,
  formatInstructionsForPrompt,
  loadInstructions
} from "../instructions";
import type { InstructionFsAdapter } from "../instructions";

describe("Instructions System", () => {

  // 1. Glob matching tests
  describe("matchGlob (private internal / exported indirectly via formatInstructionsForPrompt)", () => {
    it("matches basic file extension patterns globally if no slashes", () => {
      const instructions = {
        globalRules: "",
        pathScopedRules: new Map([["*.ts", "Use TypeScript"]]),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };
      
      const promptMatch = formatInstructionsForPrompt(instructions, "src/index.ts");
      expect(promptMatch).toContain("Use TypeScript");

      const promptMismatch = formatInstructionsForPrompt(instructions, "src/index.tsx");
      expect(promptMismatch).toBe("");
    });

    it("matches subdirectory globstars properly", () => {
      const instructions = {
        globalRules: "",
        pathScopedRules: new Map([["src/**/*.ts", "Strict types in src"]]),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };

      const match1 = formatInstructionsForPrompt(instructions, "src/a/b/c.ts");
      expect(match1).toContain("Strict types in src");

      const match2 = formatInstructionsForPrompt(instructions, "src/index.ts");
      expect(match2).toContain("Strict types in src");

      const mismatch = formatInstructionsForPrompt(instructions, "tests/index.ts");
      expect(mismatch).toBe("");
    });

    it("matches question mark wildcards", () => {
      const instructions = {
        globalRules: "",
        pathScopedRules: new Map([["file?.ts", "Single char match"]]),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };

      const match = formatInstructionsForPrompt(instructions, "fileA.ts");
      expect(match).toContain("Single char match");

      const mismatch = formatInstructionsForPrompt(instructions, "fileAB.ts");
      expect(mismatch).toBe("");
    });
  });

  // 2. parsePathScopedRules tests
  describe("parsePathScopedRules", () => {
    it("correctly separates global rules and path-scoped rules", () => {
      const content = [
        "Global rule 1",
        "Global rule 2",
        "",
        "@path: src/**/*.ts",
        "- TS rule 1",
        "- TS rule 2",
        "",
        "@path: *.test.ts",
        "- Test rule 1"
      ].join("\n");

      const { globalRules, pathScopedRules } = parsePathScopedRules(content);

      expect(globalRules).toBe("Global rule 1\nGlobal rule 2");
      expect(pathScopedRules.get("src/**/*.ts")).toBe("- TS rule 1\n- TS rule 2");
      expect(pathScopedRules.get("*.test.ts")).toBe("- Test rule 1");
    });
  });

  // 3. formatInstructionsForPrompt tests
  describe("formatInstructionsForPrompt", () => {
    it("returns empty string if no rules exist", () => {
      const instructions = {
        globalRules: "",
        pathScopedRules: new Map(),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };
      expect(formatInstructionsForPrompt(instructions)).toBe("");
    });

    it("formats global rules when activeFilePath is not provided", () => {
      const instructions = {
        globalRules: "Global project convention",
        pathScopedRules: new Map([["*.ts", "TS convention"]]),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };

      const prompt = formatInstructionsForPrompt(instructions);
      expect(prompt).toContain("Global project convention");
      expect(prompt).not.toContain("TS convention");
    });

    it("appends matching path-scoped rules to global rules", () => {
      const instructions = {
        globalRules: "Global project convention",
        pathScopedRules: new Map([["*.ts", "TS convention"]]),
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" }
      };

      const prompt = formatInstructionsForPrompt(instructions, "src/index.ts");
      expect(prompt).toContain("Global project convention");
      expect(prompt).toContain("TS convention");
    });
  });

  // 4. loadInstructions tests with mock adapter
  describe("loadInstructions", () => {
    it("loads and prioritizes instructions across 4 layers", async () => {
      const mockFs: Record<string, string> = {
        "/home/user/.acode/ACODE.md": "Global layer rule\n@path: *.ts\nGlobal path rule",
        "/workspace/.acode/org/ACODE.md": "Org layer rule",
        "/workspace/ACODE.md": "Project layer rule\n@path: *.ts\nProject path rule",
        "/workspace/.acode/local/ACODE.md": "Local layer rule"
      };

      const adapter: InstructionFsAdapter = {
        exists: async (p) => !!mockFs[p],
        readFile: async (p) => mockFs[p] || "",
        getHomeDir: async () => "/home/user"
      };

      const instructions = await loadInstructions("/workspace", adapter);

      // Global rules should be merged in order: global -> org -> project -> local
      expect(instructions.globalRules).toBe(
        "Global layer rule\n\nOrg layer rule\n\nProject layer rule\n\nLocal layer rule"
      );

      // Path-scoped rules for *.ts should be merged: global path rule + project path rule
      expect(instructions.pathScopedRules.get("*.ts")).toBe("Global path rule\nProject path rule");
      expect(instructions.loadedPaths).toContain("/home/user/.acode/ACODE.md");
      expect(instructions.loadedPaths).toContain("/workspace/ACODE.md");
    });
  });
});
