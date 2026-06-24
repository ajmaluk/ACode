/**
 * ACode Hook Listeners — Example lifecycle event handlers.
 *
 * These demonstrate how to use the hookBus for common patterns:
 *   1. Tool usage stats logging (PostToolUse)
 *   2. Auto-save workspace memory on SessionEnd
 *   3. Prompt analytics on UserPromptSubmit
 *   4. Session lifecycle tracking (SessionStart/Stop)
 *
 * Register these at app startup (e.g. in App.tsx useEffect or a dedicated init file).
 * Each handler is independent — remove any you don't need.
 *
 * Usage:
 *   import { registerHookListeners } from "./hookListeners";
 *   registerHookListeners(); // call once at startup
 */

import { hookBus } from "./hookBus";
import type {
  SessionStartEvent,
  UserPromptSubmitEvent,
  PostToolUseEvent,
  StopEvent,
  SessionEndEvent,
} from "./hookBus";
import { CTX } from "./memoryTypes";

// ─── In-memory stats for the current session ───

interface ToolStats {
  calls: number;
  errors: number;
  totalDurationMs: number;
  byTool: Record<string, { calls: number; errors: number; totalMs: number }>;
}

const sessionStats = new Map<string, ToolStats>();
let maintenanceCounter = 0;

function getOrCreateStats(sessionId: string): ToolStats {
  if (!sessionStats.has(sessionId)) {
    sessionStats.set(sessionId, {
      calls: 0,
      errors: 0,
      totalDurationMs: 0,
      byTool: {},
    });
  }
  return sessionStats.get(sessionId)!;
}

// ─── 1. Tool Usage Stats (PostToolUse) ───
/**
 * Tracks tool call counts, error rates, and per-tool timing.
 * Logs a summary to console after each tool call.
 */
function onPostToolUse(event: PostToolUseEvent): void {
  const stats = getOrCreateStats(event.sessionId);
  stats.calls++;
  stats.totalDurationMs += event.durationMs;

  if (event.error) {
    stats.errors++;
  }

  // Per-tool breakdown
  if (!stats.byTool[event.toolName]) {
    stats.byTool[event.toolName] = { calls: 0, errors: 0, totalMs: 0 };
  }
  const toolStats = stats.byTool[event.toolName];
  toolStats.calls++;
  toolStats.totalMs += event.durationMs;
  if (event.error) toolStats.errors++;

  // Log individual tool usage
  const durationStr = event.durationMs > 1000
    ? `${(event.durationMs / 1000).toFixed(1)}s`
    : `${event.durationMs}ms`;

  if (event.error) {
    console.log(
      `[ToolStats] ✗ ${event.toolName} failed (${durationStr}):`,
      event.error.slice(0, 100)
    );
  } else {
    console.log(
      `[ToolStats] ✓ ${event.toolName} (${durationStr})`
    );
  }
}

// ─── 2. Auto-Save Context on SessionEnd ───
/**
 * When a session ends (completed or aborted), persists a context snapshot
 * so the next session can resume with knowledge of what happened.
 *
 * This writes a lightweight JSON summary to .acode/session-history.json
 * that can be read on the next SessionStart.
 */
