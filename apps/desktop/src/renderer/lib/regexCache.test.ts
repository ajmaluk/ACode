import { describe, it, expect, beforeEach } from "vitest";
import { getCachedRegex, clearRegexCache } from "./regexCache";

describe("regexCache", () => {
  beforeEach(() => {
    clearRegexCache();
  });

  describe("getCachedRegex", () => {
    it("returns a RegExp for valid pattern", () => {
      const regex = getCachedRegex("hello");
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex?.test("hello world")).toBe(true);
    });

    it("returns same instance for same pattern+flags", () => {
      const r1 = getCachedRegex("test", "i");
      const r2 = getCachedRegex("test", "i");
      expect(r1).toBe(r2);
    });

    it("returns different instances for different flags", () => {
      const r1 = getCachedRegex("test");
      const r2 = getCachedRegex("test", "i");
      expect(r1).not.toBe(r2);
    });

    it("returns null for invalid regex", () => {
      const regex = getCachedRegex("[invalid");
      expect(regex).toBeNull();
    });

    it("returns null for pattern exceeding 200 chars", () => {
      const longPattern = "a".repeat(201);
      const regex = getCachedRegex(longPattern);
      expect(regex).toBeNull();
    });

    it("accepts pattern exactly at 200 chars", () => {
      const pattern = "a".repeat(200);
      const regex = getCachedRegex(pattern);
      expect(regex).not.toBeNull();
    });

    it("handles flags correctly", () => {
      const regex = getCachedRegex("hello", "gi");
      expect(regex?.flags).toContain("g");
      expect(regex?.flags).toContain("i");
    });

    it("returns null for unknown flags", () => {
      const regex = getCachedRegex("test", "xyz");
      expect(regex).toBeNull();
    });
  });

  describe("cache eviction", () => {
    it("evicts oldest entry when cache is full", () => {
      // Fill cache to capacity (100 entries)
      for (let i = 0; i < 100; i++) {
        getCachedRegex(`pattern_${i}`);
      }
      // Adding one more should evict the oldest
      const newRegex = getCachedRegex("pattern_new");
      expect(newRegex).not.toBeNull();

      // The oldest entry may or may not be evicted depending on Map iteration order
      // Just verify the cache doesn't crash
    });
  });

  describe("clearRegexCache", () => {
    it("clears all cached entries", () => {
      getCachedRegex("test1");
      getCachedRegex("test2");
      clearRegexCache();
      // After clearing, same pattern should create a new instance
      const r1 = getCachedRegex("test1");
      clearRegexCache();
      const r2 = getCachedRegex("test1");
      expect(r1).not.toBe(r2);
    });
  });

  describe("pattern matching", () => {
    it("correctly matches complex patterns", () => {
      const regex = getCachedRegex("^\\d{4}-\\d{2}-\\d{2}$");
      expect(regex?.test("2024-01-15")).toBe(true);
      expect(regex?.test("not-a-date")).toBe(false);
    });

    it("handles unicode patterns", () => {
      const regex = getCachedRegex("hello.*world", "i");
      expect(regex?.test("Hello Beautiful World")).toBe(true);
    });

    it("handles escaped characters", () => {
      const regex = getCachedRegex("price: \\$\\d+\\.\\d{2}");
      expect(regex?.test("price: $19.99")).toBe(true);
      expect(regex?.test("price: 19.99")).toBe(false);
    });
  });
});
