/**
 * Change Stack — tracks file changes for undo support (session-scoped).
 *
 * Records before/after content for editFile and writeFile operations,
 * allowing the `/undo` command to revert the last change.
 *
 * Each session has its own isolated undo stack to prevent cross-session
 * interference when the user switches between chat sessions.
 */

export interface ChangeRecord {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  timestamp: number;
  toolCallId: string;
  messageId: string;
}

// Limit stack size per session to prevent unbounded memory growth
const MAX_CHANGES_PER_SESSION = 50;
// Session-scoped stacks: sessionId → ChangeRecord[]
const sessionStacks = new Map<string, ChangeRecord[]>();
// Fallback for calls without a session ID (backward compatibility)
const fallbackStack: ChangeRecord[] = [];

function getStack(sessionId?: string): ChangeRecord[] {
  if (sessionId) {
    let stack = sessionStacks.get(sessionId);
    if (!stack) {
      stack = [];
      sessionStacks.set(sessionId, stack);
    }
    return stack;
  }
  return fallbackStack;
}

/**
 * Record a file change for potential undo.
 */
export function recordChange(
  change: Omit<ChangeRecord, "timestamp">,
  sessionId?: string,
): void {
  const stack = getStack(sessionId);
  const entry: ChangeRecord = {
    ...change,
    timestamp: Date.now(),
  };
  stack.push(entry);
  // Cap stack size
  if (stack.length > MAX_CHANGES_PER_SESSION) {
    stack.shift();
  }
}

/**
 * Pop the last change from the stack.
 * Returns null if stack is empty.
 */
export function popChange(sessionId?: string): ChangeRecord | null {
  const stack = getStack(sessionId);
  return stack.length > 0 ? stack.pop()! : null;
}

/**
 * Peek at the last change without removing it.
 */
export function peekChange(sessionId?: string): ChangeRecord | null {
  const stack = getStack(sessionId);
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Clear all changes for a session (e.g., on session end).
 */
export function clearChanges(sessionId?: string): void {
  if (sessionId) {
    sessionStacks.delete(sessionId);
  } else {
    fallbackStack.length = 0;
  }
}

/**
 * Get current stack size (for UI indicator).
 */
export function getChangeStackSize(sessionId?: string): number {
  return getStack(sessionId).length;
}

/**
 * Apply the last change in reverse (undo).
 * Writes the beforeContent back to the file and removes the record.
 * Returns a description of what was undone, or null if stack is empty.
 * FIX M-2: Cache stack reference before push to avoid pushing to wrong stack.
 */
export async function applyUndo(
  sessionId?: string,
): Promise<{ filePath: string; restoredContent: string; toolCallId?: string; messageId?: string } | null> {
  const change = popChange(sessionId);
  if (!change) return null;

  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(change.filePath, change.beforeContent);
    return {
      filePath: change.filePath,
      restoredContent: change.beforeContent,
      toolCallId: change.toolCallId,
      messageId: change.messageId,
    };
  } catch (err) {
    // If the file write fails, push the change back so it isn't lost
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[ChangeStack] Failed to undo ${change.filePath}: ${msg}`);
    // getStack creates a new stack if session was cleared — that's better than losing the change
    const stack = getStack(sessionId);
    stack.push(change);
    // Cap stack size
    if (stack.length > MAX_CHANGES_PER_SESSION) {
      stack.shift();
    }
    return null;
  }
}