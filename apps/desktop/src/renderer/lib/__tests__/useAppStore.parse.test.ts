import { describe, it, expect } from "vitest";
import { parseXmlToolCalls } from "../../store/useAppStore";

describe("parseXmlToolCalls", () => {
  it("extracts a single self-closing tool call", () => {
    const result = parseXmlToolCalls('Some text <read_file path="/src/index.ts"/> more');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.path).toBe("/src/index.ts");
  });

  it("extracts a tool call with content body", () => {
    const result = parseXmlToolCalls('<write_file path="test.txt">file content here</write_file>');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].args.content).toBe("file content here");
  });

  it("extracts multiple tool calls", () => {
    const result = parseXmlToolCalls('<read_file path="a.ts"/>\n<read_file path="b.ts"/>');
    expect(result.toolCalls).toHaveLength(2);
  });

  it("maps shell to bash via TAG_TO_TOOL", () => {
    const result = parseXmlToolCalls('<shell command="ls"/>');
    expect(result.toolCalls[0].name).toBe("bash");
  });

  it("extracts edit_file with search/replace", () => {
    const result = parseXmlToolCalls('<edit_file path="f.ts"><search>old</search><replace>new</replace></edit_file>');
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty tool calls for plain text", () => {
    expect(parseXmlToolCalls("plain").toolCalls).toHaveLength(0);
  });

  it("cleans content without XML tags", () => {
    const r = parseXmlToolCalls('Hello <read_file path="x.ts"/> world');
    expect(r.cleanedContent).not.toContain("<read_file");
  });

  it("assigns unique IDs", () => {
    const r = parseXmlToolCalls('<read_file path="a"/><read_file path="b"/>');
    expect(r.toolCalls[0].id).not.toBe(r.toolCalls[1].id);
  });

  it("sets status to completed", () => {
    const r = parseXmlToolCalls('<read_file path="x"/>');
    expect(r.toolCalls[0].status).toBe("completed");
  });

  it("extracts git_commit with message", () => {
    const r = parseXmlToolCalls('<git_commit message="fix"/>');
    expect(r.toolCalls[0].args.message).toBe("fix");
  });
});
