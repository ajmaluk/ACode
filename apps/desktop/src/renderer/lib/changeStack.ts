/**
 * Change Stack — tracks file changes for undo/redo support (session-scoped).
 *
 * Records before/after content for editFile and writeFile operations,
 * allowing the `/undo` and `/redo` commands to revert/reapply changes.
 *
 * Each session has its own isolated undo/redo stacks to prevent cross-session
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
// Session-scoped redo stacks: sessionId → ChangeRecord[]
const sessionRedoStacks = new Map<string, ChangeRecord[]>();
// Fallback for calls without a session ID (backward compatibility)
const fallbackStack: ChangeRecord[] = [];
const fallbackRedoStack: ChangeRecord[] = [];

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

function getRedoStack(sessionId?: string): ChangeRecord[] {
  if (sessionId) {
    let stack = sessionRedoStacks.get(sessionId);
    if (!stack) {
      stack = [];
      sessionRedoStacks.set(sessionId, stack);
    }
    return stack;
  }
  return fallbackRedoStack;
}

/**
 * Record a file change for potential undo.
 * Clears the redo stack for this session since a new change invalidates redo history.
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
  // Clear redo stack on new change
  getRedoStack(sessionId).length = 0;
  // Cap stack size
  if (stack.length > MAX_CHANGES_PER_SESSION) {
    stack.shift();
  }
}

/**
 * Pop the last change from the undo stack and push it to the redo stack.
 * Returns null if undo stack is empty.
 */
export function popChange(sessionId?: string): ChangeRecord | null {
  const stack = getStack(sessionId);
  if (stack.length === 0) return null;
  const change = stack.pop()!;
  getRedoStack(sessionId).push(change);
  return change;
}

/**
 * Peek at the last change without removing it.
 */
export function peekChange(sessionId?: string): ChangeRecord | null {
  const stack = getStack(sessionId);
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Peek at the last change in the redo stack without removing it.
 */
export function peekRedo(sessionId?: string): ChangeRecord | null {
  const stack = getRedoStack(sessionId);
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Apply the last change in reverse (undo).
 * Writes the beforeContent back to the file and moves the record to redo stack.
 * Returns a description of what was undone, or null if stack is empty.
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
    const stack = getStack(sessionId);
    stack.push(change);
    // Cap stack size
    if (stack.length > MAX_CHANGES_PER_SESSION) {
      stack.shift();
    }
    return null;
  }
}

/**
 * Re-apply the last undone change (redo).
 * Writes the afterContent back to the file and moves the record back to undo stack.
 * Returns a description of what was redone, or null if redo stack is empty.
 */
export async function applyRedo(
  sessionId?: string,
): Promise<{ filePath: string; restoredContent: string; toolCallId?: string; messageId?: string } | null> {
  const redoStack = getRedoStack(sessionId);
  if (redoStack.length === 0) return null;
  const change = redoStack.pop()!;

  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(change.filePath, change.afterContent);
    // Push back to undo stack
    const undoStack = getStack(sessionId);
    undoStack.push(change);
    if (undoStack.length > MAX_CHANGES_PER_SESSION) {
      undoStack.shift();
    }
    return {
      filePath: change.filePath,
      restoredContent: change.afterContent,
      toolCallId: change.toolCallId,
      messageId: change.messageId,
    };
  } catch (err) {
    // If the file write fails, push the change back to redo stack
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[ChangeStack] Failed to redo ${change.filePath}: ${msg}`);
    redoStack.push(change);
    return null;
  }
}

/**
 * Clear all changes for a session (e.g., on session end).
 */
export function clearChanges(sessionId?: string): void {
  if (sessionId) {
    sessionStacks.delete(sessionId);
    sessionRedoStacks.delete(sessionId);
  } else {
    fallbackStack.length = 0;
    fallbackRedoStack.length = 0;
  }
}

/**
 * Get current undo stack size (for UI indicator).
 */
export function getChangeStackSize(sessionId?: string): number {
  return getStack(sessionId).length;
}

/**
 * Get current redo stack size (for UI indicator).
 */
export function getRedoStackSize(sessionId?: string): number {
  return getRedoStack(sessionId).length;
}

/**
 * Check if undo is available for a session.
 */
export function canUndo(sessionId?: string): boolean {
  return getStack(sessionId).length > 0;
}

/**
 * Check if redo is available for a session.
 */
export function canRedo(sessionId?: string): boolean {
  return getRedoStack(sessionId).length > 0;
}