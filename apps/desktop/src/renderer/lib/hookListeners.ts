/**
 * Dalam Hook Listeners — Example lifecycle event handlers.
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
let maintenanceRunning = false;

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

}

// ─── 2. Auto-Save Context on SessionEnd ───
/**
 * When a session ends (completed or aborted), persists a context snapshot
 * so the next session can resume with knowledge of what happened.
 *
 * This writes a lightweight JSON summary to .dalam/session-history.json
 * that can be read on the next SessionStart.
 */
async function onSessionEnd(event: SessionEndEvent): Promise<void> {
  const stats = sessionStats.get(event.sessionId);

  if (stats) {
    // Persist session summary for next session's context
    try {
      const { useWorkspace } = await import("../store/useAppStore");
      const workspace = useWorkspace.getState().workspaces.find(
        (w) => w.id === useWorkspace.getState().activeWorkspaceId
      );
      if (workspace) {
        const api = (await import("./dalamAPI")).createDalamAPI();
        const summaryPath = `${workspace.path}/.dalam/session-history.json`;
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
    const { extractMemoriesFromExchange, extractMemoriesWithLLM, saveMemory } = await import("./memoryStore");

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

    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (!workspace) return;

    let entries = extractMemoriesFromExchange(userInput, assistantResponse, {
      sessionId: event.sessionId,
      maxEntries: 3,
    });

    if (entries.length === 0) {
      // Try LLM extraction for richer results
      try {
        const { getActiveProvider } = await import("./dalamAPI");
        const { settings, config } = getActiveProvider();
        const isAnthropic = config.apiFormat === "anthropic";
        const { corsFetch: corsFetchFn } = await import("./dalamAPI");
        const fetchLLM = async (prompt: string): Promise<string> => {
          const url = config.baseUrl.replace(/\/+$/, "") + (isAnthropic ? "/v1/messages" : "/chat/completions");
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (isAnthropic) {
            headers["x-api-key"] = config.apiKey;
            headers["anthropic-version"] = "2023-06-01";
          } else {
            headers["Authorization"] = `Bearer ${config.apiKey}`;
          }
          const body = isAnthropic
            ? { model: settings.selectedModel, system: "You are a memory extraction assistant.", messages: [{ role: "user", content: prompt }], max_tokens: 1000 }
            : { model: settings.selectedModel, messages: [{ role: "system", content: "You are a memory extraction assistant." }, { role: "user", content: prompt }], max_tokens: 1000 };
          const resp = await corsFetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
          if (!resp.ok) throw new Error(`LLM extraction failed: HTTP ${resp.status}`);
          const json = await resp.json();
          return isAnthropic ? (json.content?.[0]?.text || "") : (json.choices?.[0]?.message?.content || "");
        };
        const llmResult = await extractMemoriesWithLLM(userInput, assistantResponse, fetchLLM, {
          sessionId: event.sessionId,
          maxEntries: 3,
          workspacePath: workspace.path,
        });
        entries = llmResult.entries;
      } catch {
        // Fall back to heuristic extraction (already computed above as empty)
        entries = extractMemoriesFromExchange(userInput, assistantResponse, {
          sessionId: event.sessionId,
          maxEntries: 3,
        });
      }
    }

    if (entries.length === 0) return;

    for (const entry of entries) {
      try {
        await saveMemory(entry, workspace.path);
      } catch {
        // Silently skip individual failures
      }
    }

  } catch (e) {
    console.warn("[HookListener] Failed to auto-extract memories:", e);
  }

  // ── Periodic self-maintaining memory cleanup ──
  maintenanceCounter++;
  if (maintenanceCounter >= CTX.MEMORY_MAINTAIN_INTERVAL && !maintenanceRunning) {
    maintenanceCounter = 0;
    maintenanceRunning = true;
    try {
      const { runMaintenance } = await import("./memoryStore");
      await runMaintenance();
    } catch (e) {
      console.warn("[HookListener] Memory maintenance failed:", e);
    } finally {
      maintenanceRunning = false;
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
      const { useToasts } = await import("../components/ui/toastStore");
      const pushToast = useToasts.getState().push;
      // Asynchronously trigger proposal check without blocking SessionEnd execution
      proposeSkillFromSession(event.sessionId, workspace.path, false, (t: Parameters<typeof pushToast>[0]) => pushToast(t)).catch((err) => {
        console.warn("[HookListener] Background skill crystallization failed:", err);
      });
    }
  } catch (e) {
    console.warn("[HookListener] Failed to assess session for skill crystallization:", e);
  }

  // ── Gene reflection: detect patterns and create genes ──
  try {
    const { useChat } = await import("../store/useAppStore");
    const messages = useChat.getState().sessionMessages[event.sessionId] || [];
    if (messages.length >= 4) {
      const { reflectOnSession, loadGenePool, addGene, saveGenePool, evolveGenes, createGeneId } = await import("./genes");
      const reflection = reflectOnSession(messages, event.sessionId);
      
      if (reflection.suggestedGenes.length > 0) {
        let pool = loadGenePool();
        for (const candidate of reflection.suggestedGenes) {
          // Assign unique IDs to avoid collisions in concurrent reflections
          const uniqueCandidate = { ...candidate, id: createGeneId() };
          pool = addGene(pool, uniqueCandidate);
        }
        // Evolve the pool periodically
        if (pool.genes.length > 10) {
          pool = evolveGenes(pool);
        }
        saveGenePool(pool);
      }
    }
  } catch (e) {
    console.warn("[HookListener] Gene reflection failed:", e);
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
function onUserPromptSubmit(_event: UserPromptSubmitEvent): void {
}

// ─── 4. Session Start Tracking (SessionStart) ───
/**
 * Logs when a new session begins with context about the workspace and model.
 */
function onSessionStart(_event: SessionStartEvent): void {
}

// ─── 5. Stop Event (Turn Complete) ───
/**
 * Logs when an LLM turn completes, with tool call counts.
 */
function onStop(event: StopEvent): void {
  console.warn(
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

  return {
    unsubscribe: () => {
      unsubscribes.forEach((fn) => fn());
    },
  };
}


