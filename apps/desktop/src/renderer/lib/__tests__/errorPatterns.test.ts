/**
 * Tests for the Error Patterns module.
 *
 * Covers:
 * - matchErrorPattern with various error types
 * - Edge cases (no match, empty strings, partial matches)
 * - Auto-fix commands
 */
import { describe, it, expect } from "vitest";
import { matchErrorPattern, getErrorPatterns } from "../errorPatterns";

describe("matchErrorPattern", () => {
  it("matches Cannot find module errors", () => {
    const result = matchErrorPattern("Error: Cannot find module 'lodash'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("lodash");
    expect(result!.suggestion).toContain("npm install");
    expect(result!.autoFix).toBeDefined();
    expect(result!.autoFix!.command).toBe("npm install lodash");
  });

  it("matches Module not found errors (webpack)", () => {
    const result = matchErrorPattern("Module not found: Can't resolve 'react'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("react");
    expect(result!.autoFix).toBeDefined();
    expect(result!.autoFix!.command).toBe("npm install react");
  });

  it("matches TypeScript type mismatch", () => {
    const result = matchErrorPattern("Type 'string' is not assignable to type 'number'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("string");
    expect(result!.suggestion).toContain("number");
    expect(result!.autoFix).toBeUndefined();
  });

  it("matches missing property errors", () => {
    const result = matchErrorPattern("Property 'foobar' does not exist on type 'User'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("foobar");
    expect(result!.suggestion).toContain("User");
  });

  it("matches 'Object is possibly undefined' warnings", () => {
    const result = matchErrorPattern("Object is possibly 'undefined'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("null check");
  });

  it("matches 'is not a function' errors", () => {
    const result = matchErrorPattern("myVariable is not a function");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("myVariable");
  });

  it("matches Python ModuleNotFoundError", () => {
    const result = matchErrorPattern("ModuleNotFoundError: No module named 'requests'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("requests");
    expect(result!.autoFix).toBeDefined();
    expect(result!.autoFix!.command).toBe("pip install requests");
  });

  it("matches Python ImportError", () => {
    const result = matchErrorPattern("ImportError: cannot import name 'Client' from 'discord'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("Client");
    expect(result!.suggestion).toContain("discord");
  });

  it("matches Python SyntaxError", () => {
    const result = matchErrorPattern("SyntaxError: unexpected token ':'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("unexpected token ':'");
  });

  it("matches network connection refused", () => {
    const result = matchErrorPattern("ECONNREFUSED localhost:3000");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("localhost:3000");
    expect(result!.suggestion).toContain("server running");
  });

  it("matches network timeout", () => {
    const result = matchErrorPattern("ETIMEDOUT - request failed");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("timed out");
  });

  it("matches rate limit errors (case-insensitive)", () => {
    expect(matchErrorPattern("HTTP 429 Too Many Requests - rate limit exceeded")).not.toBeNull();
    expect(matchErrorPattern("429 Rate Limit Exceeded")).not.toBeNull();
    expect(matchErrorPattern("429 - rate_limit: please slow down")).not.toBeNull();
  });

  it("matches 401 unauthorized errors", () => {
    const result = matchErrorPattern("401 unauthorized - invalid token");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("API key");
  });

  it("matches 403 forbidden errors", () => {
    const result = matchErrorPattern("403 forbidden - access denied");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("permissions");
  });

  it("matches disk space errors", () => {
    const result = matchErrorPattern("ENOSPC: no space left on device");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("Free up disk");
  });

  it("matches permission denied errors", () => {
    const result = matchErrorPattern("EACCES: permission denied '/etc/hosts'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("Permission denied");
  });

  it("matches file not found errors", () => {
    const result = matchErrorPattern("ENOENT: no such file or directory, open 'foo.txt'");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("not found");
  });

  it("matches Docker daemon not running", () => {
    const result = matchErrorPattern("Cannot connect to the Docker daemon");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("Docker Desktop");
  });

  it("matches undefined identifier (Go)", () => {
    const result = matchErrorPattern("undefined: fmt.Println");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("fmt.Println");
  });

  it("matches git not a repository", () => {
    const result = matchErrorPattern("fatal: not a git repository");
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("git init");
  });

  it("returns null for unknown error", () => {
    const result = matchErrorPattern("Some completely unknown error message");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(matchErrorPattern("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(matchErrorPattern("   \n  ")).toBeNull();
  });

  it("matches partially within longer messages", () => {
    const result = matchErrorPattern(`[Error] Build failed: Cannot find module 'chalk'
    at require (internal/modules/cjs/helpers.js:88:18)`);
    expect(result).not.toBeNull();
    expect(result!.suggestion).toContain("chalk");
  });
});

describe("getErrorPatterns", () => {
  it("returns all registered error patterns", () => {
    const patterns = getErrorPatterns();
    expect(patterns.length).toBeGreaterThan(20);
    patterns.forEach((p) => {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.suggestion).toBe("string");
    });
  });
});
