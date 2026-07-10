/**
 * Dalam Context Manager
 *
 * Manages context window pressure, automatic compaction,
 * tool output pruning, checkpoint triggers, and workspace memory.
 *
 * Research basis:
 * - MiMo-Code: 3-trigger checkpoint system (20%/45%/70%), budgeted injection (~65K)
 * - OpenCode: COMPACTION_BUFFER=20K, PRUNE_PROTECT=40K, backward-scan pruning,
 *   SUMMARY_TEMPLATE (Goal/Instructions/Discoveries/Accomplished)
 * - Claude Code: MEMORY.md pointer index (≤200 lines)
 *
 * Optimization: Token estimation uses LRU cache to avoid re-estimating
 * unchanged text. Cache is invalidated when text changes.
 */

import type { ChatMessage } from "@dalam/shared-types";

export type ContextPressure = "none" | "low" | "medium" | "high";

// Import shared CTX from memoryTypes to avoid duplication
import { CTX, OUTPUT_RESERVES } from "./memoryTypes";

// Re-export for backward compatibility
export { CTX } from "./memoryTypes";

// ContextManager-specific overrides (OUTPUT_RESERVE here is for context pressure
// calculation, not the MiMo budget — keep it small for accurate pressure detection)
const CTX_LOCAL = {
  ...CTX,
  OUTPUT_RESERVE: OUTPUT_RESERVES.PRESSURE,
};

// ─── Token Estimation Cache ──────────────────────────────────
// LRU cache for token estimates to avoid re-computing for unchanged text.
// Key: text content, Value: token count. Limited to 1000 entries.

interface TokenCacheEntry {
  tokens: number;
}

const _tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_CACHE_MAX = 1000;

function getCachedTokenCount(text: string): number | null {
  const entry = _tokenCache.get(text);
  if (entry) return entry.tokens;
  return null;
}

function setCachedTokenCount(text: string, tokens: number): void {
  // Skip caching for very large texts to prevent memory pressure
  // (large tool outputs are unlikely to be re-estimated)
  if (text.length > 10_000) return;
  // Evict oldest entry if cache is full
  if (_tokenCache.size >= TOKEN_CACHE_MAX) {
    const firstKey = _tokenCache.keys().next().value;
    if (firstKey !== undefined) _tokenCache.delete(firstKey);
  }
  _tokenCache.set(text, { tokens });
}

/**
 * Clear the token estimation cache.
 * Call when conversation is compacted or messages are significantly modified.
 */
export function clearTokenCache(): void {
  _tokenCache.clear();
}

export type ContextStats = {
  totalTokens: number;
  usableTokens: number;
  reservedTokens: number;
  pressure: ContextPressure;
  pressureRatio: number;
  messageCount: number;
  needsCompaction: boolean;
  shouldPrune: boolean; // tool outputs should be pruned
  nextCheckpointTrigger: number | null; // next unfired trigger threshold (e.g. 0.20), or null if none pending
  shouldCompact: boolean; // full compaction needed (≥95%)
  shouldProactivePrune: boolean; // proactive tool output pruning (≥60%)
  shouldProactiveCompact: boolean; // proactive compaction trigger (≥75%)
};

// ─── Proactive Context Management ────────────────────────────
// Thresholds for proactive compression (more aggressive than reactive)
const PROACTIVE_PRUNE_THRESHOLD = 0.6; // Start pruning tool outputs at 60%
const PROACTIVE_COMPACT_THRESHOLD = 0.75; // Trigger background compaction at 75%

/**
 * Check if proactive context management should be triggered.
 * This is called before each LLM call to prevent sudden context loss.
 *
 * Returns an object with recommended actions:
 * - shouldPrune: Proactively prune old tool outputs
 * - shouldCompact: Trigger background compaction
 * - reason: Human-readable reason for the action
 */
