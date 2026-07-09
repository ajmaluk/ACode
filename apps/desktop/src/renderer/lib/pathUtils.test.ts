import { describe, it, expect } from "vitest";
import {
  basename,
  dirname,
  joinPath,
  toPosix,
  splitPath,
  shortPath,
  pathsEqual,
} from "./pathUtils";

describe("pathUtils", () => {
  describe("basename", () => {
    it("returns filename from unix path", () =>
      expect(basename("/src/main.ts")).toBe("main.ts"));
    it("returns filename from windows path", () =>
      expect(basename("C:\\src\\main.ts")).toBe("main.ts"));
    it("returns empty for empty input", () => expect(basename("")).toBe(""));
  });

  describe("dirname", () => {
    it("returns directory from unix path", () =>
      expect(dirname("/src/main.ts")).toBe("/src"));
    it("returns '.' for bare filename", () =>
      expect(dirname("main.ts")).toBe("."));
    it("returns '/' for root file", () =>
      expect(dirname("/main.ts")).toBe("/"));
  });

  describe("joinPath", () => {
    it("joins segments", () =>
      expect(joinPath("src", "components", "App.tsx")).toBe(
        "src/components/App.tsx",
      ));
    it("handles empty segments", () =>
      expect(joinPath("src", "", "App.tsx")).toBe("src/App.tsx"));
    it("normalizes double slashes", () =>
      expect(joinPath("src/", "/App.tsx")).toBe("src/App.tsx"));
    it("handles windows backslashes", () =>
      expect(joinPath("src\\", "App.tsx")).toBe("src/App.tsx"));
  });

  describe("toPosix", () => {
    it("converts backslashes", () =>
      expect(toPosix("src\\main.ts")).toBe("src/main.ts"));
    it("leaves forward slashes", () =>
      expect(toPosix("src/main.ts")).toBe("src/main.ts"));
  });

  describe("splitPath", () => {
    it("splits unix path", () =>
      expect(splitPath("/src/main.ts")).toEqual(["src", "main.ts"]));
    it("filters empty segments", () =>
      expect(splitPath("//src//main.ts")).toEqual(["src", "main.ts"]));
  });

  describe("shortPath", () => {
    it("shows full path when short", () =>
      expect(shortPath("src/main.ts")).toBe("src/main.ts"));
    it("truncates long paths", () =>
      expect(shortPath("src/components/ui/Button.tsx")).toBe(
        "…/components/ui/Button.tsx",
      ));
  });

  describe("pathsEqual", () => {
    it("equal paths match", () =>
      expect(pathsEqual("/src/main.ts", "/src/main.ts")).toBe(true));
    it("different paths don't match", () =>
      expect(pathsEqual("/src/main.ts", "/src/App.tsx")).toBe(false));
  });

  describe("joinPath - Windows drive letters", () => {
    it("handles C: drive letter prefix", () =>
      expect(joinPath("C:/Users/dev", "project", "src", "main.ts")).toBe(
        "C:/Users/dev/project/src/main.ts",
      ));
    it("handles mixed C: and forward slashes", () =>
      expect(joinPath("C:/Users/dev", "project")).toBe("C:/Users/dev/project"));
    it("handles D: drive letter", () =>
      expect(joinPath("D:/projects/my-app", "src")).toBe(
        "D:/projects/my-app/src",
      ));
    it("handles drive letter with just a filename", () =>
      expect(joinPath("C:/autoexec.bat")).toBe("C:/autoexec.bat"));
    it("preserves drive letter with relative path", () =>
      expect(joinPath("C:/Users/dev", "..", "other")).toBe("C:/Users/other"));
    it("handles UNC paths", () =>
      expect(joinPath("//server/share/project", "src")).toBe(
        "/server/share/project/src",
      ));
    it("handles drive letter with complex nesting", () =>
      expect(joinPath("C:/a/b/c", "d/e/f")).toBe("C:/a/b/c/d/e/f"));
  });

  describe("dirname - Windows paths", () => {
    it("extracts dirname from C: drive path", () =>
      expect(dirname("C:/Users/dev/main.ts")).toBe("C:/Users/dev"));
    it("returns C: for bare drive prefix", () =>
      expect(dirname("C:")).toBe("C:"));
  });

  describe("toPosix - Windows paths", () => {
    it("converts C: drive path", () =>
      expect(toPosix("C:\\Users\\dev\\main.ts")).toBe("C:/Users/dev/main.ts"));
    it("preserves already-posix C: path", () =>
      expect(toPosix("C:/Users/dev/main.ts")).toBe("C:/Users/dev/main.ts"));
  });

  describe("splitPath - Windows paths", () => {
    it("splits C: drive path", () =>
      expect(splitPath("C:/Users/dev/main.ts")).toEqual([
        "C:",
        "Users",
        "dev",
        "main.ts",
      ]));
    it("splits D: drive path", () =>
      expect(splitPath("D:/projects/my-app")).toEqual([
        "D:",
        "projects",
        "my-app",
      ]));
  });

  describe("shortPath - Windows paths", () => {
    it("preserves short C: path", () =>
      expect(shortPath("C:/src/main.ts")).toBe("C:/src/main.ts"));
    it("truncates long C: path", () =>
      expect(shortPath("C:/src/components/ui/Button.tsx")).toBe(
        "C:…/components/ui/Button.tsx",
      ));
  });

  describe("pathsEqual - Windows paths", () => {
    it("equal C: paths match", () =>
      expect(pathsEqual("C:/src/main.ts", "C:/src/main.ts")).toBe(true));
    it("different C: paths don't match", () =>
      expect(pathsEqual("C:/src/main.ts", "C:/src/App.tsx")).toBe(false));
    it("case-insensitive C: paths match", () =>
      expect(pathsEqual("C:/Src/Main.ts", "c:/src/main.ts", true)).toBe(true));
  });
});
