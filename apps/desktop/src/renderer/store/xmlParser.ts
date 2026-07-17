// ============================================================================
// XML Tool Call Parser
// ============================================================================
// Some models output tool calls as XML tags in their text response instead of
// using the proper tool-call protocol. This parser extracts those XML tags and
// converts them to ToolCall objects so they can be executed and displayed properly.

// Build regex inside function calls to avoid lastIndex mutation issues with global flag
function createToolCallRegex(): RegExp {
  return /<([a-zA-Z_][a-zA-Z0-9_-]*)((?:\s+[a-zA-Z_][a-zA-Z0-9_-]*=(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
}
const XML_ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|'([^']*)')/g;

import {
  TAG_TO_TOOL,
  ALL_TOOL_NAMES,
  TOOL_CATEGORIES,
} from "@/lib/toolSchemas";
const KNOWN_TAG_NAMES = ALL_TOOL_NAMES;

// Regex to strip ALL XML tool call tags (opening, closing, and self-closing) from content.
// Uses a simple non-backtracking pattern for attribute matching to avoid ReDoS.
// For tag stripping purposes, matching > inside attribute values is not critical.
const XML_ATTR_ANY = `[^>]*`;
const XML_STRIP_RE = new RegExp(
  `<(${KNOWN_TAG_NAMES.join("|")})${XML_ATTR_ANY}>[\\s\\S]*?<\\/\\1>|<(${KNOWN_TAG_NAMES.join("|")})${XML_ATTR_ANY}\\/?>`,
  "gi"
);
const XML_CLOSING_TAG_RE = new RegExp(`<\\/(${KNOWN_TAG_NAMES.join("|")})>`, "gi");
// Strip complete opening tags that have no matching closing tag in the content.
// During streaming, a complete opening tag like <read_file path="/foo"> ends with `>`
// but has no `</read_file>` yet. Neither XML_STRIP_RE (needs pair) nor XML_INCOMPLETE_TAG_RE
// (needs no `>`) catches it, leaving it visible in the typing animation.
const XML_OPENING_TAG_RE = new RegExp(`<(${KNOWN_TAG_NAMES.join("|")})${XML_ATTR_ANY}>`, "gi");
const XML_MCP_STRIP_RE = /<mcp_[\s\S]*?<\/mcp_[^>]*>|<mcp_[^>]*\/>/gi;
const XML_MCP_OPENING_TAG_RE = /<mcp_[a-zA-Z_][a-zA-Z0-9_-]*[^>]*>/gi;
const XML_MCP_CLOSING_TAG_RE = /<\/mcp_[^>]*>/gi;
// Strip ANY partial-looking XML tag at end of content, not just known tool names.
// SSE chunk boundaries can split tag names (e.g. <read_fi in one chunk, le> in the next),
// so matching only known tool names lets partial names leak through for ~16ms (one rAF frame).
// This matches <word, </word, <word attr="val etc. at end of content.
// NOTE: We strip both bare tag names (<browser) and tags with attributes (<run_command cmd="x")
// at end of content. The orphan cleanup regex at the end of the function catches any
// text that leaks through when a tag is split across streaming chunk boundaries.
const XML_INCOMPLETE_TAG_RE = /<\/?[a-zA-Z_][a-zA-Z0-9_-]*(?:\s[^>]*)?$/g;
// Strip model output tags WITH their content (e.g. <thinking>...</thinking>)
const XML_MODEL_OUTPUT_CONTENT_RE = new RegExp(`<(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)${XML_ATTR_ANY}>[\\s\\S]*?</(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)\\s*>`, "gi");
const XML_MODEL_OUTPUT_RE = new RegExp(`</(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)${XML_ATTR_ANY}>|<(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)${XML_ATTR_ANY}/?>`, "gi");
const XML_MODEL_OUTPUT_CLOSE_RE = /<\/?(?:user|assistant|system|thinking|think|thought|reasoning|reasoning_content|analysis|plan|response|output|result|content|message|final)\s*>/gi;
// Strip skill invocation / structured plan XML tags emitted by models in Plan mode.
const XML_SKILL_INVOCATION_RE = /<skill_invocation[\s\S]*?<\/skill_invocation>|<skill_invocation[^>]*\/>/gi;
const XML_STRUCTURED_TAG_RE = /<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*>[\s\S]*?<\/(?:parameter|goal|subgoal|steps|step|constraint|context|scope)>|<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*\/>/gi;
const XML_STRUCTURED_ORPHAN_CLOSE_RE = /<\/(?:parameter|goal|subgoal|steps|step|constraint|context|scope)>/gi;

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// ── Pre-computed Orphan Tag Cleanup Regexes ──────────────────────
// Cache combined regexes built from ALL_TOOL_NAMES so we don't regenerate
// them per-call (which would be 4+ new RegExp per tool name × 60+ tools = 240+ ops/call).
let _orphanCombinedRe: RegExp | null = null;
let _orphanPartialCombinedRe: RegExp | null = null;

function _buildOrphanRegexes(): void {
  if (!_orphanCombinedRe && KNOWN_TAG_NAMES.length > 0) {
    const escaped = KNOWN_TAG_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const alt = escaped.join('|');
    // Matches full tool name at line start followed by: attributes+/>, attributes (no close), or optional whitespace+/>
    _orphanCombinedRe = new RegExp(
      `(?:^|\\n)\\s*(?:${alt})(?:(?:\\s+[^<]*?(?:\\/?>|$))|(?:\\s*\\/?\\s*))`,
      'gi'
    );
    const partials: string[] = [];
    for (const name of KNOWN_TAG_NAMES) {
      if (name.length > 3) {
        partials.push(name.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    }
    if (partials.length > 0) {
      _orphanPartialCombinedRe = new RegExp(
        `(?:^|\\n)\\s*(?:${partials.join('|')})(?:\\s+[^<]*?(?:\\/?>|$)|\\s*\\/?>)`,
        'gi'
      );
    }
  }
}

function _cleanupOrphanToolTags(content: string): string {
  _buildOrphanRegexes();
  let result = content;
  if (_orphanCombinedRe) {
    result = result.replace(_orphanCombinedRe, '');
  }
  if (_orphanPartialCombinedRe) {
    result = result.replace(_orphanPartialCombinedRe, '');
  }
  return result;
}

/**
 * Strip all XML tool call tags from content (for display purposes).
 * Handles opening+closing pairs, self-closing tags, and closing-only tags.
 * Also handles malformed XML (unescaped quotes in attributes, broken tags).
 */
export function stripXmlToolCallTags(content: string): string {
  // Fast path: skip all regex if content has no angle brackets or known patterns.
  // Most streaming content is plain text — this avoids ~15 regex passes entirely.
  if (content.length < 200) {
    // Short content: only strip if it contains obvious XML-like patterns
    if (!content.includes("<") && !content.includes("question")) return content;
  } else if (!content.includes("<")) {
    return content;
  }
  let result = content;
  // Strip opening+content+closing blocks: <tool ...>content</tool>
  // and self-closing tags: <tool .../>
  result = result.replace(XML_STRIP_RE, "");
  // Strip complete opening tags that have no matching closing tag (streaming artifact).
  // After XML_STRIP_RE, any remaining opening tag of a known tool is unpaired and must
  // be removed to prevent it from appearing in the typing animation.
  result = result.replace(XML_OPENING_TAG_RE, "");
  // Strip orphan closing tags that weren't paired above: </tool>
  result = result.replace(XML_CLOSING_TAG_RE, "");
  // Strip MCP tags (pairs, self-closing, orphan closing, and unpaired opening during streaming)
  result = result.replace(XML_MCP_STRIP_RE, "");
  result = result.replace(XML_MCP_OPENING_TAG_RE, "");
  result = result.replace(XML_MCP_CLOSING_TAG_RE, "");
  // Strip malformed question tags without opening < (LLM output quirk)
  result = result.replace(/(?:^|[\s<])question\s+question="[^"]*"\s+options="[^"]*"\s*\/?>/g, "");
  // Strip Anthropic antml:function_calls / <invoke> blocks
  result = result.replace(/(?:antml:function_calls\s*)?<invoke[\s\S]*?<\/(?:antml:)?function_calls\s*>/gi, "");
  // Strip generic <function_calls> blocks (Llama, Mistral, vLLM, OpenAI leaks)
  result = result.replace(/<function_calls[\s\S]*?<\/function_calls>/gi, "");
  result = result.replace(/<\/?function_calls[^>]*>/gi, "");
  // Strip orphan antml tags
  result = result.replace(/<\/?antml:[^>]*>/gi, "");
  // Strip orphan <invoke> tags
  result = result.replace(/<\/?invoke[^>]*>/gi, "");
  // Strip incomplete XML tool tags at end of content (arriving across streaming deltas)
  // Matches: <run_command command="ls -la$  (no closing > or />)
  result = result.replace(XML_INCOMPLETE_TAG_RE, "");
  // Strip DeepSeek special tokens (unicode bracket tokens)
  result = result.replace(/<\uff5c[\s\S]*?\uff5c>/g, "");
  // Strip OpenAI internal channel tokens WITH their content (e.g. <|channel|>leaked text<|end|>)
  result = result.replace(/<\|(?:channel|message|system_call)\|>[\s\S]*?<\|(?:channel|message|end|system_call)\|>/gi, "");
  result = result.replace(/<\|start\|>[\s\S]*?<\|end\|>/gi, "");
  // Strip any remaining OpenAI internal channel/message token markers
  result = result.replace(/<\|(?:channel|message|start|end|system_call)\|>/gi, "");
  // Strip incomplete think/streaming tags at end of content
  result = result.replace(/<think[^>]*$/gi, "");
  result = result.replace(/<function_calls[^>]*$/gi, "");
  // Strip broken/malformed tag fragments from model output (e.g. ><]minimax[>][)
  result = result.replace(/>\]\s*<[^>]*>?\[</g, "");
  result = result.replace(/\]>\s*\[</g, "");
  result = result.replace(/<\]?\w+\[>?\]?\[?/g, "");
  // Strip skill invocation / structured plan XML blocks (Plan mode)
  result = result.replace(XML_SKILL_INVOCATION_RE, "");
  result = result.replace(XML_STRUCTURED_TAG_RE, "");
  result = result.replace(XML_STRUCTURED_ORPHAN_CLOSE_RE, "");
  // Strip model output tags WITH their content (e.g. <thinking>...</thinking>)
  result = result.replace(XML_MODEL_OUTPUT_CONTENT_RE, "");
  // Strip remaining model output tag markers
  result = result.replace(XML_MODEL_OUTPUT_RE, "");
  // Strip orphan closing tags for the above
  result = result.replace(XML_MODEL_OUTPUT_CLOSE_RE, "");
  // Strip incomplete skill/structured tags at end of content (streaming)
  result = result.replace(/<skill_invocation[^>]*$/gi, "");
  result = result.replace(/<\/?(?:parameter|goal|subgoal|steps|step|constraint|context|scope)[^>]*$/gi, "");
  // Clean up orphaned tool call text fragments — when an incomplete tag like <browser_navigate
  // was stripped during streaming, the remaining text (rowser_navigate url="..."/> ) leaks through
  // because it doesn't start with <. Strip these using pre-computed combined regexes.
  //
  // Build combined patterns once to avoid O(tool_names × n) regex operations.
  // Each call creates the combined regex on first use; subsequent calls reuse the cached version.
  result = _cleanupOrphanToolTags(result);
  // Strip orphaned partial tool name suffixes (e.g. "_navigate url=..." from split "browser")
  // and orphaned XML attribute text at line boundaries (e.g. 'url="http://..." />')
  // Strip orphaned partial tool name suffixes (e.g. "_navigate url=..." from split "browser")
  // and orphaned XML attribute text at line boundaries (e.g. 'url="http://..." />')
  const ORPHAN_SUFFIX_RE = /(?:^|\n)\s*(?:[a-z_]+(?:_navigate|_execute|_file|_command|_result|_status|_plan))\s*=?\s*[^<\n]*$/gim;
  result = result.replace(ORPHAN_SUFFIX_RE, "");
  // Also strip orphaned attribute text at line boundaries (url="...", path="...", command="...")
  const ORPHAN_ATTR_RE = /(?:^|\n)\s*(?:url|path|command|pattern|query|content|name|src|href)\s*=\s*"[^"]*"\s*\/?>?\s*$/gim;
  result = result.replace(ORPHAN_ATTR_RE, "");
  // Clean up excessive whitespace left behind
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n");
  // If the entire remaining content is just whitespace, return empty string
  // (this handles cases where only tool calls were in the content and they've all been stripped)
  if (result.trim() === "") result = "";
  return result;
}

// ── Stateful streaming: suppress content inside body-bearing XML tags ────────
// Tags whose body content must be hidden during streaming (file writes, etc.)
const BODY_TAG_NAMES = new Set(["write_file", "edit_file", "clipboard_write", "memory_save", "browser_execute"]);

/**
 * Module-level Map tracking which body tag each session is currently inside.
 * Keyed by sessionId (or "_default" for backward compatibility).
 * Value is the body tag name (e.g. "write_file") or null if not inside a body tag.
 * Using a Map avoids race conditions in multi-stream scenarios.
 */
const _bodyTagState = new Map<string, string | null>();
const MAX_BODY_TAG_SESSIONS = 20;

/** Get or create the body tag state for a session, with LRU pruning */
function _getBodyTag(sessionId: string): string | null {
  if (!_bodyTagState.has(sessionId)) {
    // Prune oldest entry if at capacity before adding a new session
    if (_bodyTagState.size >= MAX_BODY_TAG_SESSIONS) {
      const firstKey = _bodyTagState.keys().next().value;
      if (firstKey !== undefined) _bodyTagState.delete(firstKey);
    }
    _bodyTagState.set(sessionId, null);
  }
  return _bodyTagState.get(sessionId) ?? null;
}

/** Set the body tag state for a session */
function _setBodyTag(sessionId: string, tag: string | null): void {
  // Prune oldest entries if at capacity (only when adding a new session)
  if (!_bodyTagState.has(sessionId) && _bodyTagState.size >= MAX_BODY_TAG_SESSIONS) {
    const firstKey = _bodyTagState.keys().next().value;
    if (firstKey !== undefined) _bodyTagState.delete(firstKey);
  }
  _bodyTagState.set(sessionId, tag);
}

/**
 * Fast inline XML tag stripper for streaming deltas.
 * Strips known tool call, model output, and MCP XML tags (opening, closing, self-closing, partial).
 * Designed to be called per `message-delta` event — avoids the full regex suite of
 * stripXmlToolCallTags for performance.
 * Also suppresses content inside body-bearing tags (write_file, edit_file, etc.)
 * across multiple streaming deltas.
 *
 * @param content - The streaming delta content to strip
 * @param sessionId - Optional session ID for multi-stream isolation. If omitted, uses "_default".
 */
export function stripInlineXml(content: string, sessionId?: string): string {
  const sid = sessionId ?? "_default";
  if (!content) return content;

  // Stateful: if we're inside a body-bearing tag, suppress everything until closing tag
  const currentBodyTag = _getBodyTag(sid);
  if (currentBodyTag) {
    const closeTag = `</${currentBodyTag}>`;
    const closeIdx = content.indexOf(closeTag);
    if (closeIdx !== -1) {
      // Found closing tag — suppress everything before it, keep rest
      _setBodyTag(sid, null);
      const rest = content.slice(closeIdx + closeTag.length);
      // Continue processing the rest normally
      content = rest;
    } else {
      // Still inside the body tag — suppress entire delta
      return "";
    }
  }

  if (!content.includes("<")) return content;
  // Fast path: strip known tool call opening tags with attributes (most common leak)
  // e.g. <read_file path="/foo"> or <read_file path="/foo"/>
  let result = content;

  // Check if an opening body-bearing tag appears in this delta
  for (const bodyTag of BODY_TAG_NAMES) {
    const openRe = new RegExp(`<${bodyTag}(?:\\s[^>]*)?>`, "gi");
    const openMatch = openRe.exec(result);
    if (openMatch) {
      // Check if the closing tag also exists in this delta
      const closeTag = `</${bodyTag}>`;
      const afterOpen = result.slice(openMatch.index + openMatch[0].length);
      if (afterOpen.includes(closeTag)) {
        // Both tags in same delta — strip the whole block (handled by XML_STRIP_RE below)
      } else {
        // Opening tag without closing — we're now inside the body
        _setBodyTag(sid, bodyTag);
        // Strip everything from the opening tag onward (content will be suppressed in next deltas)
        result = result.slice(0, openMatch.index);
        // Also strip any content after the opening tag in this delta
        return result.replace(/\s+$/, "");
      }
    }
  }

  result = result.replace(XML_STRIP_RE, "");
  result = result.replace(XML_OPENING_TAG_RE, "");
  result = result.replace(XML_CLOSING_TAG_RE, "");
  result = result.replace(XML_MCP_STRIP_RE, "");
  result = result.replace(XML_MCP_OPENING_TAG_RE, "");
  result = result.replace(XML_MCP_CLOSING_TAG_RE, "");
  // Strip incomplete tags at end of content (split across SSE boundaries)
  result = result.replace(XML_INCOMPLETE_TAG_RE, "");
  // Strip model output tags
  result = result.replace(XML_MODEL_OUTPUT_CONTENT_RE, "");
  result = result.replace(XML_MODEL_OUTPUT_RE, "");
  result = result.replace(XML_MODEL_OUTPUT_CLOSE_RE, "");
  // Strip think/reasoning tags
  result = result.replace(/<think[^>]*$/gi, "");
  // Strip orphan antml, invoke, function_calls tags
  result = result.replace(/<\/?(?:antml:|invoke|function_calls)[^>]*>/gi, "");
  // Strip DeepSeek special tokens
  result = result.replace(/<\uff5c[\s\S]*?\uff5c>/g, "");
  // Strip OpenAI internal channel tokens
  result = result.replace(/<\|(?:channel|message|start|end|system_call)\|>/gi, "");
  // Clean up orphaned tool call text fragments (same as stripXmlToolCallTags)
  result = _cleanupOrphanToolTags(result);
  const ORPHAN_SUFFIX_RE = /(?:^|\n)\s*(?:_navigate|_execute|_file|_command|_result|_status)\s+[^<]*?\/?>\s*/gi;
  result = result.replace(ORPHAN_SUFFIX_RE, "");
  return result;
}

// Tool name → permission kind mappings (module-level to avoid recreation per event)
export const EDIT_TOOLS = TOOL_CATEGORIES.edit;
export const BASH_TOOLS = TOOL_CATEGORIES.bash;
export const READ_TOOLS = TOOL_CATEGORIES.read;

/**
 * Parse XML-style tool calls from assistant text content.
 * Returns extracted tool calls and the cleaned content with XML tags removed.
 */
export function parseXmlToolCalls(content: string): {
  toolCalls: import("@dalam/shared-types").ToolCall[];
  cleanedContent: string;
} {
  const toolCalls: import("@dalam/shared-types").ToolCall[] = [];
  const TOOL_CALL_RE = createToolCallRegex();
  let match: RegExpExecArray | null;

  // Track content ranges that are inside edit_file/skill blocks to skip child tags
  const skipRanges: Array<{ start: number; end: number }> = [];

  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    const [fullMatch, tagName, attrString] = match;
    const matchIndex = match.index;

    // Skip tags inside content blocks of edit_file or similar container tools
    if (skipRanges.some(r => matchIndex >= r.start && matchIndex < r.end)) continue;

    const toolName = TAG_TO_TOOL[tagName] ?? tagName;

    // Skip if it's not a recognized tool and doesn't look like a tool call
    if (!TAG_TO_TOOL[tagName] && !attrString) continue;

    const args: Record<string, unknown> = {};
    if (attrString) {
      let attrMatch: RegExpExecArray | null;
      XML_ATTR_RE.lastIndex = 0;
      while ((attrMatch = XML_ATTR_RE.exec(attrString)) !== null) {
        args[attrMatch[1]] = decodeXmlEntities(attrMatch[2] ?? attrMatch[3]);
      }
    }

    // Check if this is a self-closing tag (ends with />)
    const isSelfClosing = fullMatch.endsWith("/>");

    // Extract content between opening and closing tags (only for non-self-closing)
    let tagContent = "";
    if (!isSelfClosing) {
      const closingTag = `</${tagName}>`;
      const closeIdx = content.indexOf(closingTag, match.index + fullMatch.length);
      if (closeIdx !== -1) {
        tagContent = content.slice(match.index + fullMatch.length, closeIdx);
        // Register the content range so child tags are skipped
        skipRanges.push({ start: match.index + fullMatch.length, end: closeIdx });
      }
    }

    // Skip tool calls that have no meaningful arguments
    // (e.g., <read_file/> without path, <write_file/> without content)
    if (!tagContent.trim() && Object.keys(args).length === 0) continue;

    // If there's tag content, add it as "content" arg
    if (tagContent.trim()) {
      args.content = tagContent.trim();
    }

    toolCalls.push({
      id: "xml-tc-" + crypto.randomUUID(),
      name: toolName,
      args,
      status: "completed" as const,
      result: tagContent || undefined,
    });
  }

  // Use the comprehensive strip function to clean all XML tags
  const cleanedContent = stripXmlToolCallTags(content);

  return { toolCalls, cleanedContent };
}

/**
 * Reset the streaming body-tag state for a specific session.
 * Call this when starting a new message to ensure leftover state
 * from a previous stream doesn't carry over.
 *
 * @param sessionId - Optional session ID. If omitted, resets ALL sessions
 *                    (safe catch-all for backward compatibility).
 */
export function resetStreamingState(sessionId?: string): void {
  if (sessionId) {
    _setBodyTag(sessionId, null);
  } else {
    // Full reset: clear all session state
    _bodyTagState.clear();
  }
}
