/**
 * Path normalization tests for the storage module.
 *
 * The storage module (IndexedDB) handles workspace paths as object store
 * keys and indices. These tests verify that Windows paths with backslashes
 * are handled consistently across all persistence layers.
 *
 * Since IndexedDB is browser-only and not available in Vitest's node env,
 * we test the path normalization utilities that the storage layer relies on,
 * and verify that the storage key derivation logic produces consistent results
 * regardless of the host OS path format.
 *
 * Note: Windows paths preserve the drive letter prefix (C:/...) while Unix
 * paths use a leading slash (/...). These tests verify structural consistency
 * (suffix matching, no backslashes, correct components) rather than exact
 * string equality between platforms.
 */
import { describe, it, expect } from "vitest";
import { toPosix, joinPath, basename, dirname, splitPath } from "../pathUtils";

// ─── Storage key derivation (mirrors how useAppStore derives keys) ─────

/**
 * Derive a consistent storage key from a workspace path.
 * This is the pattern used throughout the codebase for localStorage and
 * IndexedDB keys that are workspace-scoped.
 *
 * The key must be identical regardless of whether the workspace path
 * uses Windows backslashes or Unix forward slashes.
 */
function deriveStorageKey(prefix: string, workspacePath: string): string {
  const normalized = toPosix(workspacePath);
  const withoutDrive = normalized.replace(/^[a-zA-Z]:/, "");
  return `${prefix}:${withoutDrive}`;
}

/** Derive a .dalam directory from workspace path. */
function deriveDbDirPath(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam");
}

function deriveDbFilePath(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam", "project.db");
}

function deriveMemoriesDir(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam", "memories");
}

function deriveMemoryFilePath(workspacePath: string, category: string, id: string): string {
  return joinPath(workspacePath, ".dalam", "memories", `${category}-${id}.md`);
}

function deriveTrajectoryDir(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam", "trajectories");
}

function deriveTrajectoryFilePath(workspacePath: string, sessionId: string): string {
  return joinPath(workspacePath, ".dalam", "trajectories", `trajectory-${sessionId}.jsonl`);
}

function deriveSkillsDir(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam", "skills");
}

function deriveSkillFilePath(workspacePath: string, skillName: string): string {
  return joinPath(workspacePath, ".dalam", "skills", skillName, "SKILL.md");
}

function deriveMemoryIndexPath(workspacePath: string): string {
  return joinPath(workspacePath, ".dalam", "MEMORY.md");
}

/**
 * Get the relative suffix after the workspace root for cross-platform comparison.
 * E.g. "C:/Users/dev/project/.dalam" → "/.dalam"
 *      "/Users/dev/project/.dalam"  → "/.dalam"
 */
function relativeSuffix(fullPath: string, workspacePath: string): string {
  const posixFull = toPosix(fullPath);
  const posixWs = toPosix(workspacePath);
  // Find where the workspace path ends in the full path
  const idx = posixFull.indexOf(posixWs);
  if (idx === -1) return posixFull;
  return posixFull.slice(idx + posixWs.length);
}

// ─── Tests ────────────────────────────────────────────────────

