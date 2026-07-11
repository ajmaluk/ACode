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
 *
 * Handles edge cases:
 * - Link URL `(` after `]` even when inline code is between them: [`code`](url
 * - Global `)` not counted (only link-context `)` to avoid prose inflation)
 * - Nested parens inside link URLs: [text](url(with)parens)
 */
export function closeIncompleteMarkdown(text: string): string {
  if (!text) return text;

  let doubleStarCount = 0;
  let singleStarCount = 0;
  let backtickCount = 0;
  let tripleBacktickCount = 0;
  let openBracketCount = 0;
  let closeBracketCount = 0;
  let parenDepth = 0;        // depth of currently-open link URL parens
  let doubleTildeCount = 0;
  let inCodeBlock = false;
  let inInlineCode = false;
  let afterCloseBracket = false; // true when last meaningful char was `]`

  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];

    // Backslash escapes: skip \ and the next character as literal
    if (ch === "\\" && i + 1 < len && "*`[~".includes(text[i + 1])) {
      i += 2;
      afterCloseBracket = false;
      continue;
    }

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
      afterCloseBracket = false;
      continue;
    }

    // Single star: * (not part of **)
    if (ch === "*") {
      singleStarCount++;
      i++;
      afterCloseBracket = false;
      continue;
    }

    // Brackets: [ ]
    if (ch === "[") {
      openBracketCount++;
      afterCloseBracket = false;
      i++;
      continue;
    }
    if (ch === "]") {
      closeBracketCount++;
      afterCloseBracket = true;
      i++;
      continue;
    }

    // Link URL parens: count ( when after ] or already inside a link URL.
    // This handles [`code`](url) by tracking the ] via afterCloseBracket.
    // Nested parens work because parenDepth increments/decrements properly.
    if (ch === "(" && (afterCloseBracket || parenDepth > 0)) {
      parenDepth++;
      afterCloseBracket = false;
      i++;
      continue;
    }

    // Only count ) when inside a link URL (parenDepth > 0).
    // This prevents prose parens like "hello (world)" from inflating the count.
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      i++;
      continue;
    }

    // Double tilde: ~~
    if (ch === "~" && text[i + 1] === "~") {
      doubleTildeCount++;
      i += 2;
      afterCloseBracket = false;
      continue;
    }

    // Reset afterCloseBracket on any non-whitespace character
    // that wasn't handled above (prevents false link detection)
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      afterCloseBracket = false;
    }

    i++;
  }

  let suffix = "";

  if (doubleStarCount % 2 !== 0) suffix += "**";
  if (singleStarCount % 2 !== 0) suffix += "*";
  if (tripleBacktickCount % 2 !== 0) suffix += "```";
  if (backtickCount % 2 !== 0) suffix += "`";

  const bracketDiff = openBracketCount - closeBracketCount;
  if (bracketDiff > 0) suffix += "]".repeat(bracketDiff);

  if (parenDepth > 0) suffix += ")".repeat(parenDepth);

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

const FENCE_RE = /```([\w-]*)(?:[ \t]+([^\n]*))?(?:\n([\s\S]*?))?\n?```/g;

interface FenceSegment {
  type: "text" | "code";
  content: string;
  language?: string;
  filename?: string;
}

// Streaming cache: single-entry LRU keyed by exact content string.
// Content during streaming is typically small (<10KB), and this cache
// ensures identical content from React strict-mode double-invocation
// returns the same reference without re-parsing.
let _cacheContent = "";
let _cacheSegments: ReturnType<typeof _parseFences> = [];

function _parseFences(text: string): FenceSegment[] {
  const out: FenceSegment[] = [];

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
        out.push({
          type: "code",
          content,
          language: language || undefined,
          filename: filename || undefined,
        });
        // If the content contains a closing fence, also parse any trailing text
        if (content.includes("```")) {
          const lastFence = content.lastIndexOf("```");
          const restAfterFence = content.slice(lastFence + 3);
          if (restAfterFence.trim()) {
            out.push({ type: "text", content: restAfterFence });
          }
        }
      } else {
        const { language, filename } = parseFenceHeader(codePart.trim());
        out.push({
          type: "code",
          content: "",
          language: language || undefined,
          filename: filename || undefined,
        });
      }
    } else {
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
 */
export function splitCodeFences(
  text: string,
): {
  type: "text" | "code";
  content: string;
  language?: string;
  filename?: string;
}[] {
  if (text === _cacheContent) return _cacheSegments;
  const segments = _parseFences(text);
  _cacheContent = text;
  _cacheSegments = segments;
  return segments;
}
