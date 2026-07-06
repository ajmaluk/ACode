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
import { createDalamAPI, getActiveProvider, corsFetch } from "./dalamAPI";
import type {
  SessionStartEvent,
  UserPromptSubmitEvent,
  PostToolUseEvent,
  StopEvent,
  SessionEndEvent,
  ContextPressureEvent,
} from "./hookBus";
import { CTX } from "./memoryTypes";

// ─── In-memory stats for the current session ───

interface ToolStats {
  calls: number;
  errors: number;
  totalDurationMs: number;
  lastActivityAt: number;
  byTool: Record<string, { calls: number; errors: number; totalMs: number }>;
}

const sessionStats = new Map<string, ToolStats>();
const MAX_SESSION_STATS = 50;
let maintenanceCounter = 0;
let maintenanceRunning = false;

function getOrCreateStats(sessionId: string): ToolStats {
  if (!sessionStats.has(sessionId)) {
    // Evict oldest entries if the map grows too large
    if (sessionStats.size >= MAX_SESSION_STATS) {
      const oldestKey = sessionStats.keys().next().value;
      if (oldestKey !== undefined) sessionStats.delete(oldestKey);
    }
    sessionStats.set(sessionId, {
      calls: 0,
      errors: 0,
      totalDurationMs: 0,
      lastActivityAt: Date.now(),
      byTool: {},
    });
  }
  return sessionStats.get(sessionId)!;
}

/**
 * Clean up stats for sessions that have been idle for >10 minutes.
 * Called periodically to prevent unbounded growth from abandoned sessions.
 */
function cleanupStaleStats(): void {
  const now = Date.now();
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  for (const [sessionId] of sessionStats) {
    const stats = sessionStats.get(sessionId);
    if (!stats) continue;
    // Session is stale if no activity for >10 minutes
    const isIdle = (now - stats.lastActivityAt) > STALE_THRESHOLD_MS;
    if (isIdle) {
      sessionStats.delete(sessionId);
    }
  }
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
  stats.lastActivityAt = Date.now();

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

  if (import.meta.env.DEV) console.log(`[ToolUse] ${event.toolName} | ${event.durationMs}ms | session: ${event.sessionId.slice(0, 8)}` + (event.error ? ` | ERROR: ${event.error}` : ""));
}

// ─── 2. Auto-Save Context on SessionEnd ───
/**
 * When a session ends (completed or aborted), persists a context snapshot
 * so the next session can resume with knowledge of what happened.
 *
 * This writes a lightweight JSON summary to .dalam/session-history.json
 * that can be read on the next SessionStart.
 */
/**
 * Persist session stats to the workspace session-history.json file.
 */
async function persistSessionStats(event: SessionEndEvent): Promise<void> {
  const stats = sessionStats.get(event.sessionId);
  if (!stats) return;

  try {
    const { useWorkspace } = await import("../store/useAppStore");
    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (!workspace) return;

    const api = createDalamAPI();
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

    history = history.slice(-50);
    await api.fs.writeFile(summaryPath, JSON.stringify(history, null, 2));
  } catch (e) {
    console.warn("[HookListener] Failed to persist session summary:", e);
  }

  sessionStats.delete(event.sessionId);
}

/**
 * Auto-extract memories from the last user-assistant exchange.
 * Falls back from heuristic extraction to LLM-based extraction.
 */
async function autoExtractMemories(event: SessionEndEvent): Promise<void> {
  try {
    const { useChat, useWorkspace } = await import("../store/useAppStore");
    const { extractMemoriesFromExchange, extractMemoriesWithLLM, saveMemory } = await import("./memoryStore");

    const sessionMessages = useChat.getState().sessionMessages[event.sessionId];
    if (!sessionMessages || sessionMessages.length < 2) return;

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;

    // Find the assistant message after it
    let assistantIdx = -1;
    for (let i = lastUserIdx + 1; i < sessionMessages.length; i++) {
      if (sessionMessages[i].role === "assistant") { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return;

    const userInput = sessionMessages[lastUserIdx].content;
    const assistantResponse = sessionMessages[assistantIdx].content;

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
      try {
        const { settings, config } = getActiveProvider();
        const isAnthropic = config.apiFormat === "anthropic";
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
          const resp = await corsFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
          if (!resp.ok) throw new Error(`LLM extraction failed: HTTP ${resp.status}`);
          const json = await resp.json();
          return isAnthropic ? (json.content?.[0]?.text || "") : (json.choices?.[0]?.message?.content || "");
        };
        const llmResult = await extractMemoriesWithLLM(userInput, assistantResponse, fetchLLM, {
          sessionId: event.sessionId, maxEntries: 3, workspacePath: workspace.path,
        });
        // LLM extraction already saved entries when workspacePath was provided,
        // so only track the count — don't double-save via the outer loop.
        if (llmResult.saved > 0) return;
      } catch {
        entries = extractMemoriesFromExchange(userInput, assistantResponse, {
          sessionId: event.sessionId, maxEntries: 3,
        });
      }
    }

    for (const entry of entries) {
      try { await saveMemory(entry, workspace.path); } catch { /* skip */ }
    }
  } catch (e) {
    console.warn("[HookListener] Failed to auto-extract memories:", e);
  }
}