export function checkProactiveContextManagement(
  messages: ChatMessage[],
  maxContextTokens: number = 128000,
): { shouldPrune: boolean; shouldCompact: boolean; reason: string } {
  const stats = computeContextStats(messages, maxContextTokens);

  if (stats.pressureRatio >= PROACTIVE_COMPACT_THRESHOLD) {
    return {
      shouldPrune: true,
      shouldCompact: true,
      reason: `Context at ${Math.round(stats.pressureRatio * 100)}% — proactive compaction recommended`,
    };
  }

  if (stats.pressureRatio >= PROACTIVE_PRUNE_THRESHOLD) {
    return {
      shouldPrune: true,
      shouldCompact: false,
      reason: `Context at ${Math.round(stats.pressureRatio * 100)}% — proactive tool output pruning recommended`,
    };
  }

  return {
    shouldPrune: false,
    shouldCompact: false,
    reason: `Context at ${Math.round(stats.pressureRatio * 100)}% — no action needed`,
  };
}

/**
 * Get proactive context management recommendations.
 * Used by the UI to display context pressure indicators.
 */
export function getContextPressureRecommendation(
  pressure: ContextPressure,
  _pressureRatio: number,
): { color: string; label: string; action: string } {
  switch (pressure) {
    case "high":
      return {
        color: "#ef4444", // red
        label: "High",
        action: "Compaction recommended",
      };
    case "medium":
      return {
        color: "#f97316", // orange
        label: "Medium",
        action: "Monitor context usage",
      };
    case "low":
      return {
        color: "#eab308", // yellow
        label: "Low",
        action: "Approaching limit",
      };
    default:
      return {
        color: "#22c55e", // green
        label: "Normal",
        action: "No action needed",
      };
  }
}

/**
 * Compute the next checkpoint trigger that hasn't fired yet.
 * Caller is responsible for tracking which triggers have fired.
 */
export function getNextCheckpointTrigger(
  firedUpToPercent: number,
): number | null {
  const next = CTX.CHECKPOINT_TRIGGERS.find((t) => t > firedUpToPercent);
  return next ?? null;
}

/**
 * Parse a context window string like "128k", "200k", "1m" into a number.
 * Returns 128000 as fallback for unparseable values.
 */
export function parseContextWindow(window: string | undefined): number {
  if (!window) return 128000;
  const lower = window.toLowerCase().trim();
  const num = parseFloat(lower);
  if (isNaN(num)) return 128000;
  if (lower.endsWith("m")) return Math.round(num * 1000000);
  if (lower.endsWith("k")) return Math.round(num * 1000);
  return Math.round(num);
}

/**
 * Estimate token count from a string. Uses a more accurate heuristic:
 * - English text: ~4 chars per token (GPT-4 average)
 * - Code: ~3.5 chars per token (code has more unique tokens)
 * - CJK characters: ~1.5 chars per token
 * - Whitespace/punctuation: ~1 char per token
 *
 * Based on OpenAI's tokenizer behavior and tiktoken benchmarks.
 *
 * Uses LRU cache to avoid re-computing for unchanged text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Check cache first
  const cached = getCachedTokenCount(text);
  if (cached !== null) return cached;

  let count = 0;
  let codeMode = false;

  // Pre-scan for code fence boundaries (line-level detection)
  const lines = text.split("\n");
  const fenceLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      fenceLines.add(i);
    }
  }

  let lineNum = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Track line boundaries for code fence detection
    if (code === 10) {
      lineNum++;
      if (fenceLines.has(lineNum)) {
        codeMode = !codeMode;
      }
      count += 1;
      continue;
    }

    // CJK Unified Ideographs — ~1.5 chars per token
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      // CJK Compatibility
      count += 0.67;
    }
    // CJK punctuation and fullwidth forms — ~2 chars per token
    else if (
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols
      (code >= 0xff00 && code <= 0xffef)
    ) {
      // Fullwidth forms
      count += 0.5;
    }
    // Whitespace
    else if (code === 32 || code === 9) {
      count += 1;
    }
    // Code identifiers — ~4 chars per token (realistic for mixed code)
    else if (
      codeMode ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95
    ) {
      count += 0.25;
    }
    // Other characters — ~4 chars per token
    else {
      count += 0.25;
    }
  }

  const result = Math.ceil(count);

  // Cache the result
  setCachedTokenCount(text, result);

  return result;
}

// tiktoken-based estimation (when available)
let _tiktokenAvailable: boolean | null = null;
let _cachedEstimator: ((text: string) => number) | null = null;

/**
 * Get the best available token estimator.
 * Uses tiktoken (±5% accuracy) when available, falls back to heuristic (±20-30%).
 */
