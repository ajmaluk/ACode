/**
 * Shared security utilities for URL validation, SSRF protection, and permission auditing.
 */

/** Check if a hostname resolves to a private/internal address. */
export function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback/link-local
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv6 link-local (fe80::/10), ULA (fc00::/7)
  if (/^\[?fe[89ab][0-9a-f]*:/i.test(hostname)) return true;
  // L-20: IPv6 ULA — require exactly 2 hex digits after fc/fd
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(hostname)) return true;
  // IPv6-mapped IPv4 (e.g. [::ffff:127.0.0.1] or ::ffff:127.0.0.1)
  if (/^\[?::ffff:\d+\.\d+\.\d+\.\d+\]?$/i.test(hostname)) return true;
  // H-6: IPv6 transition mechanism (64:ff9b::/96, NAT64/DNS64)
  if (/^\[?64:ff9b::/i.test(hostname)) return true;
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // CGNAT (100.64.0.0/10, RFC 6598)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return true;
  // Multicast (224.0.0.0/4)
  if (/^22[4-9]\./.test(hostname) || /^23[0-9]\./.test(hostname)) return true;
  // Broadcast
  if (hostname === "255.255.255.255") return true;
  // M-17: Octal/mixed octal-decimal IP (e.g. 0177.0.0.1 → 127.0.0.1)
  // Match any combination of octal (0-prefixed) and decimal octets
  if (/^(0[0-7]+|\d+)\.(0[0-7]+|\d+)\.(0[0-7]+|\d+)\.(0[0-7]+|\d+)$/.test(hostname)) {
    const octets = hostname.split(".");
    // If any octet starts with 0 and has more than 1 digit, it's octal → private
    if (octets.some((o) => o.startsWith("0") && o.length > 1)) {
      return true;
    }
  }
  // Cloud metadata endpoints
  if (/^metadata\.google\.internal$/i.test(hostname)) return true;
  if (/^instance-data\.local$/i.test(hostname)) return true;
  if (/^169\.254\.169\.254$/.test(hostname)) return true;
  // DNS rebinding via wildcard DNS services
  if (/\.(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me)$/i.test(hostname)) return true;
  // Catch bare integer IP representations
  if (hostname.includes(".")) {
    try {
      const testUrl = new URL(`http://${hostname}`);
      const normalized = testUrl.hostname;
      if (normalized !== hostname) return isPrivateHost(normalized);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[Security] Failed to parse hostname for SSRF check:", hostname, e);
      return true; // Fail closed: treat unparseable hostnames as private
    }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return true; // Hex IP like 0x7f000001
  } else if (/^0$/.test(hostname)) {
    return true; // Bare "0" resolves to 0.0.0.0
  } else if (/^[1-9]\d*$/.test(hostname)) {
    return true; // Decimal IP like 2130706433
  }
  // Trailing dot normalization: "localhost." is equivalent to "localhost"
  const normalizedHost = hostname.replace(/\.+$/, "");
  if (normalizedHost === "localhost") return true;
  return false;
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

  // H-7: Path validation — check for SSRF-like patterns in the URL path
  const path = parsed.pathname;
  // Block path traversal sequences
  if (/\.\./.test(path)) {
    throw new Error("MCP server URL path must not contain path traversal sequences");
  }
  // Block tilde expansion (home directory reference)
  if (/~/.test(path)) {
    throw new Error("MCP server URL path must not contain tilde characters");
  }
  // Block URL-encoded CR/LF injection
  if (/%0[ad]/i.test(path)) {
    throw new Error("MCP server URL path must not contain CR/LF encoded characters");
  }
  // Block null byte injection
  if (/%00/.test(path)) {
    throw new Error("MCP server URL path must not contain null bytes");
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
