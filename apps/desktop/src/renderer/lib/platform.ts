/**
 * Platform-aware keyboard-shortcut helpers.
 *
 * The renderer's UI displays the modifier keys in tooltips. We pick `⌘` on
 * macOS and `Ctrl` everywhere else so the same tooltip reads correctly on
 * Windows, Linux, and macOS without per-component branching.
 */

type Platform = "mac" | "win" | "linux" | "other";

let cachedPlatform: Platform | null = null;

function detectPlatform(): Platform {
  // `navigator.userAgentData` is the modern API but isn't universal yet;
  // fall back to `navigator.platform` / userAgent.
  if (typeof navigator === "undefined") return "other";
  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || (navigator as Navigator).platform
    || "").toLowerCase();
  if (platform.includes("mac") || ua.includes("mac")) return "mac";
  if (platform.includes("win") || ua.includes("windows") || ua.includes("win32") || ua.includes("win64")) return "win";
  if (platform.includes("linux") || ua.includes("linux") || ua.includes("ubuntu") || ua.includes("fedora")) return "linux";
  return "other";
}

export function platform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  cachedPlatform = detectPlatform();
  return cachedPlatform;
}

/** The primary modifier for shortcuts: ⌘ on macOS, Ctrl elsewhere. */
export function modKey(): "⌘" | "Ctrl" {
  return platform() === "mac" ? "⌘" : "Ctrl";
}

/** A short label like "⌘K" or "Ctrl K" — pass the non-modifier key. */
export function shortcut(key: string, opts: { shift?: boolean; alt?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.alt) parts.push(platform() === "mac" ? "⌥" : "Alt");
  if (opts.shift) parts.push(platform() === "mac" ? "⇧" : "Shift");
  parts.push(modKey());
  parts.push(key);
  // On non-mac, render as "Ctrl K" / "Ctrl Shift K" for readability.
  return platform() === "mac" ? parts.join("") : parts.join(" ");
}
