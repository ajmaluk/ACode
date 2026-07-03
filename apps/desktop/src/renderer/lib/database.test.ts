import { describe, it, expect } from "vitest";
import { normalizeDbPath } from "./database";

describe("normalizeDbPath", () => {
  // ─── Windows paths ───────────────────────────────────────────

  it("converts Windows backslash path to forward-slash sqlite URI", () => {
    expect(normalizeDbPath("C:\\Users\\me\\my-project")).toBe(
      "sqlite:/C:/Users/me/my-project/.dalam/project.db"
    );
  });

  it("handles Windows path with drive letter only", () => {
    expect(normalizeDbPath("D:\\")).toBe("sqlite:/D:/.dalam/project.db");
  });

  it("handles Windows deep nested path", () => {
    expect(normalizeDbPath("C:\\Users\\john\\Documents\\workspace\\app")).toBe(
      "sqlite:/C:/Users/john/Documents/workspace/app/.dalam/project.db"
    );
  });

  it("handles Windows path with mixed separators (already some forward slashes)", () => {
    expect(normalizeDbPath("C:/Users\\me\\project")).toBe(
      "sqlite:/C:/Users/me/project/.dalam/project.db"
    );
  });

  it("handles Windows path with trailing backslash", () => {
    expect(normalizeDbPath("C:\\Users\\me\\project\\")).toBe(
      "sqlite:/C:/Users/me/project/.dalam/project.db"
    );
  });

  it("handles Windows network path (UNC)", () => {
    expect(normalizeDbPath("\\\\server\\share\\project")).toBe(
      "sqlite://server/share/project/.dalam/project.db"
    );
  });

  // ─── Unix paths ─────────────────────────────────────────────

  it("preserves Unix absolute path", () => {
    expect(normalizeDbPath("/home/user/project")).toBe(
      "sqlite:/home/user/project/.dalam/project.db"
    );
  });

  it("handles Unix path with trailing slash", () => {
    expect(normalizeDbPath("/home/user/project/")).toBe(
      "sqlite:/home/user/project/.dalam/project.db"
    );
  });

  it("handles deep Unix path", () => {
    expect(normalizeDbPath("/var/www/html/app")).toBe(
      "sqlite:/var/www/html/app/.dalam/project.db"
    );
  });

  it("handles Unix root path", () => {
    expect(normalizeDbPath("/")).toBe("sqlite://.dalam/project.db");
  });

  // ─── Edge cases ─────────────────────────────────────────────

  it("handles empty string", () => {
    expect(normalizeDbPath("")).toBe("sqlite:/.dalam/project.db");
  });

  it("handles relative path (no leading slash)", () => {
    expect(normalizeDbPath("relative/path")).toBe(
      "sqlite:/relative/path/.dalam/project.db"
    );
  });

  it("handles dot path", () => {
    expect(normalizeDbPath(".")).toBe("sqlite:/./.dalam/project.db");
  });

  it("handles path with spaces", () => {
    expect(normalizeDbPath("C:\\Users\\me\\my project\\folder")).toBe(
      "sqlite:/C:/Users/me/my project/folder/.dalam/project.db"
    );
  });

  it("handles path with special characters", () => {
    expect(normalizeDbPath("/home/user/my_app-v2.0 (copy)")).toBe(
      "sqlite:/home/user/my_app-v2.0 (copy)/.dalam/project.db"
    );
  });

  it("handles Windows path with single component", () => {
    expect(normalizeDbPath("C:\\project")).toBe(
      "sqlite:/C:/project/.dalam/project.db"
    );
  });

  // ─── macOS-style paths ──────────────────────────────────────

  it("handles macOS /Users path", () => {
    expect(normalizeDbPath("/Users/developer/Projects/dalam")).toBe(
      "sqlite:/Users/developer/Projects/dalam/.dalam/project.db"
    );
  });

  // ─── Determinism ────────────────────────────────────────────

  it("produces same result for semantically identical Windows and Unix paths", () => {
    const winResult = normalizeDbPath("C:\\Users\\me\\project");
    const unixResult = normalizeDbPath("C:/Users/me/project");
    expect(winResult).toBe(unixResult);
  });

  it("is deterministic — same input always produces same output", () => {
    const input = "C:\\Users\\me\\project";
    expect(normalizeDbPath(input)).toBe(normalizeDbPath(input));
  });
});
