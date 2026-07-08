/**
 * Cross-platform integration tests for SQLite database initialization.
 *
 * Tests that the database path normalization works correctly on both
 * Windows and Unix path formats, ensuring the SQLite connection string
 * is valid regardless of the host OS.
 *
 * These tests exercise the full path-to-URI pipeline that
 * initDatabase() uses internally, without requiring a running Tauri app.
 */
import { describe, it, expect } from "vitest";
import { normalizeDbPath } from "../database";

// ─── Helper: simulate what initDatabase does with the normalized path ────

/** Extract the .dalam directory path from a normalized sqlite: URI */
function extractDotDalamPath(uri: string): string {
  return uri.replace(/^sqlite:/, "").replace(/\/project\.db$/, "");
}

/** Extract the project.db path from a normalized sqlite: URI */
function extractDbFilePath(uri: string): string {
  return uri.replace(/^sqlite:/, "");
}

describe("Cross-platform SQLite database initialization", () => {
  // ─── Windows path formats ────────────────────────────────────

  describe("Windows paths → valid SQLite URI", () => {
    const windowsPaths = [
      { input: "C:\\Users\\dev\\my-project", expected: "sqlite:/C:/Users/dev/my-project/.dalam/project.db" },
      { input: "D:\\work\\repos\\dalam", expected: "sqlite:/D:/work/repos/dalam/.dalam/project.db" },
      { input: "E:\\projects\\app\\sub\\deep", expected: "sqlite:/E:/projects/app/sub/deep/.dalam/project.db" },
      { input: "C:\\", expected: "sqlite:/C:/.dalam/project.db" },
      { input: "C:\\project", expected: "sqlite:/C:/project/.dalam/project.db" },
    ];

    for (const { input, expected } of windowsPaths) {
      it(`normalizes "${input}" to valid URI`, () => {
        const uri = normalizeDbPath(input);
        expect(uri).toBe(expected);
        // URI must start with sqlite:
        expect(uri).toMatch(/^sqlite:/);
        // Must end with .dalam/project.db
        expect(uri).toMatch(/\.dalam\/project\.db$/);
        // .dalam directory must be extractable
        const dotDalam = extractDotDalamPath(uri);
        expect(dotDalam).toMatch(/\.dalam$/);
        // DB file path must be valid (no backslashes)
        const dbPath = extractDbFilePath(uri);
        expect(dbPath).not.toContain("\\");
      });
    }
  });

  describe("Windows mixed separators → normalized URI", () => {
    const mixedPaths = [
      { input: "C:/Users\\me\\project", expected: "sqlite:/C:/Users/me/project/.dalam/project.db" },
      { input: "D:\\work/side", expected: "sqlite:/D:/work/side/.dalam/project.db" },
      { input: "C:\\Users\\me\\project\\", expected: "sqlite:/C:/Users/me/project/.dalam/project.db" },
      { input: "C:\\Users\\me\\project\\\\\\", expected: "sqlite:/C:/Users/me/project/.dalam/project.db" },
    ];

    for (const { input, expected } of mixedPaths) {
      it(`normalizes mixed-separator "${input}" correctly`, () => {
        expect(normalizeDbPath(input)).toBe(expected);
      });
    }
  });

  // ─── Unix path formats ──────────────────────────────────────

  describe("Unix paths → valid SQLite URI", () => {
    const unixPaths = [
      { input: "/home/user/project", expected: "sqlite:/home/user/project/.dalam/project.db" },
      { input: "/var/www/html/app", expected: "sqlite:/var/www/html/app/.dalam/project.db" },
      { input: "/Users/dev/Projects/dalam", expected: "sqlite:/Users/dev/Projects/dalam/.dalam/project.db" },
      { input: "/opt/apps/my-project", expected: "sqlite:/opt/apps/my-project/.dalam/project.db" },
    ];

    for (const { input, expected } of unixPaths) {
      it(`normalizes "${input}" to valid URI`, () => {
        const uri = normalizeDbPath(input);
        expect(uri).toBe(expected);
        expect(uri).toMatch(/^sqlite:/);
        expect(uri).toMatch(/\.dalam\/project\.db$/);
        expect(extractDbFilePath(uri)).not.toContain("\\");
      });
    }
  });

  describe("Unix trailing slashes → stripped", () => {
    const trailingPaths = [
      { input: "/home/user/project/", expected: "sqlite:/home/user/project/.dalam/project.db" },
      { input: "/home/user/project///", expected: "sqlite:/home/user/project/.dalam/project.db" },
    ];

    for (const { input, expected } of trailingPaths) {
      it(`strips trailing slashes from "${input}"`, () => {
        expect(normalizeDbPath(input)).toBe(expected);
      });
    }
  });

  // ─── Cross-platform determinism ──────────────────────────────

  describe("Cross-platform determinism", () => {
    it("Windows C:\\Users\\me\\project matches C:/Users/me/project", () => {
      const win = normalizeDbPath("C:\\Users\\me\\project");
      const unix = normalizeDbPath("C:/Users/me/project");
      expect(win).toBe(unix);
    });

    it("Windows D:\\work\\app matches D:/work/app", () => {
      const win = normalizeDbPath("D:\\work\\app");
      const unix = normalizeDbPath("D:/work/app");
      expect(win).toBe(unix);
    });

    it("all paths produce URIs without backslashes", () => {
      const paths = [
        "C:\\Users\\dev\\project",
        "/home/user/project",
        "relative/path",
        "D:\\mixed\\separators/here",
      ];
      for (const p of paths) {
        const uri = normalizeDbPath(p);
        expect(uri).not.toContain("\\");
      }
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────

  describe("Edge cases", () => {
    it("empty string → minimal valid URI", () => {
      const uri = normalizeDbPath("");
      expect(uri).toBe("sqlite:.dalam/project.db");
      expect(uri).toMatch(/^sqlite:/);
    });

    it("root path / → valid URI", () => {
      const uri = normalizeDbPath("/");
      expect(uri).toBe("sqlite://.dalam/project.db");
    });

    it("relative path → gets / prefix", () => {
      const uri = normalizeDbPath("relative/path");
      expect(uri).toBe("sqlite:/relative/path/.dalam/project.db");
      expect(extractDbFilePath(uri)).toMatch(/^\//);
    });

    it("path with spaces → preserved in URI", () => {
      const uri = normalizeDbPath("C:\\Users\\me\\my project\\folder");
      expect(uri).toBe("sqlite:/C:/Users/me/my project/folder/.dalam/project.db");
      expect(extractDbFilePath(uri)).toContain("my project");
    });

    it("path with unicode → preserved in URI", () => {
      const uri = normalizeDbPath("/home/user/文档/项目");
      expect(uri).toContain("文档");
      expect(uri).toContain("项目");
    });

    it("path with special chars → preserved in URI", () => {
      const uri = normalizeDbPath("/home/user/my_app-v2.0 (copy)");
      expect(uri).toContain("my_app-v2.0 (copy)");
    });

    it("UNC path → valid URI", () => {
      const uri = normalizeDbPath("\\\\server\\share\\project");
      expect(uri).toBe("sqlite://server/share/project/.dalam/project.db");
    });

    it("dot path → valid URI", () => {
      const uri = normalizeDbPath(".");
      expect(uri).toBe("sqlite:/./.dalam/project.db");
    });

    it("dotdot path → valid URI", () => {
      const uri = normalizeDbPath("..");
      expect(uri).toBe("sqlite:/../.dalam/project.db");
    });
  });

  // ─── URI structure validation ────────────────────────────────

  describe("URI structure validation", () => {
    it("every URI contains exactly one .dalam/project.db", () => {
      const paths = [
        "C:\\Users\\dev\\project",
        "/home/user/project",
        "/",
        "",
        "relative/path",
        "C:\\",
      ];
      for (const p of paths) {
        const uri = normalizeDbPath(p);
        const matches = uri.match(/\.dalam\/project\.db/g);
        expect(matches).toHaveLength(1);
      }
    });

    it("every URI starts with sqlite:", () => {
      const paths = ["C:\\Users\\dev\\project", "/home/user/project", "", "/", "relative"];
      for (const p of paths) {
        expect(normalizeDbPath(p)).toMatch(/^sqlite:/);
      }
    });

    it("no URI contains double slashes in path (except after sqlite:)", () => {
      const paths = ["C:\\Users\\dev\\project", "/home/user/project", "/home/user/project/"];
      for (const p of paths) {
        const uri = normalizeDbPath(p);
        // Remove the sqlite: prefix and check for double slashes
        const pathPart = uri.replace(/^sqlite:/, "");
        // pathPart should not have // except at the start (for root)
        const withoutLeading = pathPart.replace(/^\/\//, "/");
        expect(withoutLeading).not.toMatch(/\/\//);
      }
    });
  });

  // ─── Determinism & idempotency ───────────────────────────────

  describe("Determinism & idempotency", () => {
    it("same input always produces same output", () => {
      const input = "C:\\Users\\me\\project";
      expect(normalizeDbPath(input)).toBe(normalizeDbPath(input));
      expect(normalizeDbPath(input)).toBe(normalizeDbPath(input));
    });

    it("different order of separators produces same result", () => {
      expect(normalizeDbPath("C:\\a\\b\\c")).toBe(normalizeDbPath("C:/a/b/c"));
    });
  });
});
