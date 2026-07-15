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
// Uses a pattern that handles > inside quoted attribute values.
const XML_ATTR_ANY = `(?:[^>"']*|"[^"]*"|'[^']*')*`;
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
  // Clean up excessive whitespace left behind
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n");
  // If the entire remaining content is just whitespace, return empty string
  // (this handles cases where only tool calls were in the content and they've all been stripped)
  if (result.trim() === "") result = "";
  return result;
}

/**
 * Fast inline XML tag stripper for streaming deltas.
 * Strips known tool call, model output, and MCP XML tags (opening, closing, self-closing, partial).
 * Designed to be called per `message-delta` event — avoids the full regex suite of
 * stripXmlToolCallTags for performance.
 */
export function stripInlineXml(content: string): string {
  if (!content || !content.includes("<")) return content;
  // Fast path: strip known tool call opening tags with attributes (most common leak)
  // e.g. <read_file path="/foo"> or <read_file path="/foo"/>
  let result = content;
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
    if (!tagContent.trim() && Object.keys(args).length === 0 && !isSelfClosing) continue;

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
