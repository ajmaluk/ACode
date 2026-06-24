/**
 * ACode Context Manager
 *
 * Manages context window pressure, automatic compaction,
 * and workspace memory. Inspired by MiMo-Code's overflow
 * detection and compaction system.
 */

import type { ChatMessage, AppSettings } from "@acode/shared-types";

// Token estimation: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

export type ContextPressure = "none" | "low" | "medium" | "high";

export type ContextStats = {
  totalTokens: number;
  usableTokens: number;
  reservedTokens: number;
  pressure: ContextPressure;
  pressureRatio: number;
  messageCount: number;
  needsCompaction: boolean;
};

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
  outputReserveTokens: number = 4096,
  compactionBufferTokens: number = 20000
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
    needsCompaction: pressure === "high" || pressure === "medium",
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
        content: `[PREVIOUS SUMMARY]\n${previousSummary}\n\nUpdate this summary with the new messages below. Keep it under 200 words.`,
      },
      {
        role: "assistant",
        content: "I will merge the previous summary with the new messages.",
      },
      ...formatted,
    ];
  }

  return [
    {
      role: "user",
      content: `Summarize this conversation history concisely. Focus on:\n1. What was achieved\n2. Key decisions\n3. Current state\nKeep under 200 words.`,
    },
    ...formatted,
  ];
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

/**
 * Context window budget calculator.
 * Determines how many tokens we can safely use for messages
 * given the model's context window and output requirements.
 */
export function computeBudget(maxContextWindow: number): {
  maxInputTokens: number;
  outputReserve: number;
  compactionBuffer: number;
  safeZone: number;
} {
  const outputReserve = 4096; // Reserve for model output
  const compactionBuffer = 20000; // Buffer for compaction summarization
  const safeZone = maxContextWindow - outputReserve - compactionBuffer;
  return {
    maxInputTokens: safeZone,
    outputReserve,
    compactionBuffer,
    safeZone,
  };
}
