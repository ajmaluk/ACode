/**
 * ============================================================
 * DALAM LOGGER — Structured Logging System
 * ============================================================
 *
 * Replaces scattered console.log calls with structured,
 * leveled logging. Supports component tagging and metadata.
 *
 * Log levels: trace < debug < info < warn < error
 *
 * In production, logs are written to a file via the Rust backend.
 * In development, logs also appear in the browser console.
 * ============================================================
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  component: string;
  message: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "#888",
  debug: "#6B7280",
  info: "#3B82F6",
  warn: "#F59E0B",
  error: "#EF4444",
};

class DalamLogger {
  private minLevel: LogLevel = "info";
  private entries: LogEntry[] = [];
  private maxEntries = 500;
  private listeners: Set<(entry: LogEntry) => void> = new Set();

  setMinLevel(level: LogLevel) {
    this.minLevel = level;
  }

  /**
   * Subscribe to log entries. Returns an unsubscribe function.
   */
  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get recent log entries.
   */
  getEntries(limit = 100): LogEntry[] {
    return this.entries.slice(-limit);
  }

  /**
   * Clear all stored log entries.
   */
  clear() {
    this.entries = [];
  }

  private log(
    level: LogLevel,
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      component,
      message,
      metadata,
      sessionId,
    };

    // Store entry (ring buffer)
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Don't let listener errors break logging
      }
    }

    // Development console output with color
    if (typeof window !== "undefined") {
      const color = LEVEL_COLORS[level];
      const prefix = `%c[${level.toUpperCase()}]%c ${component}`;
      const args: unknown[] = [
        `color: ${color}; font-weight: bold`,
        "color: inherit",
        message,
      ];
      if (metadata && Object.keys(metadata).length > 0) {
        args.push(metadata);
      }
      switch (level) {
        case "error":
          console.error(prefix, ...args);
          break;
        case "warn":
          console.warn(prefix, ...args);
          break;
        case "trace":
        case "debug":
          console.debug(prefix, ...args);
          break;
        default:
          console.log(prefix, ...args);
      }
    }
  }

  trace(
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.log("trace", component, message, metadata, sessionId);
  }

  debug(
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.log("debug", component, message, metadata, sessionId);
  }

  info(
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.log("info", component, message, metadata, sessionId);
  }

  warn(
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.log("warn", component, message, metadata, sessionId);
  }

  error(
    component: string,
    message: string,
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ) {
    this.log("error", component, message, metadata, sessionId);
  }

  /**
   * Create a scoped logger for a specific component.
   */
  scoped(component: string, sessionId?: string) {
    return {
      trace: (msg: string, meta?: Record<string, unknown>) =>
        this.trace(component, msg, meta, sessionId),
      debug: (msg: string, meta?: Record<string, unknown>) =>
        this.debug(component, msg, meta, sessionId),
      info: (msg: string, meta?: Record<string, unknown>) =>
        this.info(component, msg, meta, sessionId),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        this.warn(component, msg, meta, sessionId),
      error: (msg: string, meta?: Record<string, unknown>) =>
        this.error(component, msg, meta, sessionId),
    };
  }
}

/** Global logger instance */
export const logger = new DalamLogger();
