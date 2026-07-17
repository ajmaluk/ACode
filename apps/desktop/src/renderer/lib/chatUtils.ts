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
    // Look for a pair of ``` fences: opening ``` + content + closing ```
    const firstFence = rest.indexOf("```");
    if (firstFence !== -1) {
      const afterFirstFence = rest.slice(firstFence + 3);
      // Find the closing fence (second ```)
      const closingFence = afterFirstFence.indexOf("```");
      if (closingFence !== -1) {
        // Two fences found — extract content between them
        if (firstFence > 0)
          out.push({ type: "text", content: rest.slice(0, firstFence) });
        const codePart = afterFirstFence.slice(0, closingFence);
        const newlineIdx = codePart.indexOf("\n");
        if (newlineIdx !== -1) {
          const headerLine = codePart.slice(0, newlineIdx).trim();
          const rawContent = codePart.slice(newlineIdx + 1);
          const { language, filename } = parseFenceHeader(headerLine);
          out.push({
            type: "code",
            content: rawContent.replace(/\r?\n$/, ""),
            language: language || undefined,
            filename: filename || undefined,
          });
        } else {
          const { language, filename } = parseFenceHeader(codePart.trim());
          out.push({
            type: "code",
            content: "",
            language: language || undefined,
            filename: filename || undefined,
          });
        }
        const trailingText = afterFirstFence.slice(closingFence + 3);
        if (trailingText.trim()) {
          out.push({ type: "text", content: trailingText });
        }
      } else {
        // Only one fence found — no closing fence, emit as text
        out.push({ type: "text", content: rest });
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

// ── Language-agnostic raw code detection ───────────────────────────────────
// When the model outputs code directly (without markdown fences), detect it
// and split it into proper code segments. Works for ANY programming language.

interface TransformedSegment {
  type: "text" | "code";
  content: string;
  language?: string;
  filename?: string;
}

function looksLikeCodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;

  // Lines ending with code-specific punctuation
  if (/[;{}]$/.test(t)) return true;

  // Closing bracket/brace at line start (dedent)
  if (/^\s*[}\])]/.test(t)) return true;

  // Operators rare in prose
  if (/[=!<>]=|=>|\|\||&&|\+\+|--|::|\.\.|->/.test(t)) return true;

  // Indented line with code punctuation
  if (/^\s{2,}/.test(line) && /[:=,()[\]]/.test(t)) return true;

  // Declaration/control-flow keywords at line start
  if (/^(class|def|function|func|fn|fun|var|let|const|import|export|from|require|return|if|else|elif|for|while|do|switch|case|default|try|catch|finally|throw|async|await|yield|interface|type|enum|struct|trait|impl|mod|use|pub|package|module|new|void|null|undefined|true|false|select|from|where|insert|update|delete|create|alter|drop|table|index|view|defer|range|go)\b/.test(t)) return true;

  // HTML/JSX tags
  if (/^<\w+[\s/>]/.test(t) && /<\/?/.test(t)) return true;

  // Decorators/annotations
  if (/^\s*@\w+\(/.test(t)) return true;

  // Comment markers at line start
  if (/^\s*\/\//.test(line) || /^\s*#/.test(line) || /^\s*--/.test(line)) return true;

  // CSS-like patterns (property: value)
  if (/^\s*[a-z-]+\s*:\s*[^:]+;?$/.test(t) && /[#.a-z0-9]/.test(t)) return true;

  return false;
}

function findCodeStart(text: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeCodeLine(lines[i])) {
      let pos = 0;
      for (let j = 0; j < i; j++) {
        pos += lines[j].length + 1;
      }
      return pos;
    }
  }
  return -1;
}

function isSubstantialCode(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  const codeLines = lines.filter((l) => looksLikeCodeLine(l)).length;
  return codeLines / lines.length > 0.3 || codeLines >= 3;
}

const LANG_DETECTORS: [RegExp, string][] = [
  [/^\s*def\s+\w+|^\s*import\s+\w+|^\s*from\s+\w+|^\s*class\s+\w+:?\s*$|^\s*elif\s|^\s*except\s|^\s*with\s+\w+\s+as\b|if __name__|self\./m, "python"],
  [/^\s*func\s+\w+|^\s*package\s+\w+|^\s*import\s+\(|:=|defer\s/m, "go"],
  [/^\s*fn\s+\w+|^\s*let\s+mut\b|^\s*use\s+\w+|^\s*impl\s|^\s*pub\s|->\s*\w+|#\[/m, "rust"],
  [/^\s*function\s+\w+|^\s*const\s+\w+\s*=|^\s*let\s+\w+\s*=|^\s*var\s+\w+\s*=|console\.\w+|=>/m, "javascript"],
  [/^\s*interface\s+\w+|^\s*type\s+\w+\s*=|:\s*(string|number|boolean|any|never|void)\b/m, "typescript"],
  [/^\s*public\s+(class|interface|abstract)|^\s*private\s+|^\s*protected\s+|\.print(?:ln)?\(|System\./m, "java"],
  [/^\s*#\s*(include|define|ifndef|endif|pragma)/m, "c"],
  [/^\s*#include\s+<[^>]+>|std::/m, "cpp"],
  [/^\s*def\s+\w+|^\s*class\s+\w+\s*\n?\s*end\b|end$/m, "ruby"],
  [/<!DOCTYPE|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]/im, "html"],
  [/\{[\s\S]*?(?:margin|padding|background|color|font|border|display|position|width|height)\s*:/m, "css"],
];

function detectCodeLanguage(code: string): string | undefined {
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;

  const scores: Record<string, number> = {};
  for (const [re, lang] of LANG_DETECTORS) {
    if (re.test(code)) {
      scores[lang] = (scores[lang] || 0) + 2;
    }
  }

  // Additional scoring per line
  for (const line of lines) {
    if (/^\s*def\s/.test(line)) scores.python = (scores.python || 0) + 2;
    if (/^\s*class\s+\w+:/.test(line)) scores.python = (scores.python || 0) + 1;
    if (/self\./.test(line)) scores.python = (scores.python || 0) + 1;
    if (/^\s*print\s*\(/.test(line)) scores.python = (scores.python || 0) + 1;

    if (/^\s*(const|let|var)\s/.test(line)) scores.javascript = (scores.javascript || 0) + 2;
    if (/console\.\w+/.test(line)) scores.javascript = (scores.javascript || 0) + 1;
    if (line.endsWith(";") && !line.endsWith("};") && !/^\s*for\s*\(/.test(line)) {
      scores.javascript = (scores.javascript || 0) + 1;
    }

    if (/^\s*fn\s/.test(line)) scores.rust = (scores.rust || 0) + 2;
    if (/^\s*let\s+mut\b/.test(line)) scores.rust = (scores.rust || 0) + 1;

    if (/^\s*func\s/.test(line)) scores.go = (scores.go || 0) + 2;
    if (/:=/.test(line)) scores.go = (scores.go || 0) + 1;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : undefined;
}

const LANG_FILENAME_EXT: Record<string, string> = {
  python: "main.py",
  javascript: "index.js",
  typescript: "index.ts",
  go: "main.go",
  rust: "main.rs",
  java: "Main.java",
  ruby: "main.rb",
  html: "index.html",
  css: "styles.css",
  c: "main.c",
  cpp: "main.cpp",
};

/**
 * Transform text segments that contain raw code (without markdown fences)
 * into proper code segments. Handles any programming language.
 */
export function transformRawCodeSegments(
  segments: TransformedSegment[],
): TransformedSegment[] {
  const result: TransformedSegment[] = [];
  for (const seg of segments) {
    if (seg.type === "code") {
      result.push(seg);
      continue;
    }
    const text = seg.content;
    if (!isSubstantialCode(text)) {
      result.push(seg);
      continue;
    }

    const codeStart = findCodeStart(text);
    if (codeStart === -1) {
      result.push(seg);
      continue;
    }

    const prose = text.slice(0, codeStart).trim();
    const code = text.slice(codeStart).trim();
    if (prose) {
      result.push({ type: "text", content: prose });
    }
    const language = detectCodeLanguage(code);
    const filename = language ? LANG_FILENAME_EXT[language] : undefined;
    result.push({ type: "code", content: code, language, filename });
  }
  return result;
}
