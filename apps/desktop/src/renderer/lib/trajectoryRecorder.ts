/**
 * ============================================================
 * DALAM TRAJECTORY RECORDER — Hermes-Style JSONL Persistence
 * ============================================================
 *
 * Records full conversation trajectories as JSONL (JSON Lines)
 * for post-hoc analysis, fine-tuning datasets, and auditing.
 *
 * Inspired by Hermes Agent's trajectory_samples.jsonl format:
 * - Each line is a self-contained JSON object
 * - ShareGPT-style conversation format for compatibility
 * - Selective field stripping to minimize storage bloat
 * - Automatic file rotation per session
 *
 * Storage: <workspace>/.dalam/trajectories/trajectory-<sessionId>.jsonl
 * ============================================================
 */

import { createDalamAPI } from "./dalamAPI";
import { joinPath } from "./pathUtils";

// ─── Types ─────────────────────────────────────────────────

/** A single conversation turn in the trajectory */
export interface TrajectoryTurn {
  from: "human" | "gpt" | "system" | "tool";
  value: string;
  /** Timestamp of this turn */
  ts: number;
  /** Token count estimate (if available) */
  tokens?: number;
  /** Tool calls associated with this turn (for gpt turns) */
  tool_calls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
  }>;
}

/** A single line in the JSONL trajectory file */
export interface TrajectoryRecord {
  /** ShareGPT-style conversation array */
  conversations: TrajectoryTurn[];
  /** ISO 8601 timestamp of the save event */
  timestamp: string;
  /** Model used during the session */
  model: string;
  /** Agent name (build, plan, yolo) */
  agent: string;
  /** Whether the trajectory completed successfully */
  completed: boolean;
  /** Session metadata */
  session: {
    id: string;
    workspacePath: string;
    startedAt: number;
    messageCount: number;
  };
  /** Performance metadata */
  meta?: {
    totalTokens?: number;
    toolCallCount?: number;
    compactionCount?: number;
    doomLoopWarnings?: number;
  };
}

/** Internal buffer for accumulating turns before flushing */
interface TrajectoryBuffer {
  turns: TrajectoryTurn[];
  lastFlush: number;
  workspacePath: string;
  /** Cached accumulated file content to avoid O(n²) re-reads on each flush */
  _appendedContent?: string;
}

// ─── Module State ──────────────────────────────────────────

const buffers: Map<string, TrajectoryBuffer> = new Map();
const flushing = new Set<string>(); // Per-session flush mutex
const TRAJECTORY_DIR = "trajectories";
const FLUSH_INTERVAL_MS = 5_000; // Flush every 5 seconds
const MAX_BUFFER_SIZE = 50; // Flush after 50 turns

let flushTimer: ReturnType<typeof setInterval> | null = null;
let recordingDisabled = false; // Set to true if .dalam dir can't be created

// ─── Core Functions ────────────────────────────────────────

/**
 * Start recording a trajectory for a session.
 * Creates the JSONL file and begins buffering turns.
 */
export async function startRecording(
  sessionId: string,
  workspacePath: string,
): Promise<void> {
  if (buffers.has(sessionId)) return; // Already recording

  buffers.set(sessionId, { turns: [], lastFlush: Date.now(), workspacePath });
  if (import.meta.env.DEV)
    console.log("Trajectory", `Started recording session ${sessionId}`, {
      workspacePath,
    });

  // Ensure trajectory directory exists — create .dalam first, then trajectories
  try {
    const { scopeSafeExists, scopeSafeMkdir } = await import("./dalamAPI");
    const dalamDir = joinPath(workspacePath, ".dalam");
    const trajDir = joinPath(dalamDir, TRAJECTORY_DIR);
    if (!(await scopeSafeExists(dalamDir))) {
      const created = await scopeSafeMkdir(dalamDir, { recursive: true });
      if (!created) {
        recordingDisabled = true;
        return;
      }
    }
    if (!(await scopeSafeExists(trajDir))) {
      const created = await scopeSafeMkdir(trajDir, { recursive: true });
      if (!created) {
        recordingDisabled = true;
        return;
      }
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      recordingDisabled = true;
      return; // Don't start flush timer if we can't write
    } else {
      console.warn("Trajectory", "Failed to create trajectory directory", {
        error: String(e),
      });
    }
  }

  if (recordingDisabled) return;

  // Start flush timer if not running
  if (!flushTimer) {
    flushTimer = setInterval(() => void flushAll(), FLUSH_INTERVAL_MS);
  }
}

/**
 * Stop recording and flush remaining turns for a session.
 */
