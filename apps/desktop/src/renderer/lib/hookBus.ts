/**
 * Dalam Hook Event Bus — lifecycle event system.
 *
 * Events are fired at specific points in the session lifecycle:
 *   - SessionStart:    When a new chat session is created
 *   - UserPromptSubmit: When the user sends a message (before LLM call)
 *   - PostToolUse:     After a tool is executed (read/write/edit/bash/etc.)
 *   - Stop:            When the LLM turn ends (response complete)
 *   - SessionEnd:      When a session is closed/aborted
 *
 * Hooks are registered as plain functions that receive an event payload.
 * They run sequentially (not in parallel) and errors are caught and logged
 * without stopping the pipeline.
 *
 * Usage:
 *   import { hookBus } from "@/lib/hookBus";
 *   hookBus.on("SessionStart", (event) => { ... });
 *   hookBus.off("SessionStart", myHandler);
 */

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export interface SessionStartEvent {
  sessionId: string;
  workspacePath: string;
  model: string;
  agentName: string;
  mode: string;
  timestamp: number;
}

export interface UserPromptSubmitEvent {
  sessionId: string;
  prompt: string;
  conversationHistory: unknown[];
  agentName: string;
  attachments: { name: string; mimeType: string }[];
  timestamp: number;
}

export interface PostToolUseEvent {
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export interface StopEvent {
  sessionId: string;
  fullContent: string;
  messageCount: number;
  toolCallsExecuted: number;
  timestamp: number;
}

export interface SessionEndEvent {
  sessionId: string;
  reason: "completed" | "aborted" | "error";
  messageCount: number;
  durationMs: number;
  timestamp: number;
}

export type HookEventPayloads = {
  SessionStart: SessionStartEvent;
  UserPromptSubmit: UserPromptSubmitEvent;
  PostToolUse: PostToolUseEvent;
  Stop: StopEvent;
  SessionEnd: SessionEndEvent;
};

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

export type HookHandler<K extends HookEventName = HookEventName> = (
  event: HookEventPayloads[K]
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// HookEventBus class
// ---------------------------------------------------------------------------

class HookEventBus {
  private listeners = new Map<HookEventName, Set<HookHandler>>();
  private executionLog: Array<{
    event: HookEventName;
    handler: string;
    durationMs: number;
    error?: string;
    timestamp: number;
  }> = [];
  private static readonly MAX_LOG_SIZE = 100;

  /**
   * Register a handler for a lifecycle event.
   * Returns an unsubscribe function.
   */
  on<K extends HookEventName>(eventName: K, handler: HookHandler<K>): () => void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(handler as HookHandler);
    return () => this.off(eventName, handler);
  }

  /**
   * Remove a specific handler for an event.
   */
  off<K extends HookEventName>(eventName: K, handler: HookHandler<K>): void {
    this.listeners.get(eventName)?.delete(handler as HookHandler);
  }

  /**
   * Remove all handlers for an event, or all handlers for all events.
   */
  clear(eventName?: HookEventName): void {
    if (eventName) {
      this.listeners.delete(eventName);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Emit an event to all registered handlers.
   * Handlers run sequentially. Errors are caught and logged, never thrown.
   */
  async emit<K extends HookEventName>(
    eventName: K,
    payload: HookEventPayloads[K]
  ): Promise<void> {
    const handlers = this.listeners.get(eventName);
    if (!handlers || handlers.size === 0) return;

    // Warn if too many listeners (potential memory leak)
    if (handlers.size > 20) {
      console.warn(
        `[HookBus] ${handlers.size} listeners registered for "${eventName}" — possible memory leak`
      );
    }

    // Snapshot the handlers to avoid issues if a handler modifies the Set during iteration
    const handlerList = [...handlers];

    for (const handler of handlerList) {
      const start = Date.now();
      const handlerName = handler.name || "anonymous";
      try {
        const result = handler(payload);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Use AbortController + timer for timeout instead of Promise.race to avoid
          // leaking the timeout rejection handler if the handler resolves first.
          // With Promise.race, the timeout Promise keeps its rejection callback alive
          // until the timer fires (10s), preventing GC of the closure chain.
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => {
            timeoutController.abort();
          }, 10_000);
          try {
            // Race the handler against a signal-aware rejection
            await Promise.race([
              result,
              new Promise<never>((_, reject) => {
                timeoutController.signal.addEventListener("abort", () => {
                  reject(new Error(`Handler "${handlerName}" timed out after 10s`));
                }, { once: true });
              }),
            ]);
          } finally {
            clearTimeout(timeoutId);
          }
        }
        this.pushLog({
          event: eventName,
          handler: handlerName,
          durationMs: Date.now() - start,
          timestamp: Date.now(),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.pushLog({
          event: eventName,
          handler: handlerName,
          durationMs: Date.now() - start,
          error: errorMsg,
          timestamp: Date.now(),
        });
        console.warn(
          `[HookBus] Error in ${eventName} handler "${handlerName}":`,
          errorMsg
        );
      }
    }
  }

  /**
   * Push an entry to the execution log, capping at MAX_LOG_SIZE.
   */
  private pushLog(entry: typeof this.executionLog[number]): void {
    this.executionLog.push(entry);
    if (this.executionLog.length > HookEventBus.MAX_LOG_SIZE) {
      // splice avoids allocating a new array on every overflow
      this.executionLog.splice(0, this.executionLog.length - HookEventBus.MAX_LOG_SIZE);
    }
  }

  /**
   * Get recent execution log entries (for diagnostics).
   */
  getExecutionLog(limit = 50): typeof this.executionLog {
    return this.executionLog.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const hookBus = new HookEventBus();