export async function getReliableEstimator(): Promise<
  (text: string) => number
> {
  if (_cachedEstimator) return _cachedEstimator;

  if (_tiktokenAvailable === null) {
    try {
      const { countTokens } = await import("./tokenizer");
      countTokens("test", "gpt-4");
      _tiktokenAvailable = true;
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[ContextManager] tiktoken not available, using heuristic:", e);
      _tiktokenAvailable = false;
    }
  }

  if (_tiktokenAvailable) {
    const { countTokens } = await import("./tokenizer");
    _cachedEstimator = (text: string) => countTokens(text, "gpt-4");
  } else {
    _cachedEstimator = estimateTokens;
  }
  return _cachedEstimator;
}

/**
 * Estimate tokens for a full message (content + metadata overhead).
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = estimateTokens(msg.content);
  // Add overhead for role, metadata
  tokens += 4;
  if (msg.toolCalls?.length) {
    tokens += msg.toolCalls.length * 20; // tool call overhead
  }
  if (msg.fileChanges?.length) {
    tokens += msg.fileChanges.length * 10;
  }
  return tokens;
}

/**
 * Compute context pressure level based on token usage.
 *
 * Thresholds (based on typical 128k context window):
 * - none:   < 50% used
 * - low:    50-70% used
 * - medium: 70-85% used
 * - high:   > 85% used
 */
export function computePressure(
  usedTokens: number,
  maxTokens: number = 128000,
): { pressure: ContextPressure; ratio: number } {
  if (maxTokens <= 0) return { pressure: "high", ratio: Infinity };
  const ratio = usedTokens / maxTokens;
  let pressure: ContextPressure = "none";
  if (ratio >= 0.85) pressure = "high";
  else if (ratio >= 0.7) pressure = "medium";
  else if (ratio >= 0.5) pressure = "low";
  return { pressure, ratio };
}

/**
 * Compute full context statistics for a conversation.
 */
export function computeContextStats(
  messages: ChatMessage[],
  maxContextTokens: number = 128000,
  outputReserveTokens: number = CTX_LOCAL.OUTPUT_RESERVE,
  compactionBufferTokens: number = CTX.COMPACTION_BUFFER,
): ContextStats {
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );
  const reservedTokens = outputReserveTokens + compactionBufferTokens;
  const usableTokens = maxContextTokens - reservedTokens;
  const { pressure, ratio } = computePressure(totalTokens, usableTokens);

  return {
    totalTokens,
    usableTokens,
    reservedTokens,
    pressure,
    pressureRatio: ratio,
    messageCount: messages.length,
    needsCompaction: ratio >= CTX.CHECKPOINT_HARD,
    shouldPrune: totalTokens > usableTokens - CTX.PRUNE_PROTECT,
    nextCheckpointTrigger: getNextCheckpointTrigger(ratio),
    shouldCompact: ratio >= CTX.COMPACT_THRESHOLD,
    shouldProactivePrune: ratio >= PROACTIVE_PRUNE_THRESHOLD,
    shouldProactiveCompact: ratio >= PROACTIVE_COMPACT_THRESHOLD,
  };
}

/**
 * Select messages to compact. Uses a smarter strategy than just taking the first N:
 *
 * 1. Protect the last N user turns (non-tool-result)
 * 2. Protect the first user message (establishes context)
 * 3. Protect messages with file changes (important for diffs)
 * 4. Compact tool results first (they're usually the largest)
 * 5. Then compact older assistant messages
 * 6. Keep recent assistant messages (they have the latest context)
 *
 * Strategy: Prioritize compacting large tool outputs and older messages
 * while preserving the conversation structure.
 */

/**
 * Align compaction boundaries to prevent splitting tool_call/tool_result pairs.
 *
 * In Dalam's architecture:
 * - Assistant messages can have `toolCalls` arrays (the tool calls to execute)
 * - Tool results come back as user messages with [TOOL RESULT: toolName] prefix
 * - The sequence is: assistant(toolCalls) → user(toolResult) → assistant(next)
 *
 * If we keep an assistant message with toolCalls but compact its tool results,
 * the model sees orphaned calls. This function ensures pairs stay together
 * by expanding the keep set to include related messages.
 *
 * Pattern inspired by Hermes _align_boundary_backward.
 */
