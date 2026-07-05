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