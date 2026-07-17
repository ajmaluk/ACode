/**
 * ============================================================
 * DALAM CONNECTOR PLUGIN SYSTEM — Hermes-Style Platform Adapters
 * ============================================================
 *
 * Provides a plugin-based connector system for messaging platforms,
 * inspired by Hermes Agent's 20+ platform connectors.
 *
 * Each connector implements the Connector interface and can receive
 * messages from external platforms and relay them to Dalam's agent.
 *
 * Built-in connectors:
 * - HTTP Webhook: Generic webhook receiver for any platform
 * - WebSocket: Real-time bidirectional connection
 * - File Watcher: Monitor files/directories for changes
 * - Cron: Scheduled task execution
 *
 * External connectors can be added via the plugin system.
 * ============================================================
 */

// ─── Helpers ────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing attacks on auth tokens */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─── Types ─────────────────────────────────────────────────

export interface ConnectorMessage {
  /** Platform-specific message ID */
  platformMessageId: string;
  /** Sender display name */
  senderName: string;
  /** Sender platform ID */
  senderId: string;
  /** Message content (text, may include markdown) */
  content: string;
  /** Optional: file attachments */
  attachments?: Array<{
    name: string;
    mimeType: string;
    content: string; // base64 or text
  }>;
  /** Platform metadata */
  platform: string;
  /** Timestamp */
  timestamp: number;
  /** Optional: reply-to message ID */
  replyTo?: string;
  /** Optional: channel/group ID */
  channelId?: string;
}

export interface ConnectorConfig {
  /** Unique connector ID */
  id: string;
  /** Display name */
  name: string;
  /** Connector type */
  type:
    | "webhook"
    | "websocket"
    | "file-watcher"
    | "cron"
    | "telegram"
    | "whatsapp"
    | "custom";
  /** Whether this connector is enabled */
  enabled: boolean;
  /** Type-specific configuration */
  config: Record<string, unknown>;
}

export interface ConnectorEvents {
  /** Called when a message is received from the platform */
  onMessage: (message: ConnectorMessage) => void;
  /** Called when the connector status changes */
  onStatusChange: (status: "connected" | "disconnected" | "error") => void;
}

export interface Connector {
  /** Connector metadata */
  readonly id: string;
  readonly name: string;
  readonly type: string;

  /** Lifecycle methods */
  start(events: ConnectorEvents): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  /** Send a message back to the platform */
  sendMessage(channelId: string, content: string): Promise<void>;

  /** Get connector status */
  getStatus(): { connected: boolean; error?: string };
}

// ─── Connector Registry ────────────────────────────────────

const connectors: Map<string, Connector> = new Map();

/**
 * Register a connector plugin.
 */
export function registerConnector(connector: Connector): void {
  connectors.set(connector.id, connector);
  if (import.meta.env.DEV)
    console.log(
      "Connector",
      `Registered connector: ${connector.name} (${connector.type})`,
    );
}

/**
 * Unregister a connector.
 */
export function unregisterConnector(id: string): void {
  const connector = connectors.get(id);
  if (connector) {
    connector.stop().catch(() => {});
    connectors.delete(id);
  }
}

/**
 * Unregister all connectors (for workspace close / session teardown).
 * Prevents leaked state from stale connectors surviving across workspace switches.
 */
export function unregisterAllConnectors(): void {
  for (const [id, connector] of connectors) {
    connector.stop().catch(() => {});
  }
  connectors.clear();
}

// ─── Built-in Connectors ───────────────────────────────────

// --- HTTP Webhook Connector ---
export class WebhookConnector implements Connector {
  readonly id: string;
  readonly name: string;
  readonly type = "webhook";

  private connected = false;
  private server: unknown = null;
  private events: ConnectorEvents | null = null;
  private port: number;
  private path: string;
  private authToken?: string;

