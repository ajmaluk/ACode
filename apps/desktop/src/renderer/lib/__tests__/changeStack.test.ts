/**
 * Tests for the Change Stack module.
 *
 * Covers:
 * - recordChange and popChange (LIFO)
 * - peekChange (non-destructive read)
 * - clearChanges
 * - getChangeStackSize
 * - Stack capping at MAX_CHANGES
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordChange,
  popChange,
  peekChange,
  clearChanges,
  getChangeStackSize,
} from "../changeStack";

beforeEach(() => {
  clearChanges();
});

describe("recordChange / popChange", () => {
  it("records and pops a change (LIFO)", () => {
    recordChange({
      filePath: "/test/file.ts",
      beforeContent: "old content",
      afterContent: "new content",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });

    const change = popChange();
    expect(change).not.toBeNull();
    expect(change!.filePath).toBe("/test/file.ts");
    expect(change!.beforeContent).toBe("old content");
    expect(change!.afterContent).toBe("new content");
    expect(change!.toolCallId).toBe("tc-1");
    expect(change!.messageId).toBe("msg-1");
    expect(change!.timestamp).toBeGreaterThan(0);
  });

  it("pops in reverse order (last in, first out)", () => {
    recordChange({
      filePath: "/first.ts",
      beforeContent: "a",
      afterContent: "b",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });
    recordChange({
      filePath: "/second.ts",
      beforeContent: "c",
      afterContent: "d",
      toolCallId: "tc-2",
      messageId: "msg-1",
    });

    expect(popChange()!.filePath).toBe("/second.ts");
    expect(popChange()!.filePath).toBe("/first.ts");
    expect(popChange()).toBeNull();
  });

  it("returns null when stack is empty", () => {
    expect(popChange()).toBeNull();
  });

  it("calls from different modules don't interfere", () => {
    recordChange({
      filePath: "/a.ts",
      beforeContent: "",
      afterContent: "x",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });
    expect(popChange()).not.toBeNull();
    expect(popChange()).toBeNull();
  });
});

describe("peekChange", () => {
  it("returns the last change without removing it", () => {
    recordChange({
      filePath: "/test.ts",
      beforeContent: "old",
      afterContent: "new",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });

    const firstPeek = peekChange();
    const secondPeek = peekChange();

    expect(firstPeek).toEqual(secondPeek);
    expect(firstPeek!.filePath).toBe("/test.ts");
  });

  it("returns null when stack is empty", () => {
    expect(peekChange()).toBeNull();
  });
});

describe("getChangeStackSize", () => {
  it("returns 0 for empty stack", () => {
    expect(getChangeStackSize()).toBe(0);
  });

  it("returns correct count after pushes and pops", () => {
    expect(getChangeStackSize()).toBe(0);

    recordChange({
      filePath: "/a.ts",
      beforeContent: "",
      afterContent: "",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });
    expect(getChangeStackSize()).toBe(1);

    recordChange({
      filePath: "/b.ts",
      beforeContent: "",
      afterContent: "",
      toolCallId: "tc-2",
      messageId: "msg-1",
    });
    expect(getChangeStackSize()).toBe(2);

    popChange();
    expect(getChangeStackSize()).toBe(1);
  });
});

describe("clearChanges", () => {
  it("empties the stack", () => {
    recordChange({
      filePath: "/a.ts",
      beforeContent: "",
      afterContent: "",
      toolCallId: "tc-1",
      messageId: "msg-1",
    });
    recordChange({
      filePath: "/b.ts",
      beforeContent: "",
      afterContent: "",
      toolCallId: "tc-2",
      messageId: "msg-1",
    });
    expect(getChangeStackSize()).toBe(2);

    clearChanges();
    expect(getChangeStackSize()).toBe(0);
    expect(popChange()).toBeNull();
  });
});

describe("stack capping", () => {
  it("caps at MAX_CHANGES (50)", () => {
    // Push 55 changes
    for (let i = 0; i < 55; i++) {
      recordChange({
        filePath: `/file-${i}.ts`,
        beforeContent: "old",
        afterContent: "new",
        toolCallId: `tc-${i}`,
        messageId: "msg-1",
      });
    }

    // Stack should be capped at 50
    expect(getChangeStackSize()).toBe(50);

    // The oldest 5 should have been dropped
    const firstPopped = popChange()!;
    expect(firstPopped.filePath).toBe("/file-54.ts");
  });
});
