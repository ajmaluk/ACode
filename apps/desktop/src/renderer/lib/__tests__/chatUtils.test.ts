import { describe, it, expect } from "vitest";
import { closeIncompleteMarkdown, splitCodeFences, formatTime } from "../chatUtils";

describe("formatTime", () => {
  it("formats a timestamp", () => {
    const result = formatTime(0);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThanOrEqual(4);
  });
});

describe("closeIncompleteMarkdown", () => {
  it("returns unchanged content when no markdown markers present", () => {
    expect(closeIncompleteMarkdown("Hello, world!")).toBe("Hello, world!");
  });

  it("handles empty string", () => {
    expect(closeIncompleteMarkdown("")).toBe("");
  });

  it("closes unclosed bold (**)", () => {
    expect(closeIncompleteMarkdown("Hello **world")).toBe("Hello **world**");
  });

  it("does not append when bold is already closed", () => {
    expect(closeIncompleteMarkdown("Hello **world**")).toBe("Hello **world**");
  });

  it("closes unclosed italic (*)", () => {
    expect(closeIncompleteMarkdown("Hello *world")).toBe("Hello *world*");
  });

  it("closes unclosed code fence (```)", () => {
    expect(closeIncompleteMarkdown("```\ncode\n")).toBe("```\ncode\n```");
  });

  it("does not append when code fence is closed", () => {
    expect(closeIncompleteMarkdown("```\ncode\n```")).toBe("```\ncode\n```");
  });

  it("closes unclosed inline backtick (`)", () => {
    expect(closeIncompleteMarkdown("Hello `world")).toBe("Hello `world`");
  });

  it("closes unclosed bracket ([)", () => {
    expect(closeIncompleteMarkdown("Hello [world")).toBe("Hello [world]");
  });

  it("closes multiple unclosed brackets", () => {
    expect(closeIncompleteMarkdown("[a [b")).toBe("[a [b]]");
  });

  it("closes unclosed link paren", () => {
    expect(closeIncompleteMarkdown("[text](url")).toBe("[text](url)");
  });

  it("does not close paren that is not part of a link", () => {
    expect(closeIncompleteMarkdown("Hello (world)")).toBe("Hello (world)");
  });

  it("handles link text with inline code before paren ([`code`](url)", () => {
    expect(closeIncompleteMarkdown("[`code`](url")).toBe("[`code`](url)");
  });

  it("does not count prose parens as link close", () => {
    expect(closeIncompleteMarkdown("(some parens) [text](url")).toBe("(some parens) [text](url)");
  });

  it("handles nested parens inside URL", () => {
    // Both parens are opened but not closed: one for the link, one nested inside the URL
    expect(closeIncompleteMarkdown("[text](url(with")).toBe("[text](url(with))");
  });

  it("closes strikethrough (~~)", () => {
    expect(closeIncompleteMarkdown("Hello ~~world")).toBe("Hello ~~world~~");
  });

  it("handles mixed incomplete markers", () => {
    expect(closeIncompleteMarkdown("**bold *italic* `code` [text](url")).toBe("**bold *italic* `code` [text](url**)");
  });

  it("handles text with no angle brackets (fast path)", () => {
    const result = closeIncompleteMarkdown("Plain text with no markers at all");
    expect(result).toBe("Plain text with no markers at all");
  });

  it("does not count escaped backticks inside inline code", () => {
    const result = closeIncompleteMarkdown("`code`");
    expect(result).toBe("`code`");
  });

  it("handles double backtick inline code", () => {
    const result = closeIncompleteMarkdown("``code``");
    expect(result).toBe("``code``");
  });

  it("skips backslash-escaped star", () => {
    expect(closeIncompleteMarkdown("Hello \\*world")).toBe("Hello \\*world");
  });

  it("skips backslash-escaped bracket", () => {
    expect(closeIncompleteMarkdown("Hello \\[world")).toBe("Hello \\[world");
  });

  it("skips backslash-escaped backtick", () => {
    expect(closeIncompleteMarkdown("Hello \\`world")).toBe("Hello \\`world");
  });

  it("skips backslash-escaped tilde", () => {
    expect(closeIncompleteMarkdown("Hello \\~~world")).toBe("Hello \\~~world");
  });

  it("handles backslash-escaped star with unclosed bold", () => {
    expect(closeIncompleteMarkdown("not \\*bold **still bold")).toBe("not \\*bold **still bold**");
  });

  it("handles unclosed strikethrough after backslash-escaped tilde", () => {
    expect(closeIncompleteMarkdown("\\~~text ~~still open")).toBe("\\~~text ~~still open~~");
  });
});

describe("splitCodeFences", () => {
  it("returns text segment when no fences", () => {
    const segments = splitCodeFences("Hello world");
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("text");
    expect(segments[0].content).toBe("Hello world");
  });

  it("splits code fences from text", () => {
    const segments = splitCodeFences("Text\n```ts\nconst x = 1;\n```\nMore");
    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe("text");
    expect(segments[1].type).toBe("code");
    expect(segments[1].language).toBe("ts");
    expect(segments[1].content).toBe("const x = 1;");
    expect(segments[2].type).toBe("text");
    expect(segments[2].content).toBe("\nMore");
  });

  it("extracts filename from fence header", () => {
    const segments = splitCodeFences("```ts src/index.ts\nconst x = 1;\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("code");
    expect(segments[0].language).toBe("ts");
    expect(segments[0].filename).toBe("src/index.ts");
  });

  it("handles incomplete trailing fence", () => {
    const segments = splitCodeFences("Text\n```ts\nconst x = 1;\n");
    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe("text");
    expect(segments[1].type).toBe("code");
    expect(segments[1].content).toBe("const x = 1;\n");
  });

  it("handles empty content", () => {
    const segments = splitCodeFences("");
    expect(segments).toHaveLength(0);
  });

  it("handles content with no code fences", () => {
    const segments = splitCodeFences("Just plain text\nwith multiple lines\n");
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("text");
  });
});
