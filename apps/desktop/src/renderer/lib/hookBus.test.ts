import { describe, it, expect, vi } from "vitest";
import { hookBus } from "./hookBus";

describe("hookBus", () => {
  it("calls registered handler", async () => {
    const handler = vi.fn();
    const unsub = hookBus.on("SessionStart", handler);

    await hookBus.emit("SessionStart", {
      sessionId: "test",
      workspacePath: "/test",
      model: "gpt-4o",
      agentName: "yolo",
      mode: "yolo",
      timestamp: Date.now(),
    });

    expect(handler).toHaveBeenCalledOnce();
    unsub();
  });

  it("supports multiple handlers", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const unsub1 = hookBus.on("Stop", handler1);
    const unsub2 = hookBus.on("Stop", handler2);

    await hookBus.emit("Stop", {
      sessionId: "test",
      fullContent: "hello",
      messageCount: 1,
      toolCallsExecuted: 0,
      timestamp: Date.now(),
    });

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });

  it("unsubscribes correctly", async () => {
    const handler = vi.fn();
    const unsub = hookBus.on("SessionEnd", handler);
    unsub();

    await hookBus.emit("SessionEnd", {
      sessionId: "test",
      reason: "completed",
      messageCount: 1,
      durationMs: 1000,
      timestamp: Date.now(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("catches handler errors without throwing", async () => {
    const failingHandler = () => {
      throw new Error("boom");
    };
    const goodHandler = vi.fn();
    const unsub1 = hookBus.on("PostToolUse", failingHandler);
    const unsub2 = hookBus.on("PostToolUse", goodHandler);

    // Should not throw
    await hookBus.emit("PostToolUse", {
      sessionId: "test",
      toolName: "ls",
      toolArgs: {},
      result: "ok",
      durationMs: 10,
      timestamp: Date.now(),
    });

    expect(goodHandler).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });
});
