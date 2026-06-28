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
 */

import type { ChatMessage } from "@dalam/shared-types";

export type ContextPressure = "none" | "low" | "medium" | "high";

// Import shared CTX from memoryTypes to avoid duplication
import { CTX } from "./memoryTypes";

// Re-export for backward compatibility
export { CTX } from "./memoryTypes";

// ContextManager-specific overrides (OUTPUT_RESERVE here is for context pressure
// calculation, not the MiMo budget — keep it small for accurate pressure detection)
const CTX_LOCAL = {
  ...CTX,
  OUTPUT_RESERVE: 4_000,
};

export type ContextStats = {
  totalTokens: number;
  usableTokens: number;
  reservedTokens: number;
  pressure: ContextPressure;
  pressureRatio: number;
  messageCount: number;
  needsCompaction: boolean;
  shouldPrune: boolean;      // tool outputs should be pruned
  nextCheckpointTrigger: number | null; // next unfired trigger threshold (e.g. 0.20), or null if none pending
  shouldCompact: boolean;    // full compaction needed (≥85%)
};

/**
 * Compute the next checkpoint trigger that hasn't fired yet.
 * Caller is responsible for tracking which triggers have fired.
 */
export function getNextCheckpointTrigger(firedUpToPercent: number): number | null {
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
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
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
  // Detect fence on the very first line (line 0) before entering the loop,
  // because the in-loop check only fires after a newline increments lineNum.
  if (fenceLines.has(0)) codeMode = !codeMode;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Track line boundaries for code fence detection
    if (code === 10) { // newline
      lineNum++;
      // Toggle codeMode at line boundaries with triple backtick
      if (fenceLines.has(lineNum)) {
        codeMode = !codeMode;
      }
      count += 1; // newline = 1 token
      continue;
    }


    // Check for triple backtick at start of a line (already tracked via fenceLines)
    // Also handle inline backtick pairs for emphasis (not code blocks)

    // CJK characters — roughly 1.5 chars per token
    if (code >= 0x2e80 && code <= 0x9fff) {
      count += 0.67;
    } else if (code > 0xf900 && code < 0xfaff) {
      count += 0.67;
    }
    // Whitespace — roughly 1 token per space/tab
    else if (code === 32 || code === 9) {
      count += 1;
    }
    // Code identifiers — roughly 3.5 chars per token
    else if (codeMode || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95) {
      count += 0.29;
    }
    // Other characters — roughly 4 chars per token
    else {
      count += 0.25;
    }
  }

  return Math.ceil(count);
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
  maxTokens: number = 128000
): { pressure: ContextPressure; ratio: number } {
  if (maxTokens <= 0) return { pressure: "high", ratio: Infinity };
  const ratio = usedTokens / maxTokens;
  let pressure: ContextPressure = "none";
  if (ratio >= 0.85) pressure = "high";
  else if (ratio >= 0.70) pressure = "medium";
  else if (ratio >= 0.50) pressure = "low";
  return { pressure, ratio };
}

/**
 * Compute full context statistics for a conversation.
 */
export function computeContextStats(
  messages: ChatMessage[],
  maxContextTokens: number = 128000,
  outputReserveTokens: number = CTX_LOCAL.OUTPUT_RESERVE,
  compactionBufferTokens: number = CTX.COMPACTION_BUFFER
): ContextStats {
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
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
    shouldPrune: totalTokens > (usableTokens - CTX.PRUNE_PROTECT),
    nextCheckpointTrigger: getNextCheckpointTrigger(ratio),
    shouldCompact: ratio >= 0.95,
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
export function selectMessagesForCompaction(
  messages: ChatMessage[],
  keepRecent: number = 6
): { toCompact: ChatMessage[]; toKeep: ChatMessage[] } {
  if (messages.length <= keepRecent) {
    return { toCompact: [], toKeep: messages };
  }

  // Identify which messages to protect
  const protectedIndices = new Set<number>();

  // 1. Protect the first user message (establishes context)
  const firstUserIdx = messages.findIndex(m => m.role === "user");
  if (firstUserIdx >= 0) protectedIndices.add(firstUserIdx);

  // 2. Protect the last N user turns (non-tool-result)
  let userTurnCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isToolResult(messages[i])) {
      protectedIndices.add(i);
      userTurnCount++;
    }
    if (userTurnCount >= keepRecent) break;
  }

  // 3. Protect messages with file changes (important for diffs)
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].fileChanges && messages[i].fileChanges!.length > 0) {
      protectedIndices.add(i);
    }
  }

  // 4. Protect messages with todos (important for task tracking)
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].todos && messages[i].todos!.length > 0) {
      protectedIndices.add(i);
    }
  }

  // 5. Protect recent assistant messages (last 3 non-tool messages)
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && !isToolResult(messages[i])) {
      protectedIndices.add(i);
      assistantCount++;
    }
    if (assistantCount >= 3) break;
  }

  // Split into compact and keep
  const toCompact: ChatMessage[] = [];
  const toKeep: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (protectedIndices.has(i)) {
      toKeep.push(messages[i]);
    } else {
      toCompact.push(messages[i]);
    }
  }

  return { toCompact, toKeep };
}

/**
 * Check if a message is a tool result (user message with tool prefix).
 */
