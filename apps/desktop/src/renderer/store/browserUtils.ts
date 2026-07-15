// ---- UI state (panel visibility) -------------------------------------------

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  history: string[];
  historyIdx: number;
  loading: boolean;
  _refreshTimer?: ReturnType<typeof setTimeout>;
};

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.google.com") && u.pathname === "/search") {
      const q = u.searchParams.get("q") ?? "";
      return q ? `Google — ${q}` : "Google";
    }
    return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const u = new URL(url);:", e);
    return url;
  }
}

/** Check if a hostname resolves to a private/internal address. */
function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback/link-local
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // Cloud metadata endpoints
  if (/^metadata\.google\.internal$/i.test(hostname)) return true;
  if (/^instance-data\.local$/i.test(hostname)) return true;
  if (/^169\.254\.169\.254$/.test(hostname)) return true;
  // Catch bare integer IP representations (0x7f000001, 2130706433, 0177.0.0.1)
  // These don't match dotted patterns but still resolve to IPs in the OS network stack.
  if (hostname.includes(".")) {
    try {
      const testUrl = new URL(`http://${hostname}`);
      const normalized = testUrl.hostname;
      if (normalized !== hostname) return isPrivateHost(normalized);
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] const testUrl = new URL(`http://${hostname}`);:", e);
    }
  } else if (/^0x[0-9a-f]+$/i.test(hostname)) {
    // Hex IP representations like 0x7f000001 → 127.0.0.1
    return true;
  } else if (/^\d+$/.test(hostname)) {
    // Decimal IP representations like 2130706433 → 127.0.0.1 (and 1 → 0.0.0.1, etc.)
    // These are interpreted as IP addresses by the OS socket layer and in some browsers.
    return true;
  }
  return hostname === "localhost";
}

function normalizeBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // Block dangerous URL schemes
  if (/^(file|data|javascript|vbscript):/i.test(raw)) return null;

  // Try parsing as a URL with protocol
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (isPrivateHost(url.hostname)) return null;
      return url.href;
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] const url = new URL(raw);:", e);
      return null;
    }
  }

  // Try as a bare hostname/IP (no protocol)
  try {
    const testUrl = new URL(`https://${raw}`);
    if (isPrivateHost(testUrl.hostname)) return null;
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const testUrl = new URL(`https://${raw}`);:", e);
  }

  if (/\s/.test(raw)) return "https://www.google.com/search?q=" + encodeURIComponent(raw);
  return "https://" + raw.replace(/^https?:\/\//i, "");
}