async function onSessionEnd(event: SessionEndEvent): Promise<void> {
  const stats = sessionStats.get(event.sessionId);
  const durationSec = event.durationMs / 1000;

  // Log session summary
  console.log(
    `[SessionEnd] ${event.sessionId} (${event.reason}) — ` +
    `${event.messageCount} messages, ${durationSec.toFixed(1)}s`
  );

  if (stats) {
    const toolSummary = Object.entries(stats.byTool)
      .map(([name, s]) => `${name}×${s.calls}${s.errors > 0 ? `(${s.errors}err)` : ""}`)
      .join(", ");

    console.log(
      `[SessionEnd] Tools: ${stats.calls} total, ${stats.errors} errors — ${toolSummary || "none"}`
    );

    // Persist session summary for next session's context
    try {
      const { useWorkspace } = await import("../store/useAppStore");
      const workspace = useWorkspace.getState().workspaces.find(
        (w) => w.id === useWorkspace.getState().activeWorkspaceId
      );
      if (workspace) {
        const api = (await import("./acodeAPI")).ensureAcodeAPI();
        const summaryPath = `${workspace.path}/.acode/session-history.json`;
        const { exists } = await import("@tauri-apps/plugin-fs");

        let history: Array<{
          sessionId: string;
          endedAt: number;
          reason: string;
          messageCount: number;
          durationMs: number;
          toolCalls: number;
          toolErrors: number;
        }> = [];

        if (await exists(summaryPath)) {
          try {
            const raw = await api.fs.readFile(summaryPath);
            history = JSON.parse(raw);
          } catch { /* start fresh */ }
        }

        history.push({
          sessionId: event.sessionId,
          endedAt: event.timestamp,
          reason: event.reason,
          messageCount: event.messageCount,
          durationMs: event.durationMs,
          toolCalls: stats.calls,
          toolErrors: stats.errors,
        });

        // Keep only last 50 sessions
        history = history.slice(-50);
        await api.fs.writeFile(summaryPath, JSON.stringify(history, null, 2));
      }
    } catch (e) {
      console.warn("[HookListener] Failed to persist session summary:", e);
    }

    // Clean up stats
    sessionStats.delete(event.sessionId);
  }

  // ── Auto-extract memories from the last exchange ──
  try {
    const { useChat, useWorkspace } = await import("../store/useAppStore");
    const { extractMemoriesFromExchange, saveMemory } = await import("./memoryStore");

    const sessionMessages = useChat.getState().sessionMessages[event.sessionId];
    if (!sessionMessages || sessionMessages.length < 2) return;

    // Find the last user message (reverse scan for ES2023 compat)
    let lastUserIdx = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;

    // Find the assistant message after the last user message (the response)
    let assistantIdx = -1;
    for (let i = lastUserIdx + 1; i < sessionMessages.length; i++) {
      if (sessionMessages[i].role === "assistant") { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return;

    const userInput = sessionMessages[lastUserIdx].content;
    const assistantResponse = sessionMessages[assistantIdx].content;

    // Only extract from substantial exchanges (>200 chars combined)
    if (userInput.length + assistantResponse.length < 200) return;

    const entries = extractMemoriesFromExchange(userInput, assistantResponse, {
      sessionId: event.sessionId,
      maxEntries: 3,
    });

    if (entries.length === 0) return;

    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (!workspace) return;

    let saved = 0;
    for (const entry of entries) {
      try {
        const result = await saveMemory(entry, workspace.path);
        if (result.action === "add" || result.action === "update") saved++;
      } catch {
        // Silently skip individual failures
      }
    }

    if (saved > 0) {
      console.log(`[HookListener] Auto-extracted ${saved} memory(ies) from session ${event.sessionId}`);
    }
  } catch (e) {
    console.warn("[HookListener] Failed to auto-extract memories:", e);
  }

  // ── Periodic self-maintaining memory cleanup ──
  maintenanceCounter++;
  if (maintenanceCounter >= CTX.MEMORY_MAINTAIN_INTERVAL) {
    maintenanceCounter = 0;
    try {
      const { runMaintenance } = await import("./memoryStore");
      const result = await runMaintenance();
      const total = result.staleDetected + result.pruned + result.purged;
      if (total > 0) {
        console.log(
          `[HookListener] Memory maintenance: ${result.staleDetected} stale, ` +
          `${result.pruned} pruned, ${result.purged} purged`
        );
      }
    } catch (e) {
      console.warn("[HookListener] Memory maintenance failed:", e);
    }
  }

  // ── Auto-crystallize skill from session ──
  try {
    const { useWorkspace } = await import("../store/useAppStore");
    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (workspace) {
      const { proposeSkillFromSession } = await import("./skillCrystallizer");
      // Asynchronously trigger proposal check without blocking SessionEnd execution
      proposeSkillFromSession(event.sessionId, workspace.path).catch((err) => {
        console.warn("[HookListener] Background skill crystallization failed:", err);
      });
    }
  } catch (e) {
    console.warn("[HookListener] Failed to assess session for skill crystallization:", e);
  }
}

// ─── 3. Prompt Analytics (UserPromptSubmit) ───
/**
 * Logs basic analytics about each user prompt:
 * - prompt length (chars + estimated tokens)
 * - whether attachments are present
 * - agent name and conversation history size
 *
 * Useful for understanding usage patterns without invasive telemetry.
 */
function onUserPromptSubmit(event: UserPromptSubmitEvent): void {
  const promptChars = event.prompt.length;
  const estimatedTokens = Math.ceil(promptChars / 4);
  const hasAttachments = event.attachments.length > 0;
  const historySize = event.conversationHistory.length;

  console.log(
    `[PromptAnalytics] user → ${event.agentName} | ` +
    `${promptChars} chars (~${estimatedTokens} tokens) | ` +
    `history: ${historySize} msgs` +
    (hasAttachments ? ` | ${event.attachments.length} attachment(s)` : "")
  );
}

// ─── 4. Session Start Tracking (SessionStart) ───
/**
 * Logs when a new session begins with context about the workspace and model.
 */
function onSessionStart(event: SessionStartEvent): void {
  console.log(
    `[SessionStart] ${event.sessionId} | ` +
    `model: ${event.model} | agent: ${event.agentName} | ` +
    `mode: ${event.mode} | workspace: ${event.workspacePath}`
  );
}

// ─── 5. Stop Event (Turn Complete) ───
/**
 * Logs when an LLM turn completes, with tool call counts.
 */
function onStop(event: StopEvent): void {
  console.log(
    `[TurnStop] ${event.sessionId} | ` +
    `${event.messageCount} msgs | ` +
    `${event.toolCallsExecuted} tool call(s)`
  );
}

// ─── Registration ───

/**
 * Register all hook listeners. Call once at app startup.
 * Returns an object of unsubscribe functions for cleanup.
 */
export function registerHookListeners(): {
  unsubscribe: () => void;
} {
  const unsubscribes = [
    hookBus.on("PostToolUse", onPostToolUse),
    hookBus.on("SessionEnd", onSessionEnd),
    hookBus.on("UserPromptSubmit", onUserPromptSubmit),
    hookBus.on("SessionStart", onSessionStart),
    hookBus.on("Stop", onStop),
  ];

  console.log("[HookListeners] Registered 5 lifecycle handlers");

  return {
    unsubscribe: () => {
      unsubscribes.forEach((fn) => fn());
      console.log("[HookListeners] Unregistered all handlers");
    },
  };
}

/**
 * Get accumulated tool stats for the current or all sessions.
 */
export function getToolStats(sessionId?: string): ToolStats | Map<string, ToolStats> {
  if (sessionId) return sessionStats.get(sessionId) ?? { calls: 0, errors: 0, totalDurationMs: 0, byTool: {} };
  return sessionStats;
}
