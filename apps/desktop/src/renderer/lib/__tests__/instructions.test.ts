import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePathScopedRules,
  loadInstructions,
  formatInstructionsForPrompt,
  listPathScopedGlobs,
  clearInstructionCache,
} from "../instructions";
import type { InstructionFsAdapter } from "../instructions";

// ── Mock FS adapter ──────────────────────────────────────────

function createMockAdapter(
  files: Record<string, string>,
  homeDir = "/home/user",
): InstructionFsAdapter {
  return {
    readFile: async (path: string) => {
      if (files[path] !== undefined) return files[path];
      throw new Error(`ENOENT: ${path}`);
    },
    exists: async (path: string) => path in files,
    getHomeDir: async () => homeDir,
  };
}

// ── parsePathScopedRules ─────────────────────────────────────

describe("parsePathScopedRules", () => {
  it("returns empty rules for empty content", () => {
    const result = parsePathScopedRules("");
    expect(result.globalRules).toBe("");
    expect(result.pathScopedRules.size).toBe(0);
  });

  it("parses global rules (no @path blocks)", () => {
    const content = `Use functional components
Prefer named exports
Follow TypeScript strict mode`;

    const result = parsePathScopedRules(content);
    expect(result.globalRules).toContain("Use functional components");
    expect(result.globalRules).toContain("Prefer named exports");
    expect(result.pathScopedRules.size).toBe(0);
  });

  it("parses @path block after global rules", () => {
    const content = `Global rule: use strict mode.

@path: *.tsx
- Use React.FC
- Use hooks`;

    const result = parsePathScopedRules(content);
    expect(result.globalRules).toContain("Global rule");
    expect(result.pathScopedRules.get("*.tsx")).toContain("React.FC");
    expect(result.pathScopedRules.get("*.tsx")).toContain("hooks");
  });

  it("parses multiple @path blocks", () => {
    const content = `@path: *.ts
- TypeScript rules

@path: *.css
- CSS rules`;

    const result = parsePathScopedRules(content);
    expect(result.pathScopedRules.size).toBe(2);
    expect(result.pathScopedRules.get("*.ts")).toContain("TypeScript");
    expect(result.pathScopedRules.get("*.css")).toContain("CSS");
  });

  it("merges duplicate @path globs", () => {
    const content = `@path: *.ts
- First rule

@path: *.ts
- Second rule`;

    const result = parsePathScopedRules(content);
    const rules = result.pathScopedRules.get("*.ts");
    expect(rules).toContain("First rule");
    expect(rules).toContain("Second rule");
  });

  it("handles @path with trailing whitespace", () => {
    const content = `@path:   *.test.ts   
- Use vitest`;

    const result = parsePathScopedRules(content);
    expect(result.pathScopedRules.get("*.test.ts")).toContain("vitest");
  });

  it("preserves blank lines within path blocks", () => {
    const content = `@path: *.tsx
- Rule 1

- Rule 2`;

    const result = parsePathScopedRules(content);
    const rules = result.pathScopedRules.get("*.tsx");
    expect(rules).toContain("Rule 1");
    expect(rules).toContain("Rule 2");
  });
});

// ── loadInstructions ─────────────────────────────────────────

