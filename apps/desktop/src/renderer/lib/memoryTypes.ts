/**
 * ============================================================
 * ACODE MEMORY & CONTEXT TYPES
 * ============================================================
 *
 * Unified type system for the memory management layer.
 * Extends ChatMessage from @acode/shared-types — NO duplicate types.
 *
 * Research basis:
 * - MiMo-Code: tiered importance, budgeted injection (~65K)
 * - OpenCode: compaction.ts patterns, SUMMARY_TEMPLATE
 * - Claude Code: MEMORY.md pointer index (≤200 lines)
 * - claude-mem: 5 lifecycle hooks
 * - memsearch: L1/L2/L3 staged retrieval
 * ============================================================
 */

import type { ChatMessage } from "@acode/shared-types";

// ─── Memory categories (Claude Code Auto Memory pattern) ───
export type MemoryCategory =
  | "user"        // preferences, role, style
  | "feedback"    // corrections received
  | "project"     // architecture decisions, stack, rules
  | "reference"   // file paths, links, external resources
  | "task"        // current & past task summaries
  | "decision";   // explicit key decisions with rationale

// ─── Memory importance tiers (MiMo budgeted injection) ───
export type MemoryTier = "critical" | "high" | "medium" | "low";

// ─── Memory entry — single unit of persistent knowledge ───
export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  tier: MemoryTier;
  content: string;
  summary: string;          // ≤150 chars pointer line
  tags: string[];
  sourceSession?: string;
  sourceFile?: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  verified: boolean;
  stale: boolean;
}

// ─── Checkpoint data — session snapshot at context thresholds ───
export interface CheckpointData {
  id: string;
  sessionId: string;
  sequenceNumber: number;
  createdAt: number;
  goal: string;
  completedSteps: string[];
  pendingSteps: string[];
  failedSteps: string[];
  keyDecisions: string[];
  knownIssues: string[];
  filesModified: string[];
  toolCallSummary: string;
  tokenCountAtCheckpoint: number;
  content: string;          // full markdown checkpoint text
}

// ─── Context window budget constants (derived from OpenCode/MiMo) ───
export const CTX = {
  COMPACTION_BUFFER:   20_000,  // safety headroom before triggering compaction
  OUTPUT_RESERVE:      32_000,  // tokens to reserve for model output
  PRUNE_PROTECT:       40_000,  // min tool output before pruning starts
  PRUNE_MINIMUM:       20_000,  // min tokens to reclaim, else skip prune
  TURN_PROTECT:             2,  // never prune the last N user turns
  REBUILD_BUDGET:      65_000,  // MiMo: total injected content on rebuild
  CHECKPOINT_TRIGGERS: [0.20, 0.45, 0.70] as const,
  CHECKPOINT_HARD:          0.85, // hard overflow: force compaction
  MEMORY_INDEX_MAX_LINES: 200,   // Claude Code MEMORY.md cap
  MEMORY_SEARCH_LIMIT:     20,   // max results per search
  MEMORY_BUDGET:           500,   // max active memories before auto-prune
  MEMORY_STALE_DAYS:       30,    // days before low/medium memories go stale
  MEMORY_MAINTAIN_INTERVAL: 10,   // run maintenance every N sessions
  DREAM_MIN_HOURS:         24,   // at least 24h since last dream
  DREAM_MIN_SESSIONS:       5,   // at least 5 new sessions
  DREAM_CYCLE_DAYS:         7,   // weekly consolidation
} as const;

// ─── Context window status ───
export interface ContextWindow {
  usable: number;
  used: number;
  percentUsed: number;
  shouldPrune: boolean;
  shouldCheckpoint: boolean;
  shouldCompact: boolean;
}

// ─── Injected context for session resume ───
export interface InjectedContext {
  checkpoint: string;
  projectMemory: string;
  taskProgress: string;
  scratchNotes: string;
  recentMessages: string;
  totalTokens: number;
}

// ─── Memory search result ───
export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// ─── Dream agent report ───
export interface DreamReport {
  startedAt: number;
  completedAt?: number;
  deduplicated: number;
  merged: number;
  validated: number;
  invalidated: number;
  compressed: number;
  finalEntries: number;
}

// ─── Extended ChatMessage with memory fields ───
// Uses type intersection, not a new type — preserves ChatMessage compatibility
export type MemoryChatMessage = ChatMessage & {
  isPruned?: boolean;
  isCompactionSummary?: boolean;
  tokenCount?: number;
};
