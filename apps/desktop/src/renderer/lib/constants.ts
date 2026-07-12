/**
 * Shared constants for the Dalam codebase.
 * Centralizes magic numbers/strings for maintainability.
 */

// ── Context Window ──────────────────────────────────────────────────────────
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const CONTEXT_RESERVE_OUTPUT = 4_000;
export const CONTEXT_RESERVE_TOOLS = 8_000;
export const CONTEXT_RESERVE_SAFETY = 2_000;

// ── Stream / Network ────────────────────────────────────────────────────────
export const STREAM_TIMEOUT_MS = 30_000;
export const SAFETY_TIMEOUT_MS = 300_000; // 5 minutes — enough for long LLM responses
export const TOOL_APPROVAL_TIMEOUT_MS = 600_000;
export const API_TEST_TIMEOUT_MS = 15_000;
export const LLM_MAX_TOKENS = 1_000;

// ── Terminal ────────────────────────────────────────────────────────────────
export const TERMINAL_SCROLLBACK = 5_000;
export const TERMINAL_MAX_PENDING_DATA = 100_000;
export const TERMINAL_TRIM_SIZE = 50_000;

// ── Diff ────────────────────────────────────────────────────────────────────
export const MAX_DIFF_DISTANCE = 10_000;
export const MAX_LINES_FOR_DIFF = 50_000;

// ── Tool Execution ──────────────────────────────────────────────────────────
export const MAX_TOOL_RESULT_LENGTH = 100_000;

// ── Store ───────────────────────────────────────────────────────────────────
export const MAX_BUFFER_SIZE = 200_000;
export const QUERY_TIMEOUT_MS = 30_000;

// ── Skills / Genes ──────────────────────────────────────────────────────────
export const MAX_SKILL_BODY_LENGTH = 10_000;
export const GENE_STALE_MS = 30 * 24 * 60 * 60 * 1000;

// ── Code Index ──────────────────────────────────────────────────────────────
export const MAX_INDEX_FILES = 5_000;

// ── Security ────────────────────────────────────────────────────────────────
export const MAX_AUDIT_ENTRIES = 1_000;

// ── Dream Agent ─────────────────────────────────────────────────────────────
export const STALE_MEMORY_DAYS_MS = 30 * 86_400_000;
export const MIN_DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── API Versions ────────────────────────────────────────────────────────────
export const ANTHROPIC_API_VERSION = "2023-06-01";

// ── Default Context Window String (for settings UI) ─────────────────────────
export const DEFAULT_CONTEXT_WINDOW_STRING = "200000";
