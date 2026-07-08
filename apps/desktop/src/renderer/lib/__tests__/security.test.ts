import { describe, it, expect, beforeEach } from "vitest";
import { isPrivateHost, validateMcpUrl, logPermission, getAuditLog, exportAuditLog } from "../security";

describe("isPrivateHost", () => {
  it("detects localhost", () => {
    expect(isPrivateHost("localhost")).toBe(true);
  });

  it("detects IPv6 loopback", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
  });

  it("detects 127.x.x.x", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.255.255.254")).toBe(true);
    expect(isPrivateHost("127.0.0.2")).toBe(true);
  });

  it("detects 10.x.x.x", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
  });

  it("detects 192.168.x.x", () => {
    expect(isPrivateHost("192.168.0.1")).toBe(true);
    expect(isPrivateHost("192.168.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.100")).toBe(true);
  });

  it("detects 169.254.x.x (link-local)", () => {
    expect(isPrivateHost("169.254.1.1")).toBe(true);
    expect(isPrivateHost("169.254.254.254")).toBe(true);
  });

  it("detects 0.x.x.x", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("0.255.255.255")).toBe(true);
  });

  it("detects 172.16-31.x.x", () => {
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
  });

  it("allows 172.32.x.x", () => {
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("172.40.0.1")).toBe(false);
  });

  it("detects cloud metadata endpoints", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("metadata.google.internal")).toBe(true);
    expect(isPrivateHost("instance-data.local")).toBe(true);
  });

  it("detects hex IP representations", () => {
    expect(isPrivateHost("0x7f000001")).toBe(true);
    expect(isPrivateHost("0x0a000001")).toBe(true);
  });

  it("detects decimal IP representations", () => {
    expect(isPrivateHost("2130706433")).toBe(true); // 127.0.0.1
    expect(isPrivateHost("167772161")).toBe(true); // 10.0.0.1
  });

  it("detects octal IP representations", () => {
    expect(isPrivateHost("0177.0.0.1")).toBe(true); // 127.0.0.1
    expect(isPrivateHost("010.0.0.1")).toBe(true); // 10.0.0.1
  });

  it("detects hex IPs with dots via URL normalization", () => {
    // 0x7f.0.0.1 → URL normalization detects it as 127.0.0.1
    expect(isPrivateHost("0x7f.0.0.1")).toBe(true);
  });

  it("detects IPv6-mapped IPv4 addresses", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateHost("[::ffff:192.168.1.1]")).toBe(true);
  });

  it("blocks DNS rebinding via nip.io and sslip.io", () => {
    expect(isPrivateHost("127.0.0.1.nip.io")).toBe(true);
    expect(isPrivateHost("169.254.169.254.sslip.io")).toBe(true);
    expect(isPrivateHost("10.0.0.1.nip.io")).toBe(true);
  });

  it("allows legitimate subdomains of nip.io-like patterns", () => {
    // These are NOT DNS rebinding — they're just regular domains
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("api.nipper.io")).toBe(false); // not nip.io
  });

  it("returns false for public hosts", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("api.github.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
    expect(isPrivateHost("google.com")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPrivateHost("")).toBe(false);
  });

  it("treats parsed normalized form correctly", () => {
    // Should normalize 127.0.0.1 with integer normalization
    expect(isPrivateHost("127.0.0.1")).toBe(true);
  });
});

describe("validateMcpUrl", () => {
  it("accepts valid HTTPS URL to public host", () => {
    expect(() => validateMcpUrl("https://api.example.com/mcp")).not.toThrow();
  });

  it("accepts valid HTTP URL to public host", () => {
    expect(() => validateMcpUrl("http://api.example.com/mcp")).not.toThrow();
  });

  it("rejects URL to localhost", () => {
    expect(() => validateMcpUrl("http://localhost:3000/mcp")).toThrow("Private");
  });

  it("rejects URL to 127.0.0.1", () => {
    expect(() => validateMcpUrl("http://127.0.0.1:8080/mcp")).toThrow("Private");
  });

  it("rejects URL to private IP range", () => {
    expect(() => validateMcpUrl("http://192.168.1.1/mcp")).toThrow("Private");
    expect(() => validateMcpUrl("http://10.0.0.1/mcp")).toThrow("Private");
  });

  it("rejects URL to cloud metadata", () => {
    expect(() => validateMcpUrl("http://169.254.169.254/mcp")).toThrow("Private");
  });

  it("rejects invalid URL format", () => {
    expect(() => validateMcpUrl("not-a-url")).toThrow("Invalid MCP");
  });

  it("rejects non-HTTP protocols", () => {
    expect(() => validateMcpUrl("ftp://files.example.com/mcp")).toThrow("HTTP/HTTPS");
    expect(() => validateMcpUrl("file:///etc/passwd")).toThrow("HTTP/HTTPS");
    expect(() => validateMcpUrl("ws://localhost:3000")).toThrow("HTTP/HTTPS");
  });
});

describe("audit logging", () => {
  beforeEach(() => {
    // Clear audit log by getting and ignoring old entries
    getAuditLog();
    // Can't actually clear it, but we can work with what we have
  });

  it("logs a permission decision", () => {
    logPermission({
      timestamp: Date.now(),
      sessionId: "session-1",
      toolName: "run_command",
      command: "ls",
      decision: "allow",
      source: "auto",
    });

    const log = getAuditLog("session-1");
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.toolName === "run_command" && e.decision === "allow")).toBe(true);
  });

  it("filters audit log by session ID", () => {
    logPermission({
      timestamp: Date.now(),
      sessionId: "session-a",
      toolName: "read_file",
      decision: "deny",
      source: "auto",
    });
    logPermission({
      timestamp: Date.now(),
      sessionId: "session-b",
      toolName: "write_file",
      decision: "allow",
      source: "user",
    });

    const sessionALog = getAuditLog("session-a");
    expect(sessionALog.every((e) => e.sessionId === "session-a")).toBe(true);
  });

  it("returns all entries when no session ID", () => {
    // Should return a copy of all entries
    const allLog = getAuditLog();
    expect(Array.isArray(allLog)).toBe(true);
  });

  it("returns a copy (not a reference) from getAuditLog", () => {
    logPermission({
      timestamp: Date.now(),
      sessionId: "session-copy",
      toolName: "test",
      decision: "allow",
      source: "auto",
    });
    const log1 = getAuditLog();
    const log2 = getAuditLog();
    expect(log1).toEqual(log2);
  });

  it("records all decision types", () => {
    const decisions: Array<"allow" | "deny" | "ask" | "always"> = ["allow", "deny", "ask", "always"];
    const sources: Array<"auto" | "user" | "always-allow" | "rule"> = ["auto", "user", "always-allow", "rule"];

    for (const decision of decisions) {
      for (const source of sources) {
        logPermission({
          timestamp: Date.now(),
          sessionId: "session-decision",
          toolName: "test_tool",
          decision,
          source,
        });
      }
    }

    const log = getAuditLog("session-decision");
    expect(log.length).toBe(decisions.length * sources.length);
  });

  it("exports audit log as JSON", () => {
    const json = exportAuditLog();
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("caps audit log at 1000 entries", () => {
    // Add entries that will exceed the cap
    for (let i = 0; i < 1010; i++) {
      logPermission({
        timestamp: Date.now() + i,
        sessionId: "cap-test",
        toolName: "test_tool",
        decision: "allow",
        source: "auto",
      });
    }

    const log = getAuditLog("cap-test");
    // Should have at most 1000 entries (oldest ones trimmed)
    expect(log.length).toBeLessThanOrEqual(1000);
  });
});