describe("loadInstructions", () => {
  beforeEach(() => {
    clearInstructionCache();
  });

  it("returns empty instructions when no files exist", async () => {
    const adapter = createMockAdapter({});
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toEqual([]);
    expect(result.globalRules).toBe("");
    expect(result.pathScopedRules.size).toBe(0);
  });

  it("loads global instructions from ~/.dalam/DALAM.md", async () => {
    const adapter = createMockAdapter({
      "/home/user/.dalam/DALAM.md": "Global rule: indent with 2 spaces",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/home/user/.dalam/DALAM.md");
    expect(result.globalRules).toContain("Global rule");
  });

  it("loads project instructions from workspace/DALAM.md", async () => {
    const adapter = createMockAdapter({
      "/workspace/DALAM.md": "Project rule: use vitest",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/DALAM.md");
    expect(result.globalRules).toContain("vitest");
  });

  it("loads local instructions from workspace/.dalam/local/DALAM.md", async () => {
    const adapter = createMockAdapter({
      "/workspace/.dalam/local/DALAM.md": "Local rule: user prefers tabs",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/.dalam/local/DALAM.md");
    expect(result.globalRules).toContain("tabs");
  });

  it("loads and merges from multiple layers", async () => {
    const adapter = createMockAdapter({
      "/home/user/.dalam/DALAM.md": "Global: use strict mode",
      "/workspace/DALAM.md": "Project: use vitest",
      "/workspace/.dalam/local/DALAM.md": "Local: no trailing commas",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths.length).toBe(3);
    expect(result.globalRules).toContain("Global");
    expect(result.globalRules).toContain("Project");
    expect(result.globalRules).toContain("Local");
  });

  it("loads org layer from workspace/.dalam/org/DALAM.md", async () => {
    const adapter = createMockAdapter({
      "/workspace/.dalam/org/DALAM.md": "Org: use company style guide",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/.dalam/org/DALAM.md");
    expect(result.globalRules).toContain("Org");
  });

  it("falls back to legacy .cursorrules", async () => {
    const adapter = createMockAdapter({
      "/workspace/.cursorrules": "Legacy cursor rule",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/.cursorrules");
    expect(result.globalRules).toContain("cursor");
  });

  it("falls back to legacy .agentrules", async () => {
    const adapter = createMockAdapter({
      "/workspace/.agentrules": "Legacy agent rule",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/.agentrules");
    expect(result.globalRules).toContain("agent");
  });

  it("falls back to legacy .dalam/rules.md", async () => {
    const adapter = createMockAdapter({
      "/workspace/.dalam/rules.md": "Legacy dalam rules",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).toContain("/workspace/.dalam/rules.md");
    expect(result.globalRules).toContain("Legacy");
  });

  it("prefers DALAM.md over legacy fallbacks", async () => {
    const adapter = createMockAdapter({
      "/workspace/DALAM.md": "Project: modern",
      "/workspace/.cursorrules": "Legacy cursor",
    });
    const result = await loadInstructions("/workspace", adapter);
    expect(result.loadedPaths).not.toContain("/workspace/.cursorrules");
    expect(result.globalRules).toContain("modern");
  });

  it("merges path-scoped rules from all layers", async () => {
    const adapter = createMockAdapter({
      "/home/user/.dalam/DALAM.md": `@path: *.ts
- Global TS rule`,
      "/workspace/DALAM.md": `@path: *.ts
- Project TS rule`,
    });
    const result = await loadInstructions("/workspace", adapter);
    const tsRules = result.pathScopedRules.get("*.ts");
    expect(tsRules).toContain("Global TS rule");
    expect(tsRules).toContain("Project TS rule");
  });

  it("handles read errors gracefully", async () => {
    const brokenAdapter: InstructionFsAdapter = {
      readFile: async () => {
        throw new Error("Read error");
      },
      exists: async () => true,
      getHomeDir: async () => "/home/user",
    };
    const result = await loadInstructions("/workspace", brokenAdapter);
    expect(result.globalRules).toBe("");
    expect(result.loadedPaths).toEqual([]);
  });
});

// ── formatInstructionsForPrompt ──────────────────────────────

describe("formatInstructionsForPrompt", () => {
  it("returns empty string when no rules exist", () => {
    const result = formatInstructionsForPrompt({
      globalRules: "",
      pathScopedRules: new Map(),
      loadedPaths: [],
      layers: { global: "", org: "", project: "", local: "" },
    });
    expect(result).toBe("");
  });

  it("formats global rules into a prompt block", () => {
    const result = formatInstructionsForPrompt({
      globalRules: "Use strict TypeScript",
      pathScopedRules: new Map(),
      loadedPaths: ["/workspace/DALAM.md"],
      layers: {
        global: "",
        org: "",
        project: "Use strict TypeScript",
        local: "",
      },
    });
    expect(result).toContain("WORKSPACE INSTRUCTIONS");
    expect(result).toContain("Use strict TypeScript");
  });

  it("includes matching path-scoped rules", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("*.ts", "TypeScript file rules");

    const result = formatInstructionsForPrompt(
      {
        globalRules: "Global rules",
        pathScopedRules: pathScoped,
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" },
      },
      "src/app.ts",
    );
    expect(result).toContain("TypeScript file rules");
  });

  it("does NOT include non-matching path-scoped rules", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("*.py", "Python rules");

    const result = formatInstructionsForPrompt(
      {
        globalRules: "Global",
        pathScopedRules: pathScoped,
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" },
      },
      "src/app.ts",
    );
    expect(result).not.toContain("Python");
  });

  it("uses no activeFilePath when none provided", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("*.ts", "TS rules");

    const result = formatInstructionsForPrompt({
      globalRules: "Global",
      pathScopedRules: pathScoped,
      loadedPaths: [],
      layers: { global: "", org: "", project: "", local: "" },
    });
    expect(result).not.toContain("TS rules"); // No active file, so no path-scoped rules
    expect(result).toContain("Global");
  });

  it("matches glob for files in any directory (no-sha pattern)", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("*.test.ts", "Check vitest");

    const result = formatInstructionsForPrompt(
      {
        globalRules: "",
        pathScopedRules: pathScoped,
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" },
      },
      "src/components/Button.test.ts",
    );
    expect(result).toContain("vitest");
  });

  it("matches glob with directory path", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("src/components/*.tsx", "Component rules");

    const result = formatInstructionsForPrompt(
      {
        globalRules: "",
        pathScopedRules: pathScoped,
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" },
      },
      "src/components/Button.tsx",
    );
    expect(result).toContain("Component rules");
  });

  it("does NOT match glob with wrong directory", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("src/components/*.tsx", "Component rules");

    const result = formatInstructionsForPrompt(
      {
        globalRules: "",
        pathScopedRules: pathScoped,
        loadedPaths: [],
        layers: { global: "", org: "", project: "", local: "" },
      },
      "src/hooks/useButton.tsx",
    );
    expect(result).not.toContain("Component rules");
  });
});

// ── listPathScopedGlobs ──────────────────────────────────────

describe("listPathScopedGlobs", () => {
  it("returns empty array when no scoped rules", () => {
    const globs = listPathScopedGlobs({
      globalRules: "",
      pathScopedRules: new Map(),
      loadedPaths: [],
      layers: { global: "", org: "", project: "", local: "" },
    });
    expect(globs).toEqual([]);
  });

  it("returns all glob keys", () => {
    const pathScoped = new Map<string, string>();
    pathScoped.set("*.ts", "a");
    pathScoped.set("*.tsx", "b");

    const globs = listPathScopedGlobs({
      globalRules: "",
      pathScopedRules: pathScoped,
      loadedPaths: [],
      layers: { global: "", org: "", project: "", local: "" },
    });
    expect(globs).toContain("*.ts");
    expect(globs).toContain("*.tsx");
    expect(globs.length).toBe(2);
  });
});