describe("Storage path normalization — cross-platform consistency", () => {
  // ─── Storage keys ────────────────────────────────────────────

  describe("deriveStorageKey", () => {
    it("Windows and Unix paths produce the same key", () => {
      const winKey = deriveStorageKey("dalam.session", "C:\\Users\\dev\\project");
      const unixKey = deriveStorageKey("dalam.session", "/Users/dev/project");
      expect(winKey).toBe(unixKey);
    });

    it("mixed separators produce consistent keys", () => {
      const key1 = deriveStorageKey("dalam.session", "C:/Users\\dev\\project");
      const key2 = deriveStorageKey("dalam.session", "C:\\Users/dev/project");
      expect(key1).toBe(key2);
    });

    it("keys have consistent structure", () => {
      const key = deriveStorageKey("dalam.session", "/home/user/project");
      expect(key).toMatch(/^dalam\.session:/);
    });
  });

  // ─── Database paths ─────────────────────────────────────────

  describe("deriveDbDirPath — consistent across platforms", () => {
    it("both end with .dalam and use forward slashes", () => {
      const winPath = deriveDbDirPath("C:\\Users\\dev\\project");
      const unixPath = deriveDbDirPath("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam$/);
      expect(unixPath).toMatch(/\.dalam$/);
      expect(winPath).not.toContain("\\");
      expect(unixPath).not.toContain("\\");
    });

    it("have the same relative suffix", () => {
      const winPath = deriveDbDirPath("C:\\Users\\dev\\project");
      const unixPath = deriveDbDirPath("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });

    it("mixed separators produce consistent path", () => {
      const p1 = deriveDbDirPath("C:/Users\\dev\\project");
      const p2 = deriveDbDirPath("C:\\Users/dev/project");
      expect(toPosix(p1)).toBe(toPosix(p2));
    });
  });

  describe("deriveDbFilePath — consistent across platforms", () => {
    it("both end with .dalam/project.db and use forward slashes", () => {
      const winPath = deriveDbFilePath("C:\\Users\\dev\\project");
      const unixPath = deriveDbFilePath("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam\/project\.db$/);
      expect(unixPath).toMatch(/\.dalam\/project\.db$/);
      expect(winPath).not.toContain("\\");
      expect(unixPath).not.toContain("\\");
    });

    it("have the same relative suffix", () => {
      const winPath = deriveDbFilePath("C:\\Users\\dev\\project");
      const unixPath = deriveDbFilePath("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  // ─── Memory paths ───────────────────────────────────────────

  describe("deriveMemoriesDir — consistent across platforms", () => {
    it("both end with .dalam/memories", () => {
      const winPath = deriveMemoriesDir("C:\\Users\\dev\\project");
      const unixPath = deriveMemoriesDir("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam\/memories$/);
      expect(unixPath).toMatch(/\.dalam\/memories$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveMemoriesDir("C:\\Users\\dev\\project");
      const unixPath = deriveMemoriesDir("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  describe("deriveMemoryFilePath — consistent across platforms", () => {
    it("both end with .dalam/memories/<category>-<id>.md", () => {
      const winPath = deriveMemoryFilePath("C:\\Users\\dev\\project", "project", "abc12345");
      const unixPath = deriveMemoryFilePath("/Users/dev/project", "project", "abc12345");
      expect(winPath).toMatch(/\.dalam\/memories\/project-abc12345\.md$/);
      expect(unixPath).toMatch(/\.dalam\/memories\/project-abc12345\.md$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveMemoryFilePath("C:\\Users\\dev\\project", "project", "abc12345");
      const unixPath = deriveMemoryFilePath("/Users/dev/project", "project", "abc12345");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  // ─── Trajectory paths ───────────────────────────────────────

  describe("deriveTrajectoryDir — consistent across platforms", () => {
    it("both end with .dalam/trajectories", () => {
      const winPath = deriveTrajectoryDir("C:\\Users\\dev\\project");
      const unixPath = deriveTrajectoryDir("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam\/trajectories$/);
      expect(unixPath).toMatch(/\.dalam\/trajectories$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveTrajectoryDir("C:\\Users\\dev\\project");
      const unixPath = deriveTrajectoryDir("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  describe("deriveTrajectoryFilePath — consistent across platforms", () => {
    it("both end with .dalam/trajectories/trajectory-<id>.jsonl", () => {
      const winPath = deriveTrajectoryFilePath("C:\\Users\\dev\\project", "sess-123");
      const unixPath = deriveTrajectoryFilePath("/Users/dev/project", "sess-123");
      expect(winPath).toMatch(/\.dalam\/trajectories\/trajectory-sess-123\.jsonl$/);
      expect(unixPath).toMatch(/\.dalam\/trajectories\/trajectory-sess-123\.jsonl$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveTrajectoryFilePath("C:\\Users\\dev\\project", "sess-123");
      const unixPath = deriveTrajectoryFilePath("/Users/dev/project", "sess-123");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  // ─── Skills paths ───────────────────────────────────────────

  describe("deriveSkillsDir — consistent across platforms", () => {
    it("both end with .dalam/skills", () => {
      const winPath = deriveSkillsDir("C:\\Users\\dev\\project");
      const unixPath = deriveSkillsDir("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam\/skills$/);
      expect(unixPath).toMatch(/\.dalam\/skills$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveSkillsDir("C:\\Users\\dev\\project");
      const unixPath = deriveSkillsDir("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  describe("deriveSkillFilePath — consistent across platforms", () => {
    it("both end with .dalam/skills/<name>/SKILL.md", () => {
      const winPath = deriveSkillFilePath("C:\\Users\\dev\\project", "my-skill");
      const unixPath = deriveSkillFilePath("/Users/dev/project", "my-skill");
      expect(winPath).toMatch(/\.dalam\/skills\/my-skill\/SKILL\.md$/);
      expect(unixPath).toMatch(/\.dalam\/skills\/my-skill\/SKILL\.md$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveSkillFilePath("C:\\Users\\dev\\project", "my-skill");
      const unixPath = deriveSkillFilePath("/Users/dev/project", "my-skill");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  // ─── Memory index ───────────────────────────────────────────

  describe("deriveMemoryIndexPath — consistent across platforms", () => {
    it("both end with .dalam/MEMORY.md", () => {
      const winPath = deriveMemoryIndexPath("C:\\Users\\dev\\project");
      const unixPath = deriveMemoryIndexPath("/Users/dev/project");
      expect(winPath).toMatch(/\.dalam\/MEMORY\.md$/);
      expect(unixPath).toMatch(/\.dalam\/MEMORY\.md$/);
    });

    it("have the same relative suffix", () => {
      const winPath = deriveMemoryIndexPath("C:\\Users\\dev\\project");
      const unixPath = deriveMemoryIndexPath("/Users/dev/project");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\project")).toBe(
        relativeSuffix(unixPath, "/Users/dev/project")
      );
    });
  });

  // ─── basename/dirname on normalized paths ───────────────────

  describe("basename on normalized storage paths", () => {
    it("extracts correct basename from Windows-normalized path", () => {
      const path = deriveDbFilePath("C:\\Users\\dev\\project");
      expect(basename(path)).toBe("project.db");
    });

    it("extracts correct basename from Unix path", () => {
      const path = deriveDbFilePath("/Users/dev/project");
      expect(basename(path)).toBe("project.db");
    });

    it("extracts correct basename from memory file path", () => {
      const path = deriveMemoryFilePath("C:\\Users\\dev\\project", "project", "abc12345");
      expect(basename(path)).toBe("project-abc12345.md");
    });

    it("extracts correct basename from trajectory file path", () => {
      const path = deriveTrajectoryFilePath("/Users/dev/project", "sess-123");
      expect(basename(path)).toBe("trajectory-sess-123.jsonl");
    });
  });

  describe("dirname on normalized storage paths", () => {
    it("extracts correct dirname from Windows-normalized path", () => {
      const path = deriveDbFilePath("C:\\Users\\dev\\project");
      const dir = dirname(path);
      expect(dir).toMatch(/\.dalam$/);
    });

    it("extracts correct dirname from memory file path", () => {
      const path = deriveMemoryFilePath("C:\\Users\\dev\\project", "project", "abc12345");
      const dir = dirname(path);
      expect(dir).toMatch(/\.dalam\/memories$/);
    });

    it("extracts correct dirname from trajectory file path", () => {
      const path = deriveTrajectoryFilePath("/Users/dev/project", "sess-123");
      const dir = dirname(path);
      expect(dir).toMatch(/\.dalam\/trajectories$/);
    });
  });

  // ─── splitPath on normalized paths ──────────────────────────

  describe("splitPath on normalized storage paths", () => {
    it("splits Windows-normalized path correctly", () => {
      const path = deriveMemoriesDir("C:\\Users\\dev\\project");
      const parts = splitPath(path);
      expect(parts).toContain(".dalam");
      expect(parts).toContain("memories");
      expect(parts).not.toContain("\\");
    });

    it("splits Unix path correctly", () => {
      const path = deriveMemoriesDir("/Users/dev/project");
      const parts = splitPath(path);
      expect(parts).toContain(".dalam");
      expect(parts).toContain("memories");
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────

  describe("Edge cases — unusual workspace paths", () => {
    it("workspace with spaces produces valid paths", () => {
      const winPath = deriveDbFilePath("C:\\Users\\me\\my project\\folder");
      const unixPath = deriveDbFilePath("/Users/me/my project/folder");
      expect(winPath).toContain("my project");
      expect(unixPath).toContain("my project");
      expect(relativeSuffix(winPath, "C:\\Users\\me\\my project\\folder")).toBe(
        relativeSuffix(unixPath, "/Users/me/my project/folder")
      );
    });

    it("workspace with special characters produces valid paths", () => {
      const winPath = deriveDbDirPath("C:\\Users\\dev\\app-v2.0 (copy)");
      const unixPath = deriveDbDirPath("/Users/dev/app-v2.0 (copy)");
      expect(winPath).toContain("app-v2.0 (copy)");
      expect(relativeSuffix(winPath, "C:\\Users\\dev\\app-v2.0 (copy)")).toBe(
        relativeSuffix(unixPath, "/Users/dev/app-v2.0 (copy)")
      );
    });

    it("deeply nested workspace produces valid paths", () => {
      const winPath = deriveDbFilePath("C:\\a\\b\\c\\d\\e\\f\\g\\project");
      const unixPath = deriveDbFilePath("/a/b/c/d/e/f/g/project");
      expect(winPath).toMatch(/\.dalam\/project\.db$/);
      expect(relativeSuffix(winPath, "C:\\a\\b\\c\\d\\e\\f\\g\\project")).toBe(
        relativeSuffix(unixPath, "/a/b/c/d/e/f/g/project")
      );
    });

    it("workspace root path produces valid paths", () => {
      const path = deriveDbFilePath("/");
      expect(path).toMatch(/\.dalam\/project\.db$/);
    });

    it("UNC path produces valid paths", () => {
      const path = deriveDbFilePath("\\\\server\\share\\project");
      expect(path).toMatch(/\.dalam\/project\.db$/);
      expect(path).not.toContain("\\");
    });
  });
});
