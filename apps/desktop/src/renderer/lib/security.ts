/**
 * Shared security utilities for URL validation, SSRF protection, and permission auditing.
 */

/** Check if a hostname resolves to a private/internal address. */
export function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback/link-local
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv6-mapped IPv4 (e.g. [::ffff:127.0.0.1] or ::ffff:127.0.0.1)
  if (/^\[?::ffff:\d+\.\d+\.\d+\.\d+\]?$/i.test(hostname)) return true;
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // Octal IP (e.g. 0177.0.0.1 → 127.0.0.1)
  if (/^0[0-7]+(\.[0-7]+)*$/.test(hostname)) return true;
  // Cloud metadata endpoints
  if (/^metadata\.google\.internal$/i.test(hostname)) return true;
  if (/^instance-data\.local$/i.test(hostname)) return true;
  if (/^169\.254\.169\.254$/.test(hostname)) return true;
  // DNS rebinding via nip.io / sslip.io
  if (/\.(nip\.io|sslip\.io)$/i.test(hostname)) return true;
  // Catch bare integer IP representations
  if (hostname.includes(".")) {
    try {
      const testUrl = new URL(`http://${hostname}`);
      const normalized = testUrl.hostname;
      if (normalized !== hostname) return isPrivateHost(normalized);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Security] Failed to parse hostname for SSRF check:", hostname, e);
    }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return true; // Hex IP like 0x7f000001
  } else if (/^\d+$/.test(hostname)) {
    return true; // Decimal IP like 2130706433
  }
  return hostname === "localhost";
}

/**
 * Validate an MCP server URL against SSRF attacks.
 * Throws if the URL is invalid or points to a private/internal address.
 */
export function validateMcpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Security] Invalid URL for MCP validation:", url, e);
    throw new Error("Invalid MCP server URL", { cause: e });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed for MCP servers");
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Private/internal URLs are not allowed for MCP servers");
  }
}

// ─── Permission Audit Trail ───────────────────────────────────

export interface PermissionAuditEntry {
  timestamp: number;
  sessionId: string;
  toolName: string;
  command?: string;
  decision: "allow" | "deny" | "ask" | "always";
  source: "auto" | "user" | "always-allow" | "rule";
}

const _auditLog: PermissionAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 1000;

/** Log a permission decision to the audit trail. */
export function logPermission(entry: PermissionAuditEntry): void {
  _auditLog.push(entry);
  // Cap audit log size
  if (_auditLog.length > MAX_AUDIT_ENTRIES) {
    _auditLog.splice(0, _auditLog.length - MAX_AUDIT_ENTRIES);
  }
}

/** Get the audit log, optionally filtered by session ID. */
export function getAuditLog(sessionId?: string): PermissionAuditEntry[] {
  if (sessionId) {
    return _auditLog.filter((e) => e.sessionId === sessionId);
  }
  return [..._auditLog];
}

/** Export the audit log as JSON. */
export function exportAuditLog(): string {
  return JSON.stringify(_auditLog, null, 2);
}