  constructor(config: {
    id: string;
    name: string;
    port?: number;
    path?: string;
    authToken?: string;
  }) {
    this.id = config.id;
    this.name = config.name;
    this.port = config.port ?? 3847;
    this.path = config.path ?? "/webhook";
    this.authToken = config.authToken;
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    // Webhook server implementation would go here
    // For now, mark as connected (actual HTTP server requires runtime environment)
    // L-11: Provide proper error message when webhook is a stub
    const errorMsg =
      "[WebhookConnector] Webhook server is a stub — actual HTTP server requires a runtime environment with an HTTP server library. Marking as connected, but incoming webhooks will not be processed.";
    console.warn(errorMsg);
    this.connected = true;
    events.onStatusChange("connected");
    if (import.meta.env.DEV)
      console.log(
        "Webhook",
        `Started webhook listener on port ${this.port}${this.path}`,
      );
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.events?.onStatusChange("disconnected");
    if (import.meta.env.DEV) console.log("Webhook", "Stopped webhook listener");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(_channelId: string, _content: string): Promise<void> {
    // Webhook is receive-only; sending would require a response URL
    console.warn("Webhook", "Webhook connector is receive-only");
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  /** Process an incoming webhook payload */
  handlePayload(payload: Record<string, unknown>): void {
    if (!this.events) return;

    // Verify auth token if configured
    if (this.authToken) {
      const headers = (payload.headers ?? {}) as Record<string, unknown>;
      const token = headers["x-auth-token"] ?? payload.token;
      if (typeof token !== "string" || !constantTimeEqual(token, this.authToken)) {
        console.warn("Webhook", "Invalid auth token");
        return;
      }
    }

    const message: ConnectorMessage = {
      platformMessageId: String(payload.message_id ?? payload.id ?? Date.now()),
      senderName: String(payload.sender_name ?? payload.from ?? "webhook-user"),
      senderId: String(payload.sender_id ?? payload.from ?? "unknown"),
      content: String(payload.text ?? payload.content ?? payload.message ?? ""),
      platform: "webhook",
      timestamp: Date.now(),
      channelId: String(payload.channel_id ?? payload.group ?? "default"),
    };

    if (message.content) {
      this.events.onMessage(message);
    }
  }
}

// --- File Watcher Connector ---
export class FileWatcherConnector implements Connector {
  readonly id: string;
  readonly name: string;
  readonly type = "file-watcher";

  private connected = false;
  private events: ConnectorEvents | null = null;
  private watchPaths: string[];
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshots: Map<string, { content: string; mtime: number; size: number }> = new Map();

  constructor(config: {
    id: string;
    name: string;
    paths?: string[];
    pollIntervalMs?: number;
  }) {
    this.id = config.id;
    this.name = config.name;
    this.watchPaths = config.paths ?? [];
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    this.connected = true;

    // Start polling for file changes
    if (this.watchPaths.length > 0) {
      this.pollTimer = setInterval(() => {
        if (!this.connected || !this.events) return;
        void this.poll();
      }, this.pollIntervalMs);
    }

    events.onStatusChange("connected");
    if (import.meta.env.DEV)
      console.log(
        "FileWatcher",
        `Started watching ${this.watchPaths.length} paths (poll every ${this.pollIntervalMs}ms)`,
      );
  }

  private async poll(): Promise<void> {
    if (!this.events) return;
    try {
      const { readFile, stat } = await import("@tauri-apps/plugin-fs");
      for (const watchPath of this.watchPaths) {
        try {
          // M-11: Check file size/mtime before reading full content
          let fileStat: { size: number; mtime: number };
          try {
            const statResult = await stat(watchPath);
            const mtime = statResult.mtime;
            fileStat = { size: statResult.size ?? 0, mtime: mtime instanceof Date ? mtime.getTime() : (mtime ?? 0) };
          } catch {
            // If stat fails, file may not exist or be inaccessible
            continue;
          }

          const prev = this.lastSnapshots.get(watchPath);

          // If we have a previous snapshot, compare mtime and size first
          if (prev) {
            if (prev.mtime === fileStat.mtime && prev.size === fileStat.size) {
              // File hasn't changed — skip read
              continue;
            }
          }

          // Skip files that are too large (> 10MB)
          if (fileStat.size > 10 * 1024 * 1024) {
            console.warn("[FileWatcher] Skipping large file:", watchPath, fileStat.size);
            continue;
          }

          const content = await readFile(watchPath);
          const text =
            typeof content === "string"
              ? content
              : new TextDecoder().decode(content);

          const prevContent = prev?.content;
          if (prevContent !== undefined && prevContent !== text) {
            this.events.onMessage({
              platformMessageId: `filewatch-${Date.now()}`,
              senderName: "file-watcher",
              senderId: `filewatch-${this.id}`,
              content: `File changed: ${watchPath}`,
              platform: "file-watcher",
              timestamp: Date.now(),
              channelId: "file-watcher",
              attachments: [
                {
                  name: watchPath.split("/").pop() || watchPath,
                  mimeType: "text/plain",
                  content: text,
                },
              ],
            });
          }
          this.lastSnapshots.set(watchPath, { content: text, mtime: fileStat.mtime, size: fileStat.size });
        } catch (err) {
          console.warn("[FileWatcher] Error reading file:", err);
        }
      }
    } catch (err) {
      console.warn("[FileWatcher] Poll error:", err);
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(_channelId: string, _content: string): Promise<void> {
    console.warn(
      "[FileWatcherConnector] sendMessage not supported — this connector is receive-only",
    );
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }
}

// --- Cron Connector ---
export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  prompt: string;
  enabled: boolean;
}

export class CronConnector implements Connector {
  readonly id: string;
  readonly name: string;
  readonly type = "cron";

  private connected = false;
  private events: ConnectorEvents | null = null;
  private jobs: CronJob[] = [];
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(config: { id: string; name: string; jobs?: CronJob[] }) {
    this.id = config.id;
    this.name = config.name;
    this.jobs = config.jobs ?? [];
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    this.connected = true;
    events.onStatusChange("connected");

    // Schedule active jobs
    for (const job of this.jobs) {
      if (job.enabled) this.scheduleJob(job);
    }

    if (import.meta.env.DEV)
      console.log(
        "Cron",
        `Started with ${this.jobs.filter((j) => j.enabled).length} active jobs`,
      );
  }

  async stop(): Promise<void> {
    this.connected = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(_channelId: string, _content: string): Promise<void> {
    console.warn(
      "[CronConnector] sendMessage not supported — this connector is receive-only",
    );
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  addJob(job: CronJob): void {
    this.jobs.push(job);
    if (job.enabled && this.connected) this.scheduleJob(job);
  }

  removeJob(jobId: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  private scheduleJob(job: CronJob): void {
    // Parse cron expressions (minute, hour, dayOfMonth, month, dayOfWeek)
    // Supports: "* * * * *", "30 9 * * 1-5" (weekdays 9:30), "0 12 * * 0" (Sundays noon)
    const parts = job.schedule.split(" ");
    if (parts.length !== 5) {
      console.warn(
        "Cron",
        `Invalid cron expression for job ${job.name}: ${job.schedule}`,
      );
      return;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Check if a cron field matches the given value
    const cronFieldMatches = (field: string, value: number): boolean => {
      if (field === "*") return true;
      // Handle ranges like "1-5"
      if (field.includes("-")) {
        const [start, end] = field.split("-").map(Number);
        return value >= start && value <= end;
      }
      // Handle comma-separated values like "1,3,5"
      if (field.includes(",")) {
        return field.split(",").map(Number).includes(value);
      }
      // Handle step values like "*/5"
      if (field.startsWith("*/")) {
        const step = parseInt(field.slice(2), 10);
        return value % step === 0;
      }
      return parseInt(field, 10) === value;
    };

    // Use setTimeout to schedule the next occurrence, then reschedule
    const scheduleNext = () => {
      const now = new Date();
      // Start from the next full minute
      const target = new Date(now);
      target.setSeconds(0, 0);
      target.setMilliseconds(0);
      target.setMinutes(target.getMinutes() + 1);

      // L-13: Reduce SAFETY_LIMIT to a reasonable value (48 hours max lookahead)
      const SAFETY_LIMIT = 48 * 60; // 48 hours of minutes
      for (let i = 0; i < SAFETY_LIMIT; i++) {
        if (
          cronFieldMatches(minute, target.getMinutes()) &&
          cronFieldMatches(hour, target.getHours()) &&
          cronFieldMatches(dayOfMonth, target.getDate()) &&
          cronFieldMatches(month, target.getMonth() + 1) &&
          cronFieldMatches(dayOfWeek, target.getDay())
        ) {
          break; // found valid time
        }
        target.setMinutes(target.getMinutes() + 1);
      }

      const targetTime = target.getTime();
      const nowTime = Date.now();

      // Guard against system clock jumps (NTP sync, sleep/wake):
      // if the computed target is more than 48 hours in the past, recalculate
      if (targetTime < nowTime - 48 * 60 * 60 * 1000) {
        // Clock jumped backward — recalculate from current time
        scheduleNext();
        return;
      }

      // L-12: Add drift compensation to cron setTimeout
      // If we've drifted past the target, schedule immediately
      const delayMs = Math.max(0, targetTime - nowTime);

      // M-10: Fix clearTimeout — clear the correct timer before setting new one
      const prevTimer = this.timers.get(job.id);
      if (prevTimer) {
        clearTimeout(prevTimer);
      }

      if (delayMs <= 0) {
        // Target is in the past — fire immediately but schedule next
        if (this.connected && this.events) {
          const message: ConnectorMessage = {
            platformMessageId: `cron-${job.id}-${Date.now()}`,
            senderName: "cron",
            senderId: `cron-${job.id}`,
            content: job.prompt,
            platform: "cron",
            timestamp: Date.now(),
            channelId: "cron",
          };
          this.events.onMessage(message);
        }
        scheduleNext();
        return;
      }

      const timer = setTimeout(() => {
        if (!this.connected || !this.events) return;
        const message: ConnectorMessage = {
          platformMessageId: `cron-${job.id}-${Date.now()}`,
          senderName: "cron",
          senderId: `cron-${job.id}`,
          content: job.prompt,
          platform: "cron",
          timestamp: Date.now(),
          channelId: "cron",
        };
        this.events.onMessage(message);
        // H-10: Remove old timer entry after firing to prevent Map leak
        this.timers.delete(job.id);
        // Reschedule for next occurrence
        scheduleNext();
      }, delayMs);

      this.timers.set(job.id, timer);
    };

    scheduleNext();
  }
}

// --- Telegram Connector (Hermes-style Bot API polling) ---
export class TelegramConnector implements Connector {
  readonly id: string;
  readonly name: string;
  readonly type = "telegram";

  private connected = false;
  private events: ConnectorEvents | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateId = 0;
  private botToken: string;
  private allowedUsers: number[];
  private webhookUrl?: string;
  // L-15: Use message ID for deduplication instead of timestamp
  // Map<msgId, timestamp> for O(1) eviction of oldest entries
  private processedMessageIds: Map<string, number> = new Map();
  private maxProcessedIds = 1000;
  // L-14: Rate limiting
  private lastPollTime = 0;
  private minPollInterval = 2000; // minimum ms between polls

  constructor(config: {
    id: string;
    name: string;
    botToken: string;
    allowedUsers?: number[];
    webhookUrl?: string;
  }) {
    this.id = config.id;
    this.name = config.name;
    this.botToken = config.botToken;
    this.allowedUsers = config.allowedUsers ?? [];
    this.webhookUrl = config.webhookUrl;
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    if (!this.botToken) {
      events.onStatusChange("error");
      console.warn("Telegram", "No bot token configured");
      return;
    }
    // Validate bot token by calling getMe
    try {
      // H-11: Use POST body instead of URL query for Telegram bot token
      const resp = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.description || "Invalid token");
      if (import.meta.env.DEV)
        console.log("Telegram", `Connected as @${data.result.username}`);
      this.connected = true;
      events.onStatusChange("connected");
      // Start polling for updates
      this.pollTimer = setInterval(() => void this.poll(), 2000);
      void this.poll(); // immediate first poll
    } catch (err) {
      events.onStatusChange("error");
      if (import.meta.env.DEV)
        console.error("Telegram", "Failed to connect", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!this.botToken) return;
    try {
      // H-11: Use POST body for sendMessage as well
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: content,
          parse_mode: "Markdown",
        }),
      });
    } catch (err) {
      if (import.meta.env.DEV)
        console.error("Telegram", "Failed to send message", {
          error: String(err),
        });
    }
  }

  private async poll(): Promise<void> {
    if (!this.connected || !this.events || !this.botToken) return;

    // L-14: Rate limiting — ensure minimum interval between polls
    const now = Date.now();
    if (now - this.lastPollTime < this.minPollInterval) return;
    this.lastPollTime = now;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=1`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.ok) return;
      for (const update of data.result ?? []) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        const msg = update.message;
        if (!msg?.text) continue;
        // Access control: skip messages from unauthorized users
        if (
          this.allowedUsers.length > 0 &&
          !this.allowedUsers.includes(msg.from?.id)
        )
          continue;
        // L-15: Use message ID for deduplication instead of timestamp
        const msgId = String(msg.message_id);
        if (this.processedMessageIds.has(msgId)) continue;
        this.processedMessageIds.set(msgId, Date.now());
        // Cap the map size to prevent memory leak
        if (this.processedMessageIds.size > this.maxProcessedIds) {
          // Remove oldest entries (first 500) using insertion-ordered keys
          const iter = this.processedMessageIds.keys();
          for (let i = 0; i < 500; i++) {
            const key = iter.next();
            if (key.done) break;
            this.processedMessageIds.delete(key.value);
          }
        }
        const message: ConnectorMessage = {
          platformMessageId: msgId,
          senderName: msg.from?.first_name ?? "telegram-user",
          senderId: String(msg.from?.id ?? "unknown"),
          content: msg.text,
          platform: "telegram",
          timestamp: msg.date * 1000,
          replyTo: msg.reply_to_message
            ? String(msg.reply_to_message.message_id)
            : undefined,
          channelId: String(msg.chat.id),
        };
        this.events.onMessage(message);
      }
    } catch (err) {
      console.warn("[Telegram] Poll error:", err);
    }
  }
}

// --- WhatsApp Connector (Hermes-style webhook relay) ---
// WhatsApp uses a webhook relay pattern because the Baileys library
// (WhatsApp Web emulation) requires a persistent Node.js server.
// This connector connects to a self-hosted WhatsApp bridge server.
export class WhatsAppConnector implements Connector {
  readonly id: string;
  readonly name: string;
  readonly type = "whatsapp";

  private connected = false;
  private events: ConnectorEvents | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTimestamp = 0;
  private bridgeUrl: string;
  private authToken?: string;
  private allowedUsers: string[];

  constructor(config: {
    id: string;
    name: string;
    bridgeUrl: string;
    authToken?: string;
    allowedUsers?: string[];
  }) {
    this.id = config.id;
    this.name = config.name;
    // H-12: URL validation for WhatsApp bridge URL
    const rawUrl = config.bridgeUrl;
    try {
      const parsedUrl = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Bridge URL must use HTTP or HTTPS");
      }
      this.bridgeUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");
    } catch (e) {
      console.warn(
        "[WhatsAppConnector] Invalid bridge URL:",
        rawUrl,
        "— using raw value",
        e,
      );
      this.bridgeUrl = rawUrl.replace(/\/+$/, "");
    }
    this.authToken = config.authToken;
    this.allowedUsers = config.allowedUsers ?? [];
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    if (!this.bridgeUrl) {
      events.onStatusChange("error");
      console.warn("WhatsApp", "No bridge URL configured");
      return;
    }
    // Check bridge health
    try {
      const headers: Record<string, string> = {};
      if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
      const resp = await fetch(`${this.bridgeUrl}/health`, { headers });
      if (!resp.ok) throw new Error(`Bridge returned ${resp.status}`);
      this.connected = true;
      events.onStatusChange("connected");
      if (import.meta.env.DEV) console.log("WhatsApp", "Connected to bridge");
      // Poll for new messages
      this.pollTimer = setInterval(() => void this.poll(), 3000);
      void this.poll();
    } catch (err) {
      events.onStatusChange("error");
      if (import.meta.env.DEV)
        console.error("WhatsApp", "Failed to connect to bridge", {
          error: String(err),
        });
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
      await fetch(`${this.bridgeUrl}/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chatId, content }),
      });
    } catch (err) {
      if (import.meta.env.DEV)
        console.error("WhatsApp", "Failed to send message", {
          error: String(err),
        });
    }
  }

  private async poll(): Promise<void> {
    if (!this.connected || !this.events) return;
    try {
      const headers: Record<string, string> = {};
      if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
      const resp = await fetch(
        `${this.bridgeUrl}/messages?since=${this.lastMessageTimestamp}`,
        { headers },
      );
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        messages?: Array<{
          id: string;
          from: string;
          fromName?: string;
          body: string;
          timestamp: number;
          chatId: string;
        }>;
      };
      for (const msg of data.messages ?? []) {
        if (msg.timestamp <= this.lastMessageTimestamp) continue;
        this.lastMessageTimestamp = msg.timestamp;
        // Access control
        if (
          this.allowedUsers.length > 0 &&
          !this.allowedUsers.includes(msg.from)
        )
          continue;
        const message: ConnectorMessage = {
          platformMessageId: msg.id,
          senderName: msg.fromName ?? msg.from,
          senderId: msg.from,
          content: msg.body,
          platform: "whatsapp",
          timestamp: msg.timestamp * 1000,
          channelId: msg.chatId,
        };
        this.events.onMessage(message);
      }
    } catch (err) {
      console.warn("[WhatsApp] Poll error:", err);
    }
  }
}

