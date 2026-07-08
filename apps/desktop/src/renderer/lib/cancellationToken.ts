/**
 * CancellationToken — cooperative cancellation primitive.
 *
 * Used to propagate abort signals across async operations (agent loops,
 * dream cycles, compaction, etc.) without relying on AbortController
 * (which is browser-only and has different semantics).
 */

export class CancellationToken {
  private _aborted = false;
  private _reason?: string;
  private _listeners: Array<() => void> = [];

  get isAborted(): boolean {
    return this._aborted;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  abort(reason?: string): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason;

    for (const listener of this._listeners) {
      listener();
    }
    this._listeners = [];
  }

  throwIfAborted(): void {
    if (this._aborted) {
      throw new Error(`Operation cancelled: ${this._reason || "unknown reason"}`);
    }
  }

  /**
   * Register a callback that fires when cancellation is requested.
   * Returns an unsubscribe function.
   * If already aborted, fires immediately and returns a no-op unsub.
   */
  onAbort(callback: () => void): () => void {
    if (this._aborted) {
      callback();
      return () => {};
    }
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  /**
   * Create a child token that is cancelled when any of the parent tokens are cancelled.
   * Cleanup: when the combined token is aborted, parent listeners are automatically removed.
   */
  static combine(...tokens: CancellationToken[]): CancellationToken {
    const combined = new CancellationToken();
    const unsubscribes: Array<() => void> = [];

    const cleanup = () => {
      for (const unsub of unsubscribes) unsub();
      unsubscribes.length = 0;
    };

    for (const token of tokens) {
      unsubscribes.push(token.onAbort(() => {
        cleanup();
        combined.abort(token.reason);
      }));
    }

    // Also clean up if combined is aborted independently
    combined.onAbort(cleanup);

    return combined;
  }
}
