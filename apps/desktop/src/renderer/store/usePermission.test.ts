import { describe, it, expect, beforeEach } from "vitest";
import { usePermission } from "./useAppStore";

// Reset the store before each test to avoid cross-test contamination
beforeEach(() => {
  usePermission.setState({
    request: null,
    alwaysAllowed: {},
  });
  // Clear any pending resolve/reject callbacks
  usePermission.getState().cancel();
});

describe("usePermission — ask / resolve / cancel flow", () => {
  it("ask() sets the request in the store", () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: ls -la",
      command: "ls -la",
    };

    // Fire-and-forget ask — don't await since it won't resolve yet
    void usePermission.getState().ask(req);

    const state = usePermission.getState();
    expect(state.request).not.toBeNull();
    expect(state.request!.kind).toBe("bash");
    expect(state.request!.command).toBe("ls -la");
    expect(state.request!.title).toBe("Permission required");
  });

  it("resolve('allow') resolves the ask promise with 'allow'", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: ls",
      command: "ls",
    };

    const decisionPromise = usePermission.getState().ask(req);

    // Simulate user clicking option 1 (Allow) then Confirm
    usePermission.getState().resolve("allow");

    const decision = await decisionPromise;
    expect(decision).toBe("allow");
    // Request should be cleared after resolution
    expect(usePermission.getState().request).toBeNull();
  });

  it("resolve('always') resolves with 'always'", async () => {
    const req = {
      kind: "edit" as const,
      title: "Permission required",
      description: "Write file",
      command: "write_file /tmp/test.txt",
    };

    const decisionPromise = usePermission.getState().ask(req);

    // Simulate user clicking "Always allow" then Confirm
    usePermission.getState().resolve("always");

    const decision = await decisionPromise;
    expect(decision).toBe("always");
    expect(usePermission.getState().request).toBeNull();
  });

  it("resolve('deny') resolves with 'deny'", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: rm -rf /",
      command: "rm -rf /",
    };

    const decisionPromise = usePermission.getState().ask(req);

    usePermission.getState().resolve("deny");

    const decision = await decisionPromise;
    expect(decision).toBe("deny");
    expect(usePermission.getState().request).toBeNull();
  });

  it("cancel() resolves with 'deny'", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: echo",
      command: "echo hello",
    };

    const decisionPromise = usePermission.getState().ask(req);

    // Simulate clicking outside the dialog or pressing Escape
    usePermission.getState().cancel();

    const decision = await decisionPromise;
    expect(decision).toBe("deny");
    expect(usePermission.getState().request).toBeNull();
  });

  it("ask() with already-allowed permission resolves immediately without prompting", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: ls",
      command: "ls",
      workspacePath: "/tmp/project",
    };

    // Pre-mark this command as always-allowed
    usePermission.getState().allowAlways({
      id: "perm-test",
      createdAt: Date.now(),
      kind: "bash",
      title: "Permission required",
      description: "Run: ls",
      command: "ls",
      workspacePath: "/tmp/project",
    });

    const decision = await usePermission.getState().ask(req);

    // Should resolve immediately without setting request
    expect(decision).toBe("allow");
    expect(usePermission.getState().request).toBeNull();
  });

  it("second ask() queues behind the first pending request", async () => {
    const req1 = {
      kind: "bash" as const,
      title: "Request 1",
      description: "First",
      command: "ls",
    };
    const req2 = {
      kind: "bash" as const,
      title: "Request 2",
      description: "Second",
      command: "pwd",
    };

    const promise1 = usePermission.getState().ask(req1);
    const promise2 = usePermission.getState().ask(req2);

    // The first request should be shown (active dialog)
    expect(usePermission.getState().request!.command).toBe("ls");

    // Resolve the first — second should appear
    usePermission.getState().resolve("allow");
    const decision1 = await promise1;
    expect(decision1).toBe("allow");

    // The second request is now active
    expect(usePermission.getState().request!.command).toBe("pwd");

    // Resolve the second
    usePermission.getState().resolve("always");
    const decision2 = await promise2;
    expect(decision2).toBe("always");
  });

  it("sequential ask → resolve → ask → resolve works correctly", async () => {
    const makeReq = (cmd: string) => ({
      kind: "bash" as const,
      title: "Permission required",
      description: `Run: ${cmd}`,
      command: cmd,
    });

    // First request
    const p1 = usePermission.getState().ask(makeReq("ls"));
    usePermission.getState().resolve("allow");
    expect(await p1).toBe("allow");

    // Second request
    const p2 = usePermission.getState().ask(makeReq("pwd"));
    usePermission.getState().resolve("always");
    expect(await p2).toBe("always");

    // Third request — cancel
    const p3 = usePermission.getState().ask(makeReq("rm"));
    usePermission.getState().cancel();
    expect(await p3).toBe("deny");
  });

  it("request is set to null after resolve", async () => {
    const req = {
      kind: "edit" as const,
      title: "Permission required",
      description: "Edit file",
      command: "edit_file /tmp/test.txt",
    };

    void usePermission.getState().ask(req);
    expect(usePermission.getState().request).not.toBeNull();

    usePermission.getState().resolve("allow");
    // Wait a tick for the state to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(usePermission.getState().request).toBeNull();
  });

  it("request is set to null after cancel", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: echo",
      command: "echo test",
    };

    void usePermission.getState().ask(req);
    expect(usePermission.getState().request).not.toBeNull();

    usePermission.getState().cancel();
    await new Promise((r) => setTimeout(r, 0));

    expect(usePermission.getState().request).toBeNull();
  });

  it("allowAlways persists and ask() auto-resolves for the same command", async () => {
    const req = {
      kind: "bash" as const,
      title: "Permission required",
      description: "Run: node server.js",
      command: "node server.js",
      workspacePath: "/workspace",
    };

    // First: user chooses "always allow"
    const p1 = usePermission.getState().ask(req);
    usePermission.getState().resolve("always");
    expect(await p1).toBe("always");

    // Persist the "always" decision
    usePermission.getState().allowAlways({
      id: "perm-auto",
      createdAt: Date.now(),
      kind: "bash",
      title: "Permission required",
      description: "Run: node server.js",
      command: "node server.js",
      workspacePath: "/workspace",
    });

    // Second: same command should auto-resolve without prompting
    const p2 = usePermission.getState().ask(req);
    const decision = await p2;
    expect(decision).toBe("allow");
    expect(usePermission.getState().request).toBeNull();
  });
});