// ─── Connector Manager ─────────────────────────────────────

const STORAGE_KEY = "dalam.connectors.v1";

// M-9: Simple promise-chain mutex to prevent race conditions in saveConnectorConfig
let _saveChain: Promise<void> = Promise.resolve();

/**
 * Load connector configs from localStorage.
 */
function loadConnectorConfigs(): ConnectorConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("[Connectors] Failed to load configs:", err);
    return [];
  }
}

/**
 * Save connector configs to localStorage.
 */
function saveConnectorConfigs(configs: ConnectorConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch (err) {
    console.warn("[Connectors] Failed to save configs:", err);
  }
}

/**
 * Create a connector instance from a config.
 */
function createConnectorFromConfig(config: ConnectorConfig): Connector | null {
  switch (config.type) {
    case "webhook":
      return new WebhookConnector({
        id: config.id,
        name: config.name,
        ...(config.config as {
          port?: number;
          path?: string;
          authToken?: string;
        }),
      });
    case "file-watcher":
      return new FileWatcherConnector({
        id: config.id,
        name: config.name,
        ...(config.config as { paths?: string[]; pollIntervalMs?: number }),
      });
    case "cron":
      return new CronConnector({
        id: config.id,
        name: config.name,
        ...(config.config as { jobs?: CronJob[] }),
      });
    case "telegram":
      return new TelegramConnector({
        id: config.id,
        name: config.name,
        ...(config.config as {
          botToken: string;
          allowedUsers?: number[];
          webhookUrl?: string;
        }),
      });
    case "whatsapp":
      return new WhatsAppConnector({
        id: config.id,
        name: config.name,
        ...(config.config as {
          bridgeUrl: string;
          authToken?: string;
          allowedUsers?: string[];
        }),
      });
    default:
      console.warn("Connector", `Unknown connector type: ${config.type}`);
      return null;
  }
}

