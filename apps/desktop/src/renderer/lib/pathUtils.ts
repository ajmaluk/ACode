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

/** Detect whether the path is using Windows-style backslashes. */
export function isWindowsPath(p: string): boolean {
  return p.includes("\\");
}

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

/** Return the path without its last segment. Returns "." for a bare filename, "" for empty input. */
export function dirname(p: string): string {
  if (!p) return "";
  const posix = toPosix(p);
  const idx = posix.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return posix.slice(0, idx);
}

/** Join segments with a forward slash. Ignores empty segments. */
export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const s of segments) {
    if (!s) continue;
    for (const piece of toPosix(s).split("/")) {
      if (piece.length > 0) parts.push(piece);
    }
  }
  return parts.join("/");
}

/**
 * Render a path for display: if the path is long, replace the leading
 * segments with "…/". This is what the right-panel and sidebar use so a
 * deep path doesn't push the filename off the screen.
 */
export function shortPath(p: string, segmentsToShow = 3): string {
  const parts = splitPath(p);
  if (parts.length <= segmentsToShow) return toPosix(p);
  return "…/" + parts.slice(-segmentsToShow).join("/");
}

/** True when two paths point to the same file, ignoring case on Windows/macOS. */
export function pathsEqual(a: string, b: string, caseInsensitive = false): boolean {
  const aa = toPosix(a);
  const bb = toPosix(b);
  if (caseInsensitive) return aa.toLowerCase() === bb.toLowerCase();
  return aa === bb;
}