export async function stopRecording(sessionId: string): Promise<void> {
  try {
    const buffer = buffers.get(sessionId);
    if (!buffer) return;

    // Flush remaining turns
    await flushBuffer(sessionId);

    // Only delete the buffer if there are no remaining unsent turns.
    // If flushBuffer failed, turns were restored to the buffer — keep them
    // for a future retry rather than silently dropping them.
    const afterFlush = buffers.get(sessionId);
    if (!afterFlush || afterFlush.turns.length === 0) {
      buffers.delete(sessionId);
    } else {
      console.warn(
        "Trajectory",
        `Session ${sessionId} has ${afterFlush.turns.length} unsent turns after stopRecording — keeping buffer for retry`,
      );
    }

    if (import.meta.env.DEV)
      console.log("Trajectory", `Stopped recording session ${sessionId}`);

    // Stop timer if no more sessions
    if (buffers.size === 0 && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  } catch (err) {
    if (import.meta.env.DEV)
      console.warn("[Trajectory] Error stopping recording:", err);
  }
}

/**
 * Record a conversation turn in the trajectory.
 * This is the main entry point called from the store.
 */
export function recordTurn(sessionId: string, turn: TrajectoryTurn): void {
  const buffer = buffers.get(sessionId);
  if (!buffer) return; // Not recording

  buffer.turns.push(turn);

  // Auto-flush if buffer is getting large
  if (buffer.turns.length >= MAX_BUFFER_SIZE) {
    void flushBuffer(sessionId);
  }
}

/**
 * Record a user message.
 */
export function recordUserMessage(
  sessionId: string,
  content: string,
  tokens?: number,
): void {
  recordTurn(sessionId, {
    from: "human",
    value: content,
    ts: Date.now(),
    tokens,
  });
}

/**
 * Record an assistant message.
 */
export function recordAssistantMessage(
  sessionId: string,
  content: string,
  tokens?: number,
  toolCalls?: TrajectoryTurn["tool_calls"],
): void {
  recordTurn(sessionId, {
    from: "gpt",
    value: content,
    ts: Date.now(),
    tokens,
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });
}

/**
 * Record a system message.
 */
export function recordSystemMessage(sessionId: string, content: string): void {
  recordTurn(sessionId, {
    from: "system",
    value: content,
    ts: Date.now(),
  });
}

/**
 * Record a tool result.
 */
export function recordToolResult(
  sessionId: string,
  toolName: string,
  result: string,
  truncated = false,
): void {
  // Strip large results to avoid storage bloat (like Hermes)
  const maxValue = truncated ? result.slice(0, 500) : result;
  recordTurn(sessionId, {
    from: "tool",
    value: `[${toolName}] ${maxValue}`,
    ts: Date.now(),
  });
}

// ─── Flush Logic ───────────────────────────────────────────

/**
 * Flush all buffered trajectories to disk.
 */
async function flushAll(): Promise<void> {
  const sessionIds = Array.from(buffers.keys());
  await Promise.all(sessionIds.map((id) => flushBuffer(id)));
}

/**
 * Flush a single session's buffer to the JSONL file.
 */
async function flushBuffer(sessionId: string): Promise<void> {
  if (recordingDisabled) return;
  const buffer = buffers.get(sessionId);
  if (!buffer || buffer.turns.length === 0) return;
  // Per-session flush mutex: skip if already flushing
  if (flushing.has(sessionId)) return;
  flushing.add(sessionId);

  const turns = [...buffer.turns];
  // Clear buffer after snapshot to avoid data loss on concurrent writes.
  // New turns arriving during the async write will accumulate and be flushed next time.
  buffer.turns = [];
  buffer.lastFlush = Date.now();

  try {
    // Use the workspace path stored when recording started
    const workspacePath = buffer.workspacePath;

    if (!workspacePath) {
      console.warn("Trajectory", "No workspace path, cannot flush", {
        sessionId,
      });
      // Restore turns so they aren't lost
      buffer.turns = [...turns, ...buffer.turns];
      return;
    }

    const api = createDalamAPI();
    const trajDir = joinPath(workspacePath, ".dalam", TRAJECTORY_DIR);
    const filePath = joinPath(trajDir, `trajectory-${sessionId}.jsonl`);

    // Ensure directory exists before writing
    try {
      const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
      const dalamDir = joinPath(workspacePath, ".dalam");
      if (!(await exists(dalamDir))) {
        await mkdir(dalamDir, { recursive: true });
      }
      if (!(await exists(trajDir))) {
        await mkdir(trajDir, { recursive: true });
      }
    } catch (err) {
      console.warn("[Trajectory] Flush error:", err);
      // Directory creation failed — trajectory recording is best-effort
    }

    // Build the JSONL line
    const record: TrajectoryRecord = {
      conversations: turns,
      timestamp: new Date().toISOString(),
      model: "", // Will be set from store context
      agent: "", // Will be set from store context
      completed: false,
      session: {
        id: sessionId,
        workspacePath,
        startedAt: turns[0]?.ts ?? Date.now(),
        messageCount: turns.length,
      },
    };

    // Try to enrich with store metadata
    try {
      const { useChat } = await import("@/store/useAppStore");
      const chatState = useChat.getState();
      const session = chatState.chatSessions.find((s) => s.id === sessionId);
      if (session) {
        record.model = session.model ?? "";
        record.agent = session.agentName ?? "";
        record.completed = session.status === "completed";
        record.session.messageCount = session.messageCount;
      }
      record.meta = {
        doomLoopWarnings: chatState.doomLoopWarningCount,
      };
    } catch (err) {
      console.warn("[Trajectory] Flush error:", err);
      // Store not available, use defaults
    }

    const jsonLine = JSON.stringify(record) + "\n";

    // Append-only write: track cumulative content per session to avoid
    // O(n²) read-modify-write pattern. Each flush appends only the new
    // turns since the last flush, keeping file I/O linear.
    let writeSucceeded = false;
    try {
      // Seed the cache on the first flush by reading existing file content
      if (!buffer._appendedContent) {
        try {
          const existing = await api.fs.readFile(filePath);
          buffer._appendedContent = existing;
        } catch (err) {
          console.warn("[Trajectory] Flush error:", err);
          // File doesn't exist yet — start fresh
          buffer._appendedContent = "";
        }
      }
      const fullContent = buffer._appendedContent + jsonLine;
      await api.fs.writeFile(filePath, fullContent);
      // Only update cache AFTER successful write to prevent duplicates on retry
      buffer._appendedContent = fullContent;
      writeSucceeded = true;
    } catch (e) {
      if (import.meta.env.DEV)
        console.error("Trajectory", "Failed to write trajectory", {
          sessionId,
          error: String(e),
        });
    }

    if (!writeSucceeded) {
      // Restore turns to buffer so they can be retried on next flush.
      // Also clear the cached content so the next flush re-reads from disk
      // instead of writing stale cached content.
      const buf = buffers.get(sessionId);
      if (buf) {
        buf.turns = [...turns, ...buf.turns];
        buf._appendedContent = undefined;
      }
    }
    console.debug(
      "Trajectory",
      `Flushed ${turns.length} turns for session ${sessionId}`,
    );
  } finally {
    flushing.delete(sessionId);
  }
}

// ─── Export/Read Functions ─────────────────────────────────

/**
 * Read all trajectories for a workspace.
 */
export async function readTrajectories(
  workspacePath: string,
): Promise<TrajectoryRecord[]> {
  try {
    const { exists, readTextFile, readDir } =
      await import("@tauri-apps/plugin-fs");
    const trajDir = joinPath(workspacePath, ".dalam", TRAJECTORY_DIR);

    if (!(await exists(trajDir))) return [];

    const entries = await readDir(trajDir);
    const records: TrajectoryRecord[] = [];

    for (const entry of entries) {
      if (!entry.name?.endsWith(".jsonl")) continue;

      const filePath = joinPath(trajDir, entry.name);
      const content = await readTextFile(filePath);

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch (err) {
          console.warn("[Trajectory] Flush error:", err);
          // Skip malformed lines
        }
      }
    }

    return records.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  } catch (e) {
    console.warn("Trajectory", "Failed to read trajectories", {
      error: String(e),
    });
    return [];
  }
}

