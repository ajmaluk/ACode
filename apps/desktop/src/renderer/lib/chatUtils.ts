/**
 * ChatView utility functions.
 * Extracted from ChatView.tsx to fix React Fast Refresh warnings — pure
 * functions that don't depend on component state or hooks.
 */

/** Format a Unix timestamp to a short HH:MM string. */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Close incomplete markdown markers for streaming content.
 * Single-pass scan — O(n) instead of 8 separate regex passes.
 * Only appends closing markers when the count is odd (unclosed).
 */
export function closeIncompleteMarkdown(text: string): string {
  if (!text) return text;

  let doubleStarCount = 0;   // **
  let singleStarCount = 0;   // * (not part of **)
  let backtickCount = 0;     // ` (inline code)
  let tripleBacktickCount = 0; // ``` (code fences)
  let openBracketCount = 0;  // [
  let closeBracketCount = 0; // ]
  let openParenCount = 0;    // ( after ]
  let closeParenCount = 0;   // )
  let doubleTildeCount = 0;  // ~~
  let inCodeBlock = false;   // inside ``` block
  let inInlineCode = false;  // inside ` inline

  // Single-pass character scan
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];

    // Code fences: ``` — check before single backtick
    if (!inInlineCode && ch === "`" && text[i + 1] === "`" && text[i + 2] === "`") {
      tripleBacktickCount++;
      inCodeBlock = !inCodeBlock;
      i += 3;
      continue;
    }

    // Inline backtick — only count outside code fences
    if (!inCodeBlock && ch === "`") {
      inInlineCode = !inInlineCode;
      backtickCount++;
      i++;
      continue;
    }

    // Skip all other parsing inside code blocks/inline code
    if (inCodeBlock || inInlineCode) {
      i++;
      continue;
    }

    // Double star: **
    if (ch === "*" && text[i + 1] === "*") {
      doubleStarCount++;
      i += 2;
      continue;
    }

    // Single star: * (not part of **)
    if (ch === "*") {
      singleStarCount++;
      i++;
      continue;
    }

    // Brackets: [ ]
    if (ch === "[") { openBracketCount++; i++; continue; }
    if (ch === "]") { closeBracketCount++; i++; continue; }

    // Paren after bracket: ( )
    if (ch === "(" && i > 0 && text[i - 1] === "]") {
      openParenCount++;
      i++;
      continue;
    }
    if (ch === ")") { closeParenCount++; i++; continue; }

    // Double tilde: ~~
    if (ch === "~" && text[i + 1] === "~") {
      doubleTildeCount++;
      i += 2;
      continue;
    }

    i++;
  }

  let suffix = "";

  // Bold: ** opened odd times → close it
  if (doubleStarCount % 2 !== 0) suffix += "**";

  // Italic: * opened odd times (after accounting for ** pairs)
  // singleStarCount already excludes ** pairs (we skip i+=2 on **)
  if (singleStarCount % 2 !== 0) suffix += "*";

  // Code fences: opened odd times → close
  if (tripleBacktickCount % 2 !== 0) suffix += "```";

  // Inline backtick: opened odd times → close
  if (backtickCount % 2 !== 0) suffix += "`";

  // Brackets: unclosed [ → close with ]
  const bracketDiff = openBracketCount - closeBracketCount;
  if (bracketDiff > 0) suffix += "]".repeat(bracketDiff);

  // Parens: unclosed ( after ] → close with )
  const parenDiff = openParenCount - closeParenCount;
  if (parenDiff > 0) suffix += ")".repeat(parenDiff);

  // Strikethrough: ~~ opened odd times → close
  if (doubleTildeCount % 2 !== 0) suffix += "~~";

  return suffix ? text + suffix : text;
}

// ── Fence header language map (module-level, created once) ──────────────────
const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript",
  jsx: "javascriptreact", py: "python", rb: "ruby", rs: "rust",
  go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  php: "php", html: "html", css: "css", scss: "scss", sass: "sass",
  less: "less", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  fish: "fish", ps1: "powershell", bat: "batch", cmd: "batch",
  dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake",
  md: "markdown", mdx: "mdx", txt: "plaintext", csv: "plaintext",
};

function parseFenceHeader(header: string): {
  language?: string;
  filename?: string;
} {
  const trimmed = header.trim();
  if (!trimmed) return {};
  const isFilePath =
    trimmed.includes(".") || trimmed.includes("/") || trimmed.includes("\\");
  if (isFilePath) {
    const ext = trimmed.split(".").pop()?.toLowerCase();
    return {
      language: ext ? EXT_LANG_MAP[ext] : undefined,
      filename: trimmed,
    };
  }
  return { language: trimmed || undefined };
}

// ── Cached splitCodeFences ─────────────────────────────────────────────────
// Cache for streaming: stores last content + parsed segments so we can
// skip re-parsing complete fences on every delta.
let _cacheContent = "";
let _cacheSegments: ReturnType<typeof _parseFences> = [];

// Track whether the last segment is an incomplete code fence (no closing ```).
// When a streaming chunk completes the fence, the next call will detect the
// closing ``` in the appended tail and re-parse correctly.
let _lastFenceOpen = false;