/** Check if a message is a tool result (user message with tool prefix). */
export function _isToolResult(m: ChatMessage): boolean {
  return (
    m.role === "user" &&
    typeof m.content === "string" &&
    (m.content.startsWith("[TOOL RESULT:") ||
      m.content.startsWith("[TOOL ERROR:") ||
      m.content.startsWith("[Tool result for ") ||
      m.content.startsWith("[Tool error for "))
  );
}

/** Align compaction boundaries — exported for direct unit testing. */
export function _alignBoundaryPairs(
  messages: ChatMessage[],
  baseIndices: Set<number>,
): Set<number> {
  // Expand baseIndices (the keep set) to include related tool_call/tool_result
  // pairs so they stay together after compaction.
  const aligned = new Set(baseIndices);

  for (const idx of baseIndices) {
    const msg = messages[idx];
    if (!msg) continue;

    // Case 1: Assistant message with toolCalls is being KEPT
    // → also keep the following tool result messages to prevent orphaned calls
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Walk forward to capture all consecutive tool result messages
      // that follow this assistant's tool calls
      for (let j = idx + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === "user" && _isToolResult(next)) {
          aligned.add(j);
        } else {
          break;
        }
      }
    }

    // Case 2: Tool result message is being KEPT
    // → also keep the preceding assistant message with toolCalls
    if (msg.role === "user" && _isToolResult(msg)) {
      // Walk backward to find the assistant message with toolCalls
      for (let j = idx - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role === "assistant" && prev.toolCalls?.length) {
          aligned.add(j);
          break;
        }
        // Stop if we hit a real user message (not a tool result)
        if (prev.role === "user" && !_isToolResult(prev)) break;
        // Skip through consecutive tool results to find originating assistant
      }
    }
  }

  return aligned;
}

export function selectMessagesForCompaction(
  messages: ChatMessage[],
  keepRecent: number = 6,
): { toCompact: ChatMessage[]; toKeep: ChatMessage[] } {
  if (messages.length <= keepRecent) {
    return { toCompact: [], toKeep: messages };
  }

  // Identify which messages to protect — consolidated into a single backward pass
  const protectedIndices = new Set<number>();

  // Find the first user message in a forward pass (can't do everything backward)
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx >= 0) protectedIndices.add(firstUserIdx);

  // Single backward pass: protect recent user turns, recent assistant messages,
  // and messages with file changes/todos
  let userTurnCount = 0;
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Protect messages with file changes (important for diffs)
    if (m.fileChanges && m.fileChanges.length > 0) {
      protectedIndices.add(i);
    }
    // Protect messages with todos (important for task tracking)
    if (m.todos && m.todos.length > 0) {
      protectedIndices.add(i);
    }
    // Protect the last N user turns (non-tool-result)
    if (m.role === "user" && !_isToolResult(m) && userTurnCount < keepRecent) {
      protectedIndices.add(i);
      userTurnCount++;
    }
    // Protect recent assistant messages (last 3 non-tool messages)
    if (m.role === "assistant" && !_isToolResult(m) && assistantCount < 3) {
      protectedIndices.add(i);
      assistantCount++;
    }
    // Exit early once all tail protections are satisfied
    if (userTurnCount >= keepRecent && assistantCount >= 3) break;
  }

  // Align boundaries: prevent splitting tool_call/tool_result pairs
  const alignedIndices = _alignBoundaryPairs(messages, protectedIndices);

  // Split into compact and keep
  const toCompact: ChatMessage[] = [];
  const toKeep: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (alignedIndices.has(i)) {
      toKeep.push(messages[i]);
    } else {
      toCompact.push(messages[i]);
    }
  }

  return { toCompact, toKeep };
}

/**
 * Generate a compaction prompt for summarizing old messages.
 * Utility function — may be used by UI for manual compaction triggers.
 */
/**
 * OpenCode SUMMARY_TEMPLATE pattern for compaction.
 * Produces structured summaries with Goal/Instructions/Discoveries/Accomplished.
 */
