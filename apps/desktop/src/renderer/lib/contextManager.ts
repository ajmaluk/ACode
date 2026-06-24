/**
 * ACode Context Manager
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

import type { ChatMessage, AppSettings } from "@acode/shared-types";

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
 * Estimate token count from a string. Uses a simple heuristic:
 * ~4 chars per token for English, ~2 chars per token for CJK.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK characters are roughly 2 chars per token
    if (code > 0x2e80 && code < 0x9fff) {
      count += 0.5;
    } else if (code > 0xf900 && code < 0xfaff) {
      count += 0.5;
    } else {
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
    shouldCompact: ratio >= CTX.CHECKPOINT_HARD,
  };
}

/**
 * Select messages to compact. Keeps recent messages intact,
 * returns older messages for summarization.
 *
 * Strategy: Keep the last `keepRecent` messages untouched.
 * Everything before that is a candidate for compaction.
 */
export function selectMessagesForCompaction(
  messages: ChatMessage[],
  keepRecent: number = 6
): { toCompact: ChatMessage[]; toKeep: ChatMessage[] } {
  if (messages.length <= keepRecent) {
    return { toCompact: [], toKeep: messages };
  }
  return {
    toCompact: messages.slice(0, -keepRecent),
    toKeep: messages.slice(-keepRecent),
  };
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
 * In ACode's architecture, tool results come back as user messages with
 * `[TOOL RESULT: ...]` or `[TOOL ERROR: ...]` prefixes (from acodeAPI.ts).
 * This function identifies those messages and prunes their content to
 * reclaim tokens, while protecting the last N user turns.
 *
 * Returns pruned messages and tokens reclaimed.
 */
export function pruneToolOutputs(
  messages: ChatMessage[],
  toolTokenEstimate: (msg: ChatMessage) => number = estimateMessageTokens
): { pruned: ChatMessage[]; tokensReclaimed: number } {
  // In ACode, tool results are user messages with tool result prefixes
  const isToolResult = (m: ChatMessage) =>
    m.role === "user" && (
      m.content.startsWith("[TOOL RESULT:") ||
      m.content.startsWith("[TOOL ERROR:")
    );

  const toolMessages = messages.filter(isToolResult);
  const totalToolTokens = toolMessages.reduce((s, m) => s + toolTokenEstimate(m), 0);

  if (totalToolTokens < CTX.PRUNE_PROTECT) {
    return { pruned: messages, tokensReclaimed: 0 };
  }

  // Identify which turns to protect (last N user turns that are NOT tool results)
  const realUserTurnIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isToolResult(messages[i])) {
      realUserTurnIndexes.push(i);
    }
    if (realUserTurnIndexes.length >= CTX.TURN_PROTECT) break;
  }
  const protectAfter = realUserTurnIndexes.length > 0 ? Math.min(...realUserTurnIndexes) : 0;

  let tokensReclaimed = 0;
  const pruned = messages.map((msg, idx) => {
    // Protect recent turns, non-tool-result messages, already-pruned messages
    if (idx >= protectAfter || !isToolResult(msg)) return msg;

    if (tokensReclaimed >= CTX.PRUNE_MINIMUM && totalToolTokens - tokensReclaimed < CTX.PRUNE_PROTECT) {
      return msg; // enough reclaimed
    }

    const reclaimed = toolTokenEstimate(msg);
    tokensReclaimed += reclaimed;

    // Extract tool name from prefix: [TOOL RESULT: toolName] or [TOOL ERROR: toolName]
    const toolMatch = msg.content.match(/^\[TOOL (?:RESULT|ERROR):\s*(\S+)/);
    const toolName = toolMatch?.[1] ?? "unknown";

    return {
      ...msg,
      content: `[Tool output pruned — ~${reclaimed} tokens reclaimed. Tool: ${toolName}]`,
    };
  });

  return { pruned, tokensReclaimed };
}

/**
 * Workspace memory structure.
 */
export type WorkspaceMemory = {
  projectOverview: string;
  keyFiles: string[];
  buildCommands: string[];
  learnedRules: string[];
  lastUpdated: number;
};

/**
 * Default workspace memory.
 */
export function createDefaultMemory(): WorkspaceMemory {
  return {
    projectOverview: "An AI-native developer desktop environment.",
    keyFiles: [],
    buildCommands: ["npm run dev", "npm run build"],
    learnedRules: [
      "Always run build checks before declaring a task complete.",
      "Maintain typescript type safety.",
    ],
    lastUpdated: Date.now(),
  };
}

/**
 * Merge a learned rule into workspace memory, avoiding duplicates.
 */
export function addLearnedRule(memory: WorkspaceMemory, rule: string): WorkspaceMemory {
  const trimmed = rule.trim();
  if (!trimmed || memory.learnedRules.includes(trimmed)) {
    return memory;
  }
  return {
    ...memory,
    learnedRules: [...memory.learnedRules, trimmed],
    lastUpdated: Date.now(),
  };
}

/**
 * Format workspace memory for system prompt injection.
 */
export function formatMemoryForPrompt(memory: WorkspaceMemory): string {
  return [
    "\n\n=== PERSISTENT WORKSPACE MEMORY ===",
    `Project Overview: ${memory.projectOverview}`,
    `Key Files: ${memory.keyFiles.length > 0 ? memory.keyFiles.join(", ") : "None specified"}`,
    `Build Commands: ${memory.buildCommands.join(", ")}`,
    "Learned Rules:",
    ...memory.learnedRules.map((r) => `  - ${r}`),
    `Last Updated: ${new Date(memory.lastUpdated).toISOString()}`,
    "===================================",
  ].join("\n");
}