/**
 * Periodic memory maintenance — runs every CTX.MEMORY_MAINTAIN_INTERVAL sessions.
 */
async function runMemoryMaintenanceIfNeeded(): Promise<void> {
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
}

/**
 * Auto-crystallize a skill from the session content.
 * Non-blocking — fires and forgets.
 */
async function triggerSkillCrystallization(event: SessionEndEvent): Promise<void> {
  try {
    const { useWorkspace } = await import("../store/useAppStore");
    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (!workspace) return;

    const { proposeSkillFromSession } = await import("./skillCrystallizer");
    const { useToasts } = await import("../components/ui/toastStore");
    const pushToast = useToasts.getState().push;
    proposeSkillFromSession(
      event.sessionId, workspace.path, false,
      (t: Parameters<typeof pushToast>[0]) => pushToast(t)
    ).catch((err: unknown) => {
      console.warn("[HookListener] Background skill crystallization failed:", err);
    });
  } catch (e) {
    console.warn("[HookListener] Failed to assess session for skill crystallization:", e);
  }
}

/**
 * Detect usage patterns and create/evolve genes from the session.
 */
async function runGeneReflection(event: SessionEndEvent): Promise<void> {
  try {
    const { useChat } = await import("../store/useAppStore");
    const messages = useChat.getState().sessionMessages[event.sessionId] || [];
    if (messages.length < 4) return;

    const { reflectOnSession, loadGenePool, addGene, saveGenePool, evolveGenes, createGeneId, migrateLocalStorageGenes } = await import("./genes");

    // Migrate any legacy localStorage genes on first run
    await migrateLocalStorageGenes();

    const reflection = reflectOnSession(messages, event.sessionId);

    if (reflection.suggestedGenes.length > 0) {
      let pool = await loadGenePool();
      for (const candidate of reflection.suggestedGenes) {
        const uniqueCandidate = { ...candidate, id: createGeneId() };
        pool = await addGene(pool, uniqueCandidate);
      }
      if (pool.genes.length > 10) {
        pool = await evolveGenes(pool);
      }
      await saveGenePool(pool);
    }
  } catch (e) {
    console.warn("[HookListener] Gene reflection failed:", e);
  }
}

// ─── 2. Auto-Save Context on SessionEnd ───
/**
 * When a session ends (completed or aborted), runs all post-session tasks
 * as focused sequential steps, each independently caught.
 */
async function onSessionEnd(event: SessionEndEvent): Promise<void> {
  // 1. Persist session stats
  await persistSessionStats(event);

  // 2. Periodic cleanup of stale session stats (always run, not just when half-full)
  cleanupStaleStats();

  // 3-5: Parallelize independent post-session tasks
  await Promise.allSettled([
    autoGenerateSessionTitle(event),
    autoExtractMemories(event),
    runMemoryMaintenanceIfNeeded(),
  ]);

  // 6. Auto-crystallize skill from session (fire-and-forget)
  triggerSkillCrystallization(event).catch(() => {});

  // 7. Gene reflection (fire-and-forget)
  runGeneReflection(event).catch(() => {});
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
  const historySize = event.conversationHistory.length;
  const hasAttachments = event.attachments.length > 0;
  if (import.meta.env.DEV) console.log(
    `[Prompt] ${event.sessionId.slice(0, 8)} | ` +
    `${event.prompt.length} chars | ` +
    `${historySize} msgs` +
    (hasAttachments ? ` | ${event.attachments.length} attachment(s)` : "")
  );
}

// ─── 4. Session Start Tracking (SessionStart) ───
/**
 * Logs when a new session begins with context about the workspace and model.
 */
function onSessionStart(event: SessionStartEvent): void {
  if (import.meta.env.DEV) console.log(
    `[SessionStart] ${event.sessionId.slice(0, 8)} | ` +
    `model: ${event.model} | agent: ${event.agentName} | mode: ${event.mode}`
  );
}

