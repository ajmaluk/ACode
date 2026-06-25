import { describe, it, expect } from "vitest";
import { basename, dirname, joinPath, toPosix, splitPath, shortPath, pathsEqual } from "./pathUtils";

describe("pathUtils", () => {
  describe("basename", () => {
    it("returns filename from unix path", () => expect(basename("/src/main.ts")).toBe("main.ts"));
    it("returns filename from windows path", () => expect(basename("C:\\src\\main.ts")).toBe("main.ts"));
    it("returns empty for empty input", () => expect(basename("")).toBe(""));
  });

  describe("dirname", () => {
    it("returns directory from unix path", () => expect(dirname("/src/main.ts")).toBe("/src"));
    it("returns '.' for bare filename", () => expect(dirname("main.ts")).toBe("."));
    it("returns '/' for root file", () => expect(dirname("/main.ts")).toBe("/"));
  });

  describe("joinPath", () => {
    it("joins segments", () => expect(joinPath("src", "components", "App.tsx")).toBe("src/components/App.tsx"));
    it("handles empty segments", () => expect(joinPath("src", "", "App.tsx")).toBe("src/App.tsx"));
    it("normalizes double slashes", () => expect(joinPath("src/", "/App.tsx")).toBe("src/App.tsx"));
    it("handles windows backslashes", () => expect(joinPath("src\\", "App.tsx")).toBe("src/App.tsx"));
  });

  describe("toPosix", () => {
    it("converts backslashes", () => expect(toPosix("src\\main.ts")).toBe("src/main.ts"));
    it("leaves forward slashes", () => expect(toPosix("src/main.ts")).toBe("src/main.ts"));
  });

  describe("splitPath", () => {
    it("splits unix path", () => expect(splitPath("/src/main.ts")).toEqual(["src", "main.ts"]));
    it("filters empty segments", () => expect(splitPath("//src//main.ts")).toEqual(["src", "main.ts"]));
  });

  describe("shortPath", () => {
    it("shows full path when short", () => expect(shortPath("src/main.ts")).toBe("src/main.ts"));
    it("truncates long paths", () => expect(shortPath("src/components/ui/Button.tsx")).toBe("…/components/ui/Button.tsx"));
  });

  describe("pathsEqual", () => {
    it("equal paths match", () => expect(pathsEqual("/src/main.ts", "/src/main.ts")).toBe(true));
    it("different paths don't match", () => expect(pathsEqual("/src/main.ts", "/src/App.tsx")).toBe(false));
  });
});