export const SUMMARY_TEMPLATE = `You are a conversation compaction assistant. Produce a structured summary of the conversation below.

Format your summary as:

## Goal
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export function buildCompactionPrompt(
  messages: ChatMessage[],
  previousSummary?: string,
): { role: string; content: string }[] {
  const formatted: { role: string; content: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let content = m.content;

    // Preserve tool result user messages (the primary mechanism in ACode)
    // Look ahead for tool result messages that follow this message
    if (m.role === "assistant" && m.toolCalls?.length) {
      const toolResultMsgs: string[] = [];
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === "assistant") break; // next assistant turn
        if (next.role === "user" && !_isToolResult(next)) break; // real user message
        if (_isToolResult(next)) {
          const truncated =
            next.content.length > 500
              ? next.content.slice(0, 500) + "..."
              : next.content;
          toolResultMsgs.push(truncated);
        }
      }
      if (toolResultMsgs.length > 0) {
        content += `\n\nTool Results:\n${toolResultMsgs.join("\n---\n")}`;
      }
    }

    // Preserve file changes
    if (m.fileChanges?.length) {
      const changeSummary = m.fileChanges
        .map((fc) => `${fc.action}: ${fc.path}`)
        .join("\n");
      content += `\n\nFile Changes:\n${changeSummary}`;
    }

    // Preserve todos
    if (m.todos?.length) {
      const todoSummary = m.todos
        .map((t) => `${t.status === "completed" ? "✓" : "○"} ${t.content}`)
        .join("\n");
      content += `\n\nTodos:\n${todoSummary}`;
    }

    formatted.push({
      role: m.role === "user" ? "user" : "assistant",
      content,
    });
  }

  if (previousSummary) {
    return [
      {
        role: "user",
        content: `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${SUMMARY_TEMPLATE}`,
      },
      {
        role: "assistant",
        content:
          "I will merge the previous summary with the new messages to produce an updated, comprehensive summary.",
      },
      ...formatted,
    ];
  }

  return [
    {
      role: "user",
      content: SUMMARY_TEMPLATE + "\n\nConversation to summarize:",
    },
    ...formatted,
  ];
}

/**
 * Tool output pruning (OpenCode backward-scan algorithm).
 *
 * In Dalam's architecture, tool results come back as user messages with
 * `[TOOL RESULT: ...]` or `[TOOL ERROR: ...]` prefixes (from dalamAPI.ts).
 * This function identifies those messages and prunes their content to
 * reclaim tokens, while protecting the last N user turns.
 *
 * Returns pruned messages and tokens reclaimed.
 */
export function pruneToolOutputs(
  messages: ChatMessage[],
  toolTokenEstimate: (msg: ChatMessage) => number = estimateMessageTokens,
): { pruned: ChatMessage[]; tokensReclaimed: number } {
  // Identify which turns to protect (last N user turns that are NOT tool results)
  const realUserTurnIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !_isToolResult(messages[i])) {
      realUserTurnIndexes.push(i);
    }
    if (realUserTurnIndexes.length >= CTX.TURN_PROTECT) break;
  }
  const protectAfter =
    realUserTurnIndexes.length > 0 ? Math.min(...realUserTurnIndexes) : 0;

  // Sort tool result messages by size (largest first) for more efficient pruning
  const toolIndicesWithSize: Array<{ idx: number; size: number }> = [];
  let totalPrunableToolTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i < protectAfter && _isToolResult(messages[i])) {
      const size = toolTokenEstimate(messages[i]);
      toolIndicesWithSize.push({ idx: i, size });
      totalPrunableToolTokens += size;
    }
  }

  if (totalPrunableToolTokens < CTX.PRUNE_PROTECT) {
    return { pruned: messages, tokensReclaimed: 0 };
  }

  // Sort descending by size — prune the biggest outputs first
  toolIndicesWithSize.sort((a, b) => b.size - a.size);

  let tokensReclaimed = 0;
  const toPrune = new Set<number>();

  for (const { idx, size } of toolIndicesWithSize) {
    if (
      tokensReclaimed >= CTX.PRUNE_MINIMUM &&
      totalPrunableToolTokens - tokensReclaimed < CTX.PRUNE_PROTECT
    ) {
      break; // enough reclaimed
    }
    tokensReclaimed += size;
    toPrune.add(idx);
  }

  if (toPrune.size === 0) {
    return { pruned: messages, tokensReclaimed: 0 };
  }

  const pruned = messages.map((msg, idx) => {
    if (!toPrune.has(idx)) return msg;

    // Extract tool name from either format:
    // [TOOL RESULT: name] or [TOOL ERROR: name] (colon format)
    // [Tool result for name] or [Tool error for name] (for-format)
    const toolMatch = msg.content.match(
      /^\[(?:TOOL (?:RESULT|ERROR):\s*(\S+)|Tool (?:result|error) for (\S+))/,
    );
    const toolName = toolMatch?.[1] ?? toolMatch?.[2] ?? "unknown";
    const originalTokens = toolTokenEstimate(msg);

    return {
      ...msg,
      content: `[Tool output pruned — ~${originalTokens} tokens reclaimed. Tool: ${toolName}]`,
    };
  });

  return { pruned, tokensReclaimed };
}

/**
 * Tier 1: Lightweight tool output pruning (no LLM call).
 *
 * Called when context usage reaches 50% (TIER1_PRUNE_RATIO).
 * Prunes the oldest and largest tool outputs to reclaim tokens
 * without consuming any API calls. This is a pre-emptive measure
 * inspired by Hermes' early 50% compression trigger.
 *
 * Unlike pruneToolOutputs (which is used during full compaction),
 * this function protects a larger tail of recent turns and only
 * truncates (not removes) tool outputs to preserve conversation flow.
 *
 * Returns the pruned messages and tokens reclaimed.
 */
export function tier1PruneToolOutputs(
  messages: ChatMessage[],
  toolTokenEstimate: (msg: ChatMessage) => number = estimateMessageTokens,
): { pruned: ChatMessage[]; tokensReclaimed: number } {
  // Protect the last N user turns that are NOT tool results (more conservative than tier2)
  const realUserTurnIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !_isToolResult(messages[i])) {
      realUserTurnIndexes.push(i);
    }
    if (realUserTurnIndexes.length >= CTX.TURN_PROTECT + 2) break; // Protect 4 recent real turns
  }
  const protectAfter =
    realUserTurnIndexes.length > 0 ? Math.min(...realUserTurnIndexes) : 0;

  // Identify prunable tool outputs (old ones outside the protected tail)
  const toolIndicesWithSize: Array<{ idx: number; size: number }> = [];
  let totalPrunableToolTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i < protectAfter && _isToolResult(messages[i])) {
      const size = toolTokenEstimate(messages[i]);
      // Only consider messages with substantial output (> 1K tokens)
      if (size > 1_000) {
        toolIndicesWithSize.push({ idx: i, size });
        totalPrunableToolTokens += size;
      }
    }
  }

  // Don't bother if there's nothing meaningful to reclaim
  if (totalPrunableToolTokens < CTX.PRUNE_MINIMUM) {
    return { pruned: messages, tokensReclaimed: 0 };
  }

  // Sort descending by size — truncate the biggest outputs first
  toolIndicesWithSize.sort((a, b) => b.size - a.size);

  let tokensReclaimed = 0;
  const toTruncate = new Set<number>();

  for (const { idx, size } of toolIndicesWithSize) {
    // Stop once we've reclaimed enough to matter (at least PRUNE_MINIMUM)
    if (tokensReclaimed >= CTX.PRUNE_MINIMUM) break;
    tokensReclaimed += size;
    toTruncate.add(idx);
  }

  if (toTruncate.size === 0) {
    return { pruned: messages, tokensReclaimed: 0 };
  }

  // Truncate (don't remove) — keep the header, drop the body
  const pruned = messages.map((msg, idx) => {
    if (!toTruncate.has(idx)) return msg;
    const toolMatch = msg.content.match(
      /^\[(?:TOOL (?:RESULT|ERROR):\s*(\S+)|Tool (?:result|error) for (\S+))/,
    );
    const toolName = toolMatch?.[1] ?? toolMatch?.[2] ?? "unknown";
    const originalTokens = toolTokenEstimate(msg);
    return {
      ...msg,
      content: `[TOOL RESULT: ${toolName}] Output truncated (~${originalTokens} tokens). Re-run the tool to see full output.`,
    };
  });

  return { pruned, tokensReclaimed };
}

// ─── Unlimited Context Management ─────────────────────────────
// Inspired by OpenCode's compaction pattern and MiMo's budgeted injection.
// These functions enable unlimited context by:
// 1. Token-aware message selection (select by budget, not count)
// 2. Rolling summaries that preserve full context across compactions
// 3. Multi-tier compression (prune → summarize → deep compact)

/**
 * Select messages to compact based on token budget, not just count.
 * This is more accurate than selectMessagesForCompaction which uses message count.
 *
 * Algorithm (matches OpenCode's select function):
 * 1. Protect the first user message (original task context)
 * 2. Protect recent messages within the keep budget
 * 3. Protect messages with file changes or todos
 * 4. Compact everything else, starting with largest tool outputs
 *
 * @param messages - All conversation messages
 * @param keepTokenBudget - Maximum tokens to keep (not compact)
 * @param estimateFn - Token estimation function
 * @returns Messages to compact and messages to keep
 */
export function selectMessagesByTokenBudget(
  messages: ChatMessage[],
  keepTokenBudget: number,
  estimateFn: (msg: ChatMessage) => number = estimateMessageTokens,
): { toCompact: ChatMessage[]; toKeep: ChatMessage[] } {
  if (messages.length <= 2) {
    return { toCompact: [], toKeep: messages };
  }

  // Build token costs for each message
  const tokenCosts = messages.map((m, i) => ({
    idx: i,
    tokens: estimateFn(m),
    role: m.role,
    isToolResult: _isToolResult(m),
    hasFileChanges: (m.fileChanges?.length ?? 0) > 0,
    hasTodos: (m.todos?.length ?? 0) > 0,
  }));

  // Protect first user message (original task context)
  const protectedIndices = new Set<number>();
  const firstUserIdx = tokenCosts.findIndex((c) => c.role === "user");
  if (firstUserIdx >= 0) protectedIndices.add(firstUserIdx);

  // Protect messages with file changes or todos (important for diffs/task tracking)
  for (const tc of tokenCosts) {
    if (tc.hasFileChanges || tc.hasTodos) {
      protectedIndices.add(tc.idx);
    }
  }

  // Protect recent messages within the keep budget (backward scan)
  let keepTokens = 0;
  for (let i = tokenCosts.length - 1; i >= 0; i--) {
    if (keepTokens + tokenCosts[i].tokens > keepTokenBudget) break;
    // Don't protect tool results in the keep set unless they're very recent
    if (tokenCosts[i].isToolResult && i < tokenCosts.length - 2) continue;
    protectedIndices.add(tokenCosts[i].idx);
    keepTokens += tokenCosts[i].tokens;
  }

  // Align boundaries: prevent splitting tool_call/tool_result pairs
  const alignedIndices = _alignBoundaryPairs(messages, protectedIndices);

  // Split into compact and keep
  const toCompact: ChatMessage[] = [];
  const toKeep: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (alignedIndices.has(i)) {
      toKeep.push(messages[i]);
    } else {
      toCompact.push(messages[i]);
    }
  }

  return { toCompact, toKeep };
}

/**
 * Build a rolling summary from compacted messages.
 * This creates a concise summary that can be injected as context
 * when the conversation exceeds the context window.
 *
 * The rolling summary preserves:
 * - Original task/goal
 * - Key decisions and constraints
 * - Completed work
 * - Active work and blockers
 * - Relevant file paths
 *
 * @param messages - Messages to summarize
 * @param previousSummary - Previous rolling summary (if any)
 * @returns Structured summary string
 */
export function buildRollingSummary(
  messages: ChatMessage[],
  previousSummary?: string,
): string {
  if (messages.length === 0) return previousSummary ?? "";

  // Extract key information from messages
  const goals: string[] = [];
  const completed: string[] = [];
  const active: string[] = [];
  const files: Set<string> = new Set();
  const errors: string[] = [];

  for (const msg of messages) {
    // Extract goals from first user messages
    if (msg.role === "user" && !_isToolResult(msg) && goals.length < 2) {
      const goal = msg.content.slice(0, 200).replace(/\n/g, " ");
      if (goal.length > 10) goals.push(goal);
    }

    // Extract file changes
    if (msg.fileChanges?.length) {
      for (const fc of msg.fileChanges) {
        files.add(`${fc.action}: ${fc.path}`);
      }
    }

    // Extract tool results (completed work)
    if (msg.role === "user" && _isToolResult(msg)) {
      const toolMatch = msg.content.match(
        /^\[(?:TOOL RESULT|Tool result) for (\S+)\]/,
      );
      if (toolMatch) {
        const toolName = toolMatch[1];
        const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
        if (preview.length > 20) completed.push(`[${toolName}] ${preview}`);
      }
    }

    // Extract errors
    if (
      msg.role === "user" &&
      _isToolResult(msg) &&
      msg.content.includes("[Tool error")
    ) {
      const errorPreview = msg.content.slice(0, 100).replace(/\n/g, " ");
      errors.push(errorPreview);
    }

    // Extract active work from assistant messages
    if (msg.role === "assistant" && !_isToolResult(msg) && active.length < 3) {
      const content = msg.content.slice(0, 200).replace(/\n/g, " ");
      if (content.length > 20 && !content.startsWith("[")) {
        active.push(content);
      }
    }
  }

  // Build structured summary
  const parts: string[] = [];

  if (previousSummary) {
    parts.push(`## Previous Context\n${previousSummary}`);
  }

  if (goals.length > 0) {
    parts.push(`## Goal\n${goals.map((g) => `- ${g}`).join("\n")}`);
  }

  if (completed.length > 0) {
    parts.push(
      `## Completed\n${completed
        .slice(-5)
        .map((c) => `- ${c}`)
        .join("\n")}`,
    );
  }

  if (active.length > 0) {
    parts.push(`## Active\n${active.map((a) => `- ${a}`).join("\n")}`);
  }

  if (errors.length > 0) {
    parts.push(
      `## Errors\n${errors
        .slice(-3)
        .map((e) => `- ${e}`)
        .join("\n")}`,
    );
  }

  if (files.size > 0) {
    parts.push(
      `## Files\n${[...files]
        .slice(-10)
        .map((f) => `- ${f}`)
        .join("\n")}`,
    );
  }

  return parts.join("\n\n") || "(No context available)";
}