// ─── 5. Stop Event (Turn Complete) ───
/**
 * Logs when an LLM turn completes, with tool call counts.
 */
function onStop(event: StopEvent): void {
  if (import.meta.env.DEV) console.log(
    `[TurnStop] ${event.sessionId} | ` +
    `${event.messageCount} msgs | ` +
    `${event.toolCallsExecuted} tool call(s)`
  );
}

// ─── 6. Session Title Generation ───
/**
 * Generate a descriptive title for a session based on the first user message.
 * Uses heuristics to create a concise, meaningful title.
 */
const MAX_TITLE_LENGTH = 80;

function generateSessionTitle(firstUserMessage: string): string {
  if (!firstUserMessage) return "Untitled session";

  // Extract the first line or first sentence
  let title = firstUserMessage.split("\n")[0].trim();

  // Remove common prefixes
  title = title.replace(/^(please|can you|could you|help me|I need to|I want to|fix|add|update|change|remove|delete|implement|create|write|build|refactor|debug|test|optimize|improve)\s+/i, "");

  // If still too long, truncate at word boundary
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, "");
    if (title.length < MAX_TITLE_LENGTH) title += "...";
  }

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return title || "Untitled session";
}

/**
 * Auto-generate a session title on first LLM response.
 * This is called after the first assistant message is received.
 */
async function autoGenerateSessionTitle(event: SessionEndEvent): Promise<void> {
  try {
    const { useChat } = await import("../store/useAppStore");
    const messages = useChat.getState().sessionMessages[event.sessionId];
    if (!messages || messages.length < 2) return;

    // Find the first user message
    const firstUserMsg = messages.find(m => m.role === "user");
    if (!firstUserMsg) return;

    // Check if session already has a custom title
    const session = useChat.getState().chatSessions.find(s => s.id === event.sessionId);
    if (session?.title && session.title !== "Untitled session") return;

    // Generate title from first user message
    const title = generateSessionTitle(firstUserMsg.content);

    // Update session title
    useChat.getState().renameSession(event.sessionId, title);
  } catch (e) {
    console.warn("[HookListener] Failed to auto-generate session title:", e);
  }
}

// ─── 6. Context Pressure Event ───
/**
 * Automatically extracts and saves key facts when context pressure is high.
 * This prevents important information from being lost during compaction.
 */
let lastMemoryFlushTime = 0;
const MEMORY_FLUSH_COOLDOWN_MS = 60_000; // 1 minute cooldown between flushes

async function onContextPressure(event: ContextPressureEvent): Promise<void> {
  // Only act on medium or high pressure
  if (event.pressure === "none" || event.pressure === "low") return;

  // Cooldown to prevent excessive memory writes
  const now = Date.now();
  if (now - lastMemoryFlushTime < MEMORY_FLUSH_COOLDOWN_MS) return;
  lastMemoryFlushTime = now;

  try {
    const { useChat, useWorkspace } = await import("../store/useAppStore");
    const { extractMemoriesFromExchange, saveMemory } = await import("./memoryStore");

    const sessionMessages = useChat.getState().sessionMessages[event.sessionId];
    if (!sessionMessages || sessionMessages.length < 4) return;

    // Get the last user-assistant exchange
    let lastUserIdx = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;

    let assistantIdx = -1;
    for (let i = lastUserIdx + 1; i < sessionMessages.length; i++) {
      if (sessionMessages[i].role === "assistant") { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return;

    const userInput = sessionMessages[lastUserIdx].content;
    const assistantResponse = sessionMessages[assistantIdx].content;

    if (userInput.length + assistantResponse.length < 200) return;

    const workspace = useWorkspace.getState().workspaces.find(
      (w) => w.id === useWorkspace.getState().activeWorkspaceId
    );
    if (!workspace) return;

    // Extract memories using heuristics (no LLM call for speed)
    const entries = extractMemoriesFromExchange(userInput, assistantResponse, {
      sessionId: event.sessionId,
      maxEntries: 2, // Limit to avoid too many writes
    });

    for (const entry of entries) {
      try {
        await saveMemory(entry, workspace.path);
      } catch { /* skip individual failures */ }
    }

    if (entries.length > 0) {
      if (import.meta.env.DEV) console.log(
        `[ContextPressure] Auto-saved ${entries.length} memory entries at ${Math.round(event.pressureRatio * 100)}% pressure`
      );
    }
  } catch (e) {
    console.warn("[ContextPressure] Failed to auto-save memories:", e);
  }
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
    hookBus.on("ContextPressure", onContextPressure),
  ];

  return {
    unsubscribe: () => {
      unsubscribes.forEach((fn) => fn());
    },
  };
}


