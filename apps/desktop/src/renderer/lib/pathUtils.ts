/**
 * Tiny cross-platform path helpers.
 *
 * The renderer never talks to the OS directly — the main process owns the
 * real `node:path` calls. But the renderer still has to manipulate path
 * strings (basename, dirname, split, normalize, join) for display, search,
 * and shell-completion, and many of those strings come from the main
 * process with the OS's native separator. So we accept BOTH `/` and `\\`
 * everywhere and emit `/` consistently. The main process is the source of
 * truth and converts back when it does real fs work.
 */

/** Convert any path to use forward slashes (so the renderer can split reliably). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Split a path into segments using either separator. */
export function splitPath(p: string): string[] {
  return toPosix(p).split("/").filter((s) => s.length > 0);
}

/** Return the last segment of the path (file or folder name). */
export function basename(p: string): string {
  if (!p) return "";
  const parts = splitPath(p);
  return parts[parts.length - 1] ?? "";
}

/** Return the path without its last segment. Returns "." for a bare filename, "" for empty input.
 *  Handles Windows drive letter prefixes (e.g. C:\path). */
export function dirname(p: string): string {
  if (!p) return "";
  const posix = toPosix(p);
  const idx = posix.lastIndexOf("/");
  if (idx < 0) {
    // Check for drive letter only (e.g. "C:")
    return hasDriveLetter(posix) ? posix : ".";
  }
  if (idx === 0) return "/";
  const result = posix.slice(0, idx);
  const trimmed = result.endsWith("/") && result !== "/" ? result.slice(0, -1) : result;
  // Preserve drive letter prefix
  if (hasDriveLetter(posix) && !hasDriveLetter(trimmed)) {
    return getDriveLetter(posix) + trimmed;
  }
  return trimmed;
}

/**
 * Detect whether a path has a Windows drive letter prefix (e.g. C:, D:).
 * Handles both `C:\path` and `C:/path` formats.
 */
function hasDriveLetter(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

/**
 * Extract the drive letter prefix from a Windows path (e.g. "C:" from "C:\path").
 */
function getDriveLetter(p: string): string {
  const match = p.match(/^([a-zA-Z]:)/);
  return match ? match[1] : "";
}

/** Join segments with a forward slash. Ignores empty segments. Preserves leading `/` for absolute paths.
 *  Handles Windows drive letter prefixes (e.g. C:\path) correctly. */
export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  let drivePrefix = "";

  for (const s of segments) {
    if (!s) continue;
    const posix = toPosix(s);
    // Detect drive letter from the first segment that has one
    if (!drivePrefix && hasDriveLetter(posix)) {
      drivePrefix = getDriveLetter(posix);
    }
    for (const piece of posix.split("/")) {
      if (piece.length > 0) parts.push(piece);
    }
  }

  // Determine if the path should be absolute
  const firstSegment = segments.find((s) => s && s.length > 0) ?? "";
  const firstPosix = toPosix(firstSegment);
  const leadingSlash = firstPosix.startsWith("/") || hasDriveLetter(firstPosix);

  const joined = parts.join("/");
  const result = leadingSlash ? "/" + joined : joined;

  // Resolve . and .. segments
  const pathParts = result.split("/");
  const resolved: string[] = [];
  for (const part of pathParts) {
    if (part === "." || (part === "" && resolved.length > 0)) continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
  }

  let finalPath = resolved.join("/") || (leadingSlash ? "/" : ".");

  // Prepend drive letter if we detected one and it was stripped during normalization
  if (drivePrefix && !finalPath.startsWith(drivePrefix)) {
    finalPath = drivePrefix + "/" + finalPath.replace(/^\//, "");
  }

  return finalPath;
}

/** Used by tests */
/**
 * Render a path for display: if the path is long, replace the leading
 * segments with "…/". This is what the right-panel and sidebar use so a
 * deep path doesn't push the filename off the screen.
 * Handles Windows drive letter prefixes (e.g. C:\path).
 */
export function shortPath(p: string, segmentsToShow = 3): string {
  const parts = splitPath(p);
  if (parts.length <= segmentsToShow) return toPosix(p);
  const posix = toPosix(p);
  const drivePrefix = hasDriveLetter(posix) ? getDriveLetter(posix) : "";
  const leadingSlash = posix.startsWith("/") ? "/" : "";
  return drivePrefix + leadingSlash + "…/" + parts.slice(-segmentsToShow).join("/");
}

/** Used by tests */
/** True when two paths point to the same file, ignoring case on Windows/macOS. */
export function pathsEqual(a: string, b: string, caseInsensitive = false): boolean {
  const stripTrailing = (p: string) => p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const aa = stripTrailing(toPosix(a));
  const bb = stripTrailing(toPosix(b));
  if (caseInsensitive) return aa.toLowerCase() === bb.toLowerCase();
  return aa === bb;
}
