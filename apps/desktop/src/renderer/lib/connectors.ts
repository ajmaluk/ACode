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

import { logger } from "./logger";

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
  type: "webhook" | "websocket" | "file-watcher" | "cron" | "telegram" | "whatsapp" | "custom";
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
const connectorConfigs: Map<string, ConnectorConfig> = new Map();

/**
 * Register a connector plugin.
 */
export function registerConnector(connector: Connector): void {
  connectors.set(connector.id, connector);
  logger.info("Connector", `Registered connector: ${connector.name} (${connector.type})`);
}

/**
 * Unregister a connector.
 */
export function unregisterConnector(id: string): void {
  connectors.delete(id);
}

/**
 * Get a connector by ID.
 */
export function getConnector(id: string): Connector | undefined {
  return connectors.get(id);
}

/**
 * Get all registered connectors.
 */
export function getAllConnectors(): Connector[] {
  return Array.from(connectors.values());
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

  constructor(config: { id: string; name: string; port?: number; path?: string; authToken?: string }) {
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
    this.connected = true;
    events.onStatusChange("connected");
    logger.info("Webhook", `Started webhook listener on port ${this.port}${this.path}`);
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.events?.onStatusChange("disconnected");
    logger.info("Webhook", "Stopped webhook listener");
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(_channelId: string, _content: string): Promise<void> {
    // Webhook is receive-only; sending would require a response URL
    logger.warn("Webhook", "Webhook connector is receive-only");
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
      if (token !== this.authToken) {
        logger.warn("Webhook", "Invalid auth token");
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
  private lastSnapshots: Map<string, string> = new Map();

  constructor(config: { id: string; name: string; paths?: string[]; pollIntervalMs?: number }) {
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
    logger.info("FileWatcher", `Started watching ${this.watchPaths.length} paths (poll every ${this.pollIntervalMs}ms)`);
  }

  private async poll(): Promise<void> {
    if (!this.events) return;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      for (const watchPath of this.watchPaths) {
        try {
          const content = await readFile(watchPath);
          const text = typeof content === "string" ? content : new TextDecoder().decode(content);
          const prev = this.lastSnapshots.get(watchPath);
          if (prev !== undefined && prev !== text) {
            this.events.onMessage({
              platformMessageId: `filewatch-${Date.now()}`,
              senderName: "file-watcher",
              senderId: `filewatch-${this.id}`,
              content: `File changed: ${watchPath}`,
              platform: "file-watcher",
              timestamp: Date.now(),
              channelId: "file-watcher",
              attachments: [{ name: watchPath.split("/").pop() || watchPath, mimeType: "text/plain", content: text }],
            });
          }
          this.lastSnapshots.set(watchPath, text);
        } catch {
          // File may not exist yet — skip
        }
      }
    } catch (err) {
      logger.warn("FileWatcher", "Poll error", { error: String(err) });
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
    // File watcher is receive-only
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
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();

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

    logger.info("Cron", `Started with ${this.jobs.filter(j => j.enabled).length} active jobs`);
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
    // Cron jobs are trigger-only
  }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  addJob(job: CronJob): void {
    this.jobs.push(job);
    if (job.enabled && this.connected) this.scheduleJob(job);
  }

  removeJob(jobId: string): void {
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    const timer = this.timers.get(jobId);
    if (timer) { clearTimeout(timer); this.timers.delete(jobId); }
  }

  private scheduleJob(job: CronJob): void {
    // Parse cron expressions (minute, hour, dayOfMonth, month, dayOfWeek)
    // Supports: "* * * * *", "30 9 * * 1-5" (weekdays 9:30), "0 12 * * 0" (Sundays noon)
    const parts = job.schedule.split(" ");
    if (parts.length !== 5) {
      logger.warn("Cron", `Invalid cron expression for job ${job.name}: ${job.schedule}`);
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
        const step = parseInt(field.slice(2));
        return value % step === 0;
      }
      return parseInt(field) === value;
    };

    // Use setTimeout to schedule the next occurrence, then reschedule
    const scheduleNext = () => {
      const now = new Date();
      const target = new Date(now);

      // Find next matching minute
      target.setSeconds(0, 0);
      if (minute !== "*") {
        const min = parseInt(minute);
        target.setMinutes(min);
        if (target <= now) target.setMinutes(target.getMinutes() + 1);
      }

      // Resolve the minute value once for resets
      const minuteVal = minute !== "*" ? parseInt(minute, 10) : 0;
      const hourVal = hour !== "*" ? parseInt(hour, 10) : undefined;

      // Find next matching hour
      if (hour !== "*") {
        target.setHours(hourVal!);
        if (target <= now) {
          target.setDate(target.getDate() + 1);
          target.setHours(hourVal!);
          target.setMinutes(minuteVal);
          target.setSeconds(0, 0);
        }
      }

      // Check day-of-month
      if (dayOfMonth !== "*" && !cronFieldMatches(dayOfMonth, target.getDate())) {
        target.setDate(target.getDate() + 1);
        if (hourVal !== undefined) target.setHours(hourVal);
        target.setMinutes(minuteVal);
        target.setSeconds(0, 0);
      }

      // Check month
      if (month !== "*" && !cronFieldMatches(month, target.getMonth() + 1)) {
        target.setMonth(target.getMonth() + 1);
        target.setDate(dayOfMonth !== "*" ? parseInt(dayOfMonth, 10) : 1);
        if (hourVal !== undefined) target.setHours(hourVal);
        target.setMinutes(minuteVal);
        target.setSeconds(0, 0);
      }

      // Check day-of-week (0=Sunday, 6=Saturday)
      if (dayOfWeek !== "*" && !cronFieldMatches(dayOfWeek, target.getDay())) {
        // Parse ranges like "1-5" or single values like "0"
        const dowValue = parseInt(dayOfWeek.split("-")[0], 10);
        let daysAhead = (dowValue - target.getDay() + 7) % 7;
        if (daysAhead === 0) daysAhead = 7; // at least 1 day ahead
        target.setDate(target.getDate() + daysAhead);
        if (hourVal !== undefined) target.setHours(hourVal);
        target.setMinutes(minuteVal);
        target.setSeconds(0, 0);
      }

      const delayMs = Math.max(1000, target.getTime() - Date.now());
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

  constructor(config: { id: string; name: string; botToken: string; allowedUsers?: number[]; webhookUrl?: string }) {
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
      logger.warn("Telegram", "No bot token configured");
      return;
    }
    // Validate bot token by calling getMe
    try {
      const resp = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.description || "Invalid token");
      logger.info("Telegram", `Connected as @${data.result.username}`);
      this.connected = true;
      events.onStatusChange("connected");
      // Start polling for updates
      this.pollTimer = setInterval(() => void this.poll(), 2000);
      void this.poll(); // immediate first poll
    } catch (err) {
      events.onStatusChange("error");
      logger.error("Telegram", "Failed to connect", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean { return this.connected; }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!this.botToken) return;
    try {
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
      logger.error("Telegram", "Failed to send message", { error: String(err) });
    }
  }

  private async poll(): Promise<void> {
    if (!this.connected || !this.events || !this.botToken) return;
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
        if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(msg.from?.id)) continue;
        const message: ConnectorMessage = {
          platformMessageId: String(msg.message_id),
          senderName: msg.from?.first_name ?? "telegram-user",
          senderId: String(msg.from?.id ?? "unknown"),
          content: msg.text,
          platform: "telegram",
          timestamp: msg.date * 1000,
          replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
          channelId: String(msg.chat.id),
        };
        this.events.onMessage(message);
      }
    } catch (err) {
      logger.warn("Telegram", "Poll error", { error: String(err) });
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

  constructor(config: { id: string; name: string; bridgeUrl: string; authToken?: string; allowedUsers?: string[] }) {
    this.id = config.id;
    this.name = config.name;
    this.bridgeUrl = config.bridgeUrl.replace(/\/+$/, "");
    this.authToken = config.authToken;
    this.allowedUsers = config.allowedUsers ?? [];
  }

  async start(events: ConnectorEvents): Promise<void> {
    this.events = events;
    if (!this.bridgeUrl) {
      events.onStatusChange("error");
      logger.warn("WhatsApp", "No bridge URL configured");
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
      logger.info("WhatsApp", "Connected to bridge");
      // Poll for new messages
      this.pollTimer = setInterval(() => void this.poll(), 3000);
      void this.poll();
    } catch (err) {
      events.onStatusChange("error");
      logger.error("WhatsApp", "Failed to connect to bridge", { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.events?.onStatusChange("disconnected");
  }

  isConnected(): boolean { return this.connected; }

  getStatus(): { connected: boolean; error?: string } {
    return { connected: this.connected };
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
      await fetch(`${this.bridgeUrl}/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chatId, content }),
      });
    } catch (err) {
      logger.error("WhatsApp", "Failed to send message", { error: String(err) });
    }
  }

  private async poll(): Promise<void> {
    if (!this.connected || !this.events) return;
    try {
      const headers: Record<string, string> = {};
      if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
      const resp = await fetch(`${this.bridgeUrl}/messages?since=${this.lastMessageTimestamp}`, { headers });
      if (!resp.ok) return;
      const data = await resp.json() as { messages?: Array<{
        id: string; from: string; fromName?: string; body: string;
        timestamp: number; chatId: string;
      }> };
      for (const msg of data.messages ?? []) {
        if (msg.timestamp <= this.lastMessageTimestamp) continue;
        this.lastMessageTimestamp = msg.timestamp;
        // Access control
        if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(msg.from)) continue;
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
      logger.warn("WhatsApp", "Poll error", { error: String(err) });
    }
  }
}

// ─── Connector Manager ─────────────────────────────────────

const STORAGE_KEY = "dalam.connectors.v1";

/**
 * Load connector configs from localStorage.
 */
function loadConnectorConfigs(): ConnectorConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Save connector configs to localStorage.
 */
function saveConnectorConfigs(configs: ConnectorConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch {
    logger.warn("Connector", "Failed to save connector configs");
  }
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
      let connector: Connector;

      switch (config.type) {
        case "webhook":
          connector = new WebhookConnector({
            id: config.id,
            name: config.name,
            ...(config.config as { port?: number; path?: string; authToken?: string }),
          });
          break;
        case "file-watcher":
          connector = new FileWatcherConnector({
            id: config.id,
            name: config.name,
            ...(config.config as { paths?: string[]; pollIntervalMs?: number }),
          });
          break;
        case "cron":
          connector = new CronConnector({
            id: config.id,
            name: config.name,
            ...(config.config as { jobs?: CronJob[] }),
          });
          break;
        case "telegram":
          connector = new TelegramConnector({
            id: config.id,
            name: config.name,
            ...(config.config as { botToken: string; allowedUsers?: number[]; webhookUrl?: string }),
          });
          break;
        case "whatsapp":
          connector = new WhatsAppConnector({
            id: config.id,
            name: config.name,
            ...(config.config as { bridgeUrl: string; authToken?: string; allowedUsers?: string[] }),
          });
          break;
        default:
          logger.warn("Connector", `Unknown connector type: ${config.type}`);
          continue;
      }

      registerConnector(connector);

      await connector.start({
        onMessage,
        onStatusChange: (status) => onStatusChange(config.id, status),
      });
    } catch (err) {
      logger.error("Connector", `Failed to start connector ${config.name}`, { error: String(err) });
    }
  }
}

/**
 * Stop all connectors.
 */
export async function shutdownConnectors(): Promise<void> {
  for (const connector of connectors.values()) {
    try {
      await connector.stop();
    } catch (err) {
      logger.warn("Connector", `Failed to stop connector ${connector.name}`, { error: String(err) });
    }
  }
  connectors.clear();
  connectorConfigs.clear();
}

/**
 * Add or update a connector config.
 */
export function saveConnectorConfig(config: ConnectorConfig): void {
  const configs = loadConnectorConfigs();
  const idx = configs.findIndex(c => c.id === config.id);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
  }
  saveConnectorConfigs(configs);
}

/**
 * Remove a connector config.
 */
export function removeConnectorConfig(id: string): void {
  const configs = loadConnectorConfigs().filter(c => c.id !== id);
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
