/**
 * Tests for todowrite tool parsing + schema (OpenCode-compatible task list).
 */
import { describe, it, expect } from "vitest";
import { parseToolCalls } from "../dalamAPI";
import { validateToolArgs } from "../toolSchemas";
import { parseXmlToolCalls } from "../../store/xmlParser";

describe("todowrite parsing", () => {
  it("parses JSON body form", async () => {
    const text = `<todowrite>[{"id":"1","content":"Create app","status":"in_progress"},{"id":"2","content":"Add tests","status":"pending"}]</todowrite>`;
    const calls = await parseToolCalls(text);
    expect(calls.some((c) => c.name === "todowrite")).toBe(true);
    const tc = calls.find((c) => c.name === "todowrite")!;
    expect(tc.args.content || tc.args.todos).toContain("Create app");
  });

  it("parses attribute form", async () => {
    const text = `<todowrite todos='[{"id":"a","content":"X","status":"pending"}]'/>`;
    const calls = await parseToolCalls(text);
    const tc = calls.find((c) => c.name === "todowrite");
    expect(tc).toBeDefined();
    expect(String(tc!.args.todos)).toContain("content");
  });

  it("is recognized by display-side parseXmlToolCalls", () => {
    const text = `<todowrite>[{"id":"1","content":"Do thing","status":"pending"}]</todowrite>`;
    const { toolCalls, cleanedContent } = parseXmlToolCalls(text);
    expect(toolCalls.some((t) => t.name === "todowrite")).toBe(true);
    expect(cleanedContent).not.toContain("<todowrite");
  });
});

describe("todowrite schema", () => {
  it("accepts todos JSON string", () => {
    const result = validateToolArgs("todowrite", {
      todos: JSON.stringify([
        { id: "1", content: "Scaffold", status: "in_progress" },
      ]),
    });
    expect(result.valid).toBe(true);
  });

  it("accepts content body", () => {
    const result = validateToolArgs("todowrite", {
      content: '[{"id":"1","content":"Hi","status":"pending"}]',
    });
    expect(result.valid).toBe(true);
  });

  it("rejects empty payload", () => {
    const result = validateToolArgs("todowrite", {});
    expect(result.valid).toBe(false);
  });
});