/**
 * Compute the optimal token budget for keeping messages.
 * This balances between keeping enough context and leaving room for:
 * - System prompt (~2-5K tokens)
 * - Model output (~4-8K tokens)
 * - Rolling summary (~1-2K tokens)
 *
 * @param modelContextWindow - Model's total context window
 * @param systemPromptTokens - Estimated tokens in system prompt
 * @param outputReserve - Tokens to reserve for model output
 * @returns Token budget for keeping messages
 */
export function computeKeepBudget(
  modelContextWindow: number,
  systemPromptTokens: number = 4000,
  outputReserve: number = 8000,
): number {
  // Reserve: system prompt + output + rolling summary buffer
  const reserved = systemPromptTokens + outputReserve + 2000;
  // Keep 60% of remaining for messages, compact 40%
  const available = Math.max(0, modelContextWindow - reserved);
  return Math.floor(available * 0.6);
}

/**
 * Check if context needs compaction based on token estimates.
 * This is the proactive check that should run before each LLM call.
 *
 * @param messages - Current conversation messages
 * @param modelContextWindow - Model's context window
 * @param systemPromptTokens - Estimated system prompt tokens
 * @returns Whether compaction is needed and recommended actions
 */
export function checkContextBudget(
  messages: ChatMessage[],
  modelContextWindow: number = 128000,
  systemPromptTokens: number = 4000,
): {
  needsCompaction: boolean;
  pressureRatio: number;
  recommendedAction: "none" | "prune" | "compact" | "deep-compact";
  keepBudget: number;
} {
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );
  const available = modelContextWindow - systemPromptTokens - 8000; // reserve for output
  const pressureRatio = totalTokens / available;
  const keepBudget = computeKeepBudget(modelContextWindow, systemPromptTokens);

  if (pressureRatio < 0.5) {
    return {
      needsCompaction: false,
      pressureRatio,
      recommendedAction: "none",
      keepBudget,
    };
  }

  if (pressureRatio < 0.7) {
    return {
      needsCompaction: true,
      pressureRatio,
      recommendedAction: "prune",
      keepBudget,
    };
  }

  if (pressureRatio < 0.9) {
    return {
      needsCompaction: true,
      pressureRatio,
      recommendedAction: "compact",
      keepBudget,
    };
  }

  return {
    needsCompaction: true,
    pressureRatio,
    recommendedAction: "deep-compact",
    keepBudget,
  };
}
