import { describe, it, expect } from "vitest";
import { computeDiff } from "./diff";

describe("diff", () => {
  describe("basic operations", () => {
    it("returns empty for identical texts", () => {
      const result = computeDiff("hello\nworld", "hello\nworld");
      expect(result.hunks).toHaveLength(0);
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it("detects additions", () => {
      const result = computeDiff("line1", "line1\nline2");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(0);
      expect(result.hunks.length).toBeGreaterThan(0);
    });

    it("detects deletions", () => {
      const result = computeDiff("line1\nline2", "line1");
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(1);
    });

    it("detects modifications", () => {
      const result = computeDiff("line1\nline2", "line1\nmodified");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty old text", () => {
      const result = computeDiff("", "new content");
      expect(result.additions).toBeGreaterThanOrEqual(1);
    });

    it("handles empty new text", () => {
      const result = computeDiff("old content", "");
      expect(result.deletions).toBeGreaterThanOrEqual(1);
    });

    it("handles both empty", () => {
      const result = computeDiff("", "");
      expect(result.hunks).toHaveLength(0);
    });

    it("handles single line files", () => {
      const result = computeDiff("hello", "world");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("handles files with only whitespace changes", () => {
      const result = computeDiff("line1\n\nline3", "line1\n  \nline3");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("handles files with trailing newlines", () => {
      const result = computeDiff("line1\nline2\n", "line1\nline2");
      expect(result.deletions).toBe(1);
    });

    it("handles files with CRLF line endings", () => {
      const result = computeDiff("line1\r\nline2", "line1\r\nline3");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("handles special characters", () => {
      const result = computeDiff("line with \\n newline", "line with \\t tab");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("handles unicode content", () => {
      const result = computeDiff("Hello 世界", "Hello 🌍");
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("handles very long lines", () => {
      const longLine = "x".repeat(10000);
      const result = computeDiff(longLine, longLine + " extra");
      expect(result.additions).toBe(1);
    });
  });

  describe("hunk generation", () => {
    it("computes hunks with context lines", () => {
      const old = "a\nb\nc\nd\ne";
      const _new = "a\nb\nmodified\nd\ne";
      const result = computeDiff(old, _new, 1);
      expect(result.hunks.length).toBeGreaterThan(0);
      const hunk = result.hunks[0];
      expect(hunk.lines.length).toBeGreaterThan(1);
    });

    it("merges adjacent hunks", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      const newLines = [...lines];
      newLines[5] = "changed 5";
      newLines[7] = "changed 7";
      const result = computeDiff(lines.join("\n"), newLines.join("\n"), 2);

      expect(result.hunks).toHaveLength(1);
    });

    it("keeps separate hunks for distant changes", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      const newLines = [...lines];
      newLines[5] = "changed 5";
      newLines[95] = "changed 95";
      const result = computeDiff(lines.join("\n"), newLines.join("\n"), 2);
      expect(result.hunks.length).toBeGreaterThanOrEqual(2);
    });

    it("includes correct line numbers", () => {
      const old = "a\nb\nc";
      const _new = "a\nb\nnew\nc";
      const result = computeDiff(old, _new, 1);
      const hunk = result.hunks[0];
      expect(hunk.oldStart).toBeGreaterThanOrEqual(1);
      expect(hunk.newStart).toBeGreaterThanOrEqual(1);
    });
  });

  describe("large file handling", () => {
    it("handles files with 1000+ lines", () => {
      const oldLines = Array.from({ length: 1000 }, (_, i) => `old line ${i}`);
      const newLines = [...oldLines];
      newLines[500] = "modified line 500";
      const result = computeDiff(oldLines.join("\n"), newLines.join("\n"), 3);
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
    });

    it("falls back to simple diff for very large files", () => {
      const oldLines = Array.from({ length: 30000 }, (_, i) => `line ${i}`);
      const newLines = [...oldLines];
      newLines[100] = "changed";
      const result = computeDiff(oldLines.join("\n"), newLines.join("\n"), 3);
      expect(result.hunks.length).toBeGreaterThan(0);
    });
  });

  describe("patience diff", () => {
    it("uses patience diff for files with many identical lines", () => {
      const oldLines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
      const newLines = [...oldLines];
      newLines[100] = "changed 100";
      newLines[200] = "changed 200";
      const result = computeDiff(oldLines.join("\n"), newLines.join("\n"), 3);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(2);
    });
  });
});
