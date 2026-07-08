/**
 * Change Stack — tracks file changes for undo support.
 *
 * Records before/after content for editFile and writeFile operations,
 * allowing the `/undo` command to revert the last change.
 */

export interface ChangeRecord {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  timestamp: number;
  toolCallId: string;
  messageId: string;
}

// Limit stack size to prevent unbounded memory growth
const MAX_CHANGES = 50;
const changeStack: ChangeRecord[] = [];

/**
 * Record a file change for potential undo.
 */
export function recordChange(change: Omit<ChangeRecord, "timestamp">): void {
  const entry: ChangeRecord = {
    ...change,
    timestamp: Date.now(),
  };
  changeStack.push(entry);
  // Cap stack size
  if (changeStack.length > MAX_CHANGES) {
    changeStack.shift();
  }
}

/**
 * Pop the last change from the stack.
 * Returns null if stack is empty.
 */
export function popChange(): ChangeRecord | null {
  return changeStack.length > 0 ? changeStack.pop()! : null;
}

/**
 * Peek at the last change without removing it.
 */
export function peekChange(): ChangeRecord | null {
  return changeStack.length > 0 ? changeStack[changeStack.length - 1] : null;
}

/**
 * Clear all changes (e.g., on session start).
 */
export function clearChanges(): void {
  changeStack.length = 0;
}

/**
 * Get current stack size (for UI indicator).
 */
export function getChangeStackSize(): number {
  return changeStack.length;
}

/**
 * Apply the last change in reverse (undo).
 * Writes the beforeContent back to the file and removes the record.
 * Returns a description of what was undone, or null if stack is empty.
 */
export async function applyUndo(): Promise<{ filePath: string; restoredContent: string } | null> {
  const change = popChange();
  if (!change) return null;

  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(change.filePath, change.beforeContent);
    return {
      filePath: change.filePath,
      restoredContent: change.beforeContent,
    };
  } catch (err) {
    // If the file write fails, push the change back so it isn't lost
    // Use push directly to preserve the original timestamp and ordering
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[ChangeStack] Failed to undo ${change.filePath}: ${msg}`);
    changeStack.push(change);
    // Cap stack size
    if (changeStack.length > MAX_CHANGES) {
      changeStack.shift();
    }
    return null;
  }
}