const FENCE_RE = /```([\w-]*)(?:[ \t]+([^\n]*))?(?:\n([\s\S]*?))?\n?```/g;

interface FenceSegment {
  type: "text" | "code";
  content: string;
  language?: string;
  filename?: string;
}

function _parseFences(text: string): FenceSegment[] {
  const out: FenceSegment[] = [];
  _lastFenceOpen = false;

  let last = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    if (match.index > last)
      out.push({ type: "text", content: text.slice(last, match.index) });
    const headerStr = match[1] || "";
    const filenameCandidate = match[2]?.trim() || "";
    const { language, filename: extractedFilename } = parseFenceHeader(headerStr);
    const finalFilename = filenameCandidate || extractedFilename;
    out.push({
      type: "code",
      content: match[3] ?? "",
      language: language || undefined,
      filename: finalFilename || undefined,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    const fenceIdx = rest.indexOf("```");
    if (fenceIdx !== -1) {
      if (fenceIdx > 0)
        out.push({ type: "text", content: rest.slice(0, fenceIdx) });
      const codePart = rest.slice(fenceIdx + 3);
      const newlineIdx = codePart.indexOf("\n");
      if (newlineIdx !== -1) {
        const headerLine = codePart.slice(0, newlineIdx).trim();
        const content = codePart.slice(newlineIdx + 1);
        const { language, filename } = parseFenceHeader(headerLine);
        _lastFenceOpen = !content.endsWith("```") || content.endsWith("```\n");
        out.push({
          type: "code",
          content,
          language: language || undefined,
          filename: filename || undefined,
        });
        // If the content contains a closing fence, also parse any trailing text
        if (content.includes("```")) {
          _lastFenceOpen = false;
        }
      } else {
        const { language, filename } = parseFenceHeader(codePart.trim());
        _lastFenceOpen = true;
        out.push({
          type: "code",
          content: "",
          language: language || undefined,
          filename: filename || undefined,
        });
      }
    } else {
      _lastFenceOpen = false;
      out.push({ type: "text", content: rest });
    }
  }
  return out;
}

/**
 * Split markdown text into alternating text and code-fence segments.
 * Handles both complete fences (```lang ... ```) and incomplete trailing
 * fences (no closing ```).
 *
 * Supports filename extraction from headers like: ```typescript filename.ts
 * or ```ts path/to/file.ts
 *
 * Uses a streaming cache: if the new content is an append of the cached
 * content, only the trailing portion is re-parsed (O(delta) instead of O(n)).
 */
export function splitCodeFences(
  text: string,
): {
  type: "text" | "code";
  content: string;
  language?: string;
  filename?: string;
}[] {
  // Fast path: identical content (no change)
  if (text === _cacheContent) return _cacheSegments;

  // Streaming fast path: new content is an append of cached content.
  // Reuse all cached segments except the last one (which may be an
  // incomplete trailing fence that grew). Re-parse only the tail.
  if (
    _cacheContent &&
    text.startsWith(_cacheContent) &&
    _cacheSegments.length > 0
  ) {
    const tail = text.slice(_cacheContent.length);
    const lastSeg = _cacheSegments[_cacheSegments.length - 1];

    if (lastSeg.type === "code" && _lastFenceOpen) {
      // Last segment was an incomplete code fence — check if the tail
      // closes it (contains ```). If so, re-parse from the last text
      // segment to get the complete fence. Otherwise just append.
      const fenceCloseIdx = tail.indexOf("```");
      if (fenceCloseIdx !== -1) {
        // Fence closed in this chunk — re-parse from the beginning
        // of the original incomplete fence for accuracy
        const segments = _parseFences(text);
        _cacheContent = text;
        _cacheSegments = segments;
        return _cacheSegments;
      }
      // Still open — just append to content
      const newSegments = _cacheSegments.slice(0, -1);
      newSegments.push({
        ...lastSeg,
        content: lastSeg.content + tail,
      });
      _cacheContent = text;
      _cacheSegments = newSegments;
      return _cacheSegments;
    }

    // Last segment was text — check if a new fence started in the tail.
    // Only re-parse the tail + last text segment.
    if (tail.includes("```")) {
      // A fence boundary appeared — re-parse from the last text segment
      const lastTextContent = lastSeg.content;
      const combined = lastTextContent + tail;
      const tailSegments = _parseFences(combined);
      _lastFenceOpen = tailSegments.length > 0 && tailSegments[tailSegments.length - 1]?.type === "code" && !text.endsWith("```\n") && !text.endsWith("```");
      const newSegments = _cacheSegments.slice(0, -1).concat(tailSegments);
      _cacheContent = text;
      _cacheSegments = newSegments;
      return _cacheSegments;
    }

    // No new fence — just append to the last text segment
    const newSegments = _cacheSegments.slice(0, -1);
    newSegments.push({
      ...lastSeg,
      content: lastSeg.content + tail,
    });
    _cacheContent = text;
    _cacheSegments = newSegments;
    return _cacheSegments;
  }

  // Slow path: full re-parse (cache miss)
  const segments = _parseFences(text);
  _cacheContent = text;
  _cacheSegments = segments;
  return segments;
}