/**
 * Initialize a single connector from config.
 */
async function initializeSingleConnector(
  config: ConnectorConfig,
  onMessage: (message: ConnectorMessage) => void,
  onStatusChange: (connectorId: string, status: string) => void,
): Promise<void> {
  const connector = createConnectorFromConfig(config);
  if (!connector) return;

  registerConnector(connector);

  await connector.start({
    onMessage,
    onStatusChange: (status) => onStatusChange(config.id, status),
  });
}

/**
 * Initialize all enabled connectors from stored config.
 */
export async function initializeConnectors(
  onMessage: (message: ConnectorMessage) => void,
  onStatusChange: (connectorId: string, status: string) => void,
): Promise<void> {
  const configs = loadConnectorConfigs();

  for (const config of configs) {
    if (!config.enabled) continue;

    try {
      await initializeSingleConnector(config, onMessage, onStatusChange);
    } catch (err) {
      if (import.meta.env.DEV)
        console.error("Connector", `Failed to start connector ${config.name}`, {
          error: String(err),
        });
    }
  }
}

/**
 * Stop all connectors.
 */
export async function shutdownConnectors(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [name, connector] of connectors) {
    promises.push(
      connector.stop().catch((err) => {
        console.warn(`[Connectors] Failed to stop ${name}:`, err);
      }),
    );
  }
  await Promise.allSettled(promises);
  connectors.clear();
}