/**
 * Export trajectories as a downloadable JSONL file.
 */
export async function exportTrajectories(
  workspacePath: string,
  filename?: string,
): Promise<string | null> {
  try {
    const records = await readTrajectories(workspacePath);
    if (records.length === 0) return null;

    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const blob = new Blob([content], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename ?? `dalam-trajectories-${Date.now()}.jsonl`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Delay revocation to ensure the download has started reading the blob
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    if (import.meta.env.DEV)
      console.log(
        "Trajectory",
        `Exported ${records.length} trajectory records`,
      );
    return link.download;
  } catch (e) {
    if (import.meta.env.DEV)
      console.error("Trajectory", "Export failed", { error: String(e) });
    return null;
  }
}

/**
 * Get trajectory statistics for a workspace.
 */
export async function getTrajectoryStats(workspacePath: string): Promise<{
  totalSessions: number;
  totalTurns: number;
  completedSessions: number;
  models: Record<string, number>;
}> {
  const records = await readTrajectories(workspacePath);
  const models: Record<string, number> = {};

  let totalTurns = 0;
  let completedSessions = 0;

  for (const r of records) {
    totalTurns += r.conversations.length;
    if (r.completed) completedSessions++;
    if (r.model) {
      models[r.model] = (models[r.model] ?? 0) + 1;
    }
  }

  return {
    totalSessions: records.length,
    totalTurns,
    completedSessions,
    models,
  };
}

// Clean up flush timer on page unload to prevent background writes during shutdown.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // Synchronous best-effort: persist any remaining buffered turns
    for (const [sessionId, buffer] of buffers) {
      if (
        buffer.turns.length > 0 &&
        buffer.workspacePath &&
        !flushing.has(sessionId)
      ) {
        const api = createDalamAPI();
        const filePath = joinPath(
          buffer.workspacePath,
          ".dalam",
          TRAJECTORY_DIR,
          `trajectory-${sessionId}.jsonl`,
        );
        const newLines =
          buffer.turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
        // Read existing + append new, fire-and-forget
        api.fs
          .readFile(filePath)
          .then((existing) => {
            return api.fs.writeFile(filePath, existing + newLines);
          })
          .catch((_err) => {
            // File may not exist yet — try write-only
            api.fs.writeFile(filePath, newLines).catch((writeErr) => {
              console.warn(
                "[trajectory] Failed to flush trajectory on unload:",
                writeErr,
              );
            });
          });
        buffer.turns = [];
      }
    }
  });
}