function isToolResult(m: ChatMessage): boolean {
  return m.role === "user" && typeof m.content === "string" && (
    m.content.startsWith("[TOOL RESULT:") ||
    m.content.startsWith("[TOOL ERROR:")
  );
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
[What the user asked for / what we're trying to accomplish]

## Key Instructions
[Any specific constraints, preferences, or rules the user specified]

## Discoveries
[Important findings about the codebase, bugs found, architecture decisions]

## Accomplished
[What has been completed so far — file changes, features implemented, etc.]

## Pending
[What still needs to be done]

Keep the summary concise (under 300 words). Focus on actionable facts. Do not include any meta-commentary or intros.`;

export function buildCompactionPrompt(
  messages: ChatMessage[],
  previousSummary?: string
): { role: string; content: string }[] {
  const formatted = messages.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  if (previousSummary) {
    return [
      {
        role: "user",
        content: `[PREVIOUS CONVERSATION SUMMARY]\n${previousSummary}\n\nUpdate this summary by incorporating the new messages below. Use the structured format: Goal, Key Instructions, Discoveries, Accomplished, Pending.`,
      },
      {
        role: "assistant",
        content: "I will merge the previous summary with the new messages to produce an updated, comprehensive summary.",
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
  toolTokenEstimate: (msg: ChatMessage) => number = estimateMessageTokens
): { pruned: ChatMessage[]; tokensReclaimed: number } {
  // Identify which turns to protect (last N user turns that are NOT tool results)
  const realUserTurnIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isToolResult(messages[i])) {
      realUserTurnIndexes.push(i);
    }
    if (realUserTurnIndexes.length >= CTX.TURN_PROTECT) break;
  }
  const protectAfter = realUserTurnIndexes.length > 0 ? Math.min(...realUserTurnIndexes) : 0;

  // Sort tool result messages by size (largest first) for more efficient pruning
  const toolIndicesWithSize: Array<{ idx: number; size: number }> = [];
  let totalPrunableToolTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i < protectAfter && isToolResult(messages[i])) {
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
    if (tokensReclaimed >= CTX.PRUNE_MINIMUM && totalPrunableToolTokens - tokensReclaimed < CTX.PRUNE_PROTECT) {
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

    // Extract tool name from prefix: [TOOL RESULT: toolName] or [TOOL ERROR: toolName]
    const toolMatch = msg.content.match(/^\[TOOL (?:RESULT|ERROR):\s*(\S+)/);
    const toolName = toolMatch?.[1] ?? "unknown";
    const originalTokens = toolTokenEstimate(msg);

    return {
      ...msg,
      content: `[Tool output pruned — ~${originalTokens} tokens reclaimed. Tool: ${toolName}]`,
    };
  });

  return { pruned, tokensReclaimed };
}

// ============================================================================
// Frozen Memory Snapshot (Hermes pattern)
// ============================================================================
// At session start, freeze a snapshot of the memory state so the agent has
// consistent context throughout the session. This prevents the context from
// shifting as new memories are added mid-conversation.

const _frozenSnapshots: Map<string, string[]> = new Map();
/** Maximum number of frozen snapshots to prevent unbounded growth. */
const MAX_FROZEN_SNAPSHOTS = 50;

/**
 * Freeze a memory snapshot for a session.
 * Call this at session start with the initial memory context.
 * The frozen snapshot will be injected into every subsequent context computation.
 * Automatically evicts oldest entries when the cap is exceeded.
 */
export function freezeMemorySnapshot(sessionId: string, memories: string[]): void {
  _frozenSnapshots.set(sessionId, [...memories]);
  // Evict oldest entries if we exceed the cap (Map preserves insertion order)
  while (_frozenSnapshots.size > MAX_FROZEN_SNAPSHOTS) {
    const oldestKey = _frozenSnapshots.keys().next().value;
    if (oldestKey !== undefined) _frozenSnapshots.delete(oldestKey);
    else break;
  }
}

/**
 * Get the frozen memory snapshot for a session.
 * Returns the frozen memories if they exist, or null if no snapshot was frozen.
 */
export function getFrozenSnapshot(sessionId: string): string[] | null {
  return _frozenSnapshots.get(sessionId) ?? null;
}

/**
 * Clear the frozen memory snapshot for a session.
 * Call this when the session ends to free memory.
 */
export function clearFrozenSnapshot(sessionId: string): void {
  _frozenSnapshots.delete(sessionId);
}

/**
 * Build a context prompt with frozen memory included.
 * If a frozen snapshot exists for this session, it's prepended to the memory context.
 * This ensures the agent always has the same baseline memory context regardless
 * of what new memories were added during the conversation.
 */
export function buildContextWithFrozenMemory(
  sessionId: string,
  currentMemories: string[],
  maxTokens: number = CTX.MEMORY_BUDGET
): string[] {
  const frozen = _frozenSnapshots.get(sessionId);
  if (!frozen || frozen.length === 0) return currentMemories;

  // Frozen memories get priority — they're the baseline context
  const frozenText = frozen.join("\n");
  const frozenTokens = Math.ceil(frozenText.length / 4);

  // If frozen memories alone exceed the budget, return only frozen
  if (frozenTokens >= maxTokens) {
    return frozen.slice(0, Math.ceil(maxTokens / 200)); // ~200 tokens per memory
  }

  // Otherwise, fill remaining budget with current memories (excluding duplicates)
  const frozenSet = new Set(frozen);
  const additionalBudget = maxTokens - frozenTokens;
  const additional: string[] = [];
  let additionalTokens = 0;

  for (const mem of currentMemories) {
    if (frozenSet.has(mem)) continue; // Skip duplicates
    const memTokens = Math.ceil(mem.length / 4);
    if (additionalTokens + memTokens > additionalBudget) break;
    additional.push(mem);
    additionalTokens += memTokens;
  }

  return [...frozen, ...additional];
}