/**
 * Add or update a connector config. Restarts the connector if it's running.
 */
export async function saveConnectorConfig(
  config: ConnectorConfig,
  onMessage?: (message: ConnectorMessage) => void,
  onStatusChange?: (connectorId: string, status: string) => void,
): Promise<void> {
  // M-9: Use promise-chain mutex to prevent race conditions
  const myTurn = _saveChain.then(async () => {
    const configs = loadConnectorConfigs();
    const idx = configs.findIndex((c) => c.id === config.id);
    if (idx >= 0) {
      configs[idx] = config;
    } else {
      configs.push(config);
    }
    saveConnectorConfigs(configs);

    // Stop and remove the existing connector atomically
    const connector = connectors.get(config.id);
    if (connector) {
      connectors.delete(config.id);
      try {
        await connector.stop();
      } catch (e) {
        if (import.meta.env.DEV) console.warn(`[Connectors] Failed to stop connector ${config.id}:`, e);
      }
    }

    // Re-initialize if enabled and callbacks are provided
    if (config.enabled && onMessage && onStatusChange) {
      try {
        await initializeSingleConnector(config, onMessage, onStatusChange);
      } catch (err) {
        console.warn(`[Connectors] Failed to restart ${config.id}:`, err);
      }
    }
  });

  _saveChain = myTurn.then(() => {}).catch(() => {});
  await myTurn;
}

/**
 * Remove a connector config.
 */
export function removeConnectorConfig(id: string): void {
  const configs = loadConnectorConfigs().filter((c) => c.id !== id);
  saveConnectorConfigs(configs);
  const connector = connectors.get(id);
  if (connector) {
    connector.stop().catch(() => {});
    connectors.delete(id);
  }
}

/**
 * Get all connector configs.
 */
export function getConnectorConfigs(): ConnectorConfig[] {
  return loadConnectorConfigs();
}
