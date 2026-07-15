import type { DalamAPI, AgentSessionMode, AppSettings, ChatMessage, DiffProposal, FileNode, StreamEvent, ToolCall } from "@dalam/shared-types";
import type { TimerState } from "./safetyTimer";
import { DEFAULT_SETTINGS } from "@dalam/shared-types";
import { matchSkillInvocation, renderSkillForPrompt, loadSkillContent } from "./skills";
import { loadInstructions, formatInstructionsForPrompt } from "./instructions";
import { hookBus } from "./hookBus";
import { groupToolCallsForExecution, type ToolCall as ExecutorToolCall } from "./toolExecutor";
import { isWindows, platform } from "./platform";
import { joinPath as joinPathUtil } from "./pathUtils";
import { recordLlmCall } from "./metrics";
import { parseUsageFromChunk, recordTokenUsage } from "./costTracker";

// ---------------------------------------------------------------------------
// Debug logging — set window.__DALAM_DEBUG = true in console to enable
// ---------------------------------------------------------------------------
const _debugLog = (...args: unknown[]) => {
  try {
    if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__DALAM_DEBUG) {
      console.log("[DALAM]", ...args);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] if (typeof window !== \"undefined\" && (window as un:", e);
  }
};
import { loadGenePool, expressGenes, formatGenesForPrompt } from "./genes";

const STORAGE_KEYS = {
  settings: "dalam.settings.v1",
} as const;

const activeControllers = new Map<string, AbortController>();
const sessionStartTimes = new Map<string, number>();
const streamCallbacks = new Map<string, (event: StreamEvent) => void>();
const streamCleanups = new Map<string, () => void>();
const fileWatchers = new Map<string, () => void>();
const pendingDiffProposals = new Map<string, DiffProposal>();
export const mcpHttpSessions = new Map<string, string>();
const _mcpSessionMutexes = new Map<string, Promise<string | null>>();
const emittedSessionEnds = new Set<string>();
// Per-session rate-limit backoff counter — isolated per session so concurrent
// sessions don't interfere with each other's backoff state.
const sessionRateLimitErrors = new Map<string, number>();

// ─── MCP Stdio Connection Pool ────────────────────────────────
// Persistent stdio connections for MCP servers. Avoids spawning a new
// process per tool call — instead, connections are reused and cleaned
// up after 30 minutes of inactivity.
// Mutex to prevent parallel connection creation for the same server
const _mcpStdioMutexes = new Map<string, Promise<McpStdioConnection | null>>();
interface McpStdioConnection {
  cmd: unknown; // Tauri Command instance
  child: { write(input: string): Promise<void>; kill(): Promise<void> };
  stdoutBuffer: string;
  initialized: boolean;
  lastUsed: number;
  pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  requestIdCounter: number;
}
const _mcpStdioConnections = new Map<string, McpStdioConnection>();
const MCP_STDIO_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of idle MCP stdio connections
// Guard: only run in production/development builds, not during vitest
if (typeof setInterval !== "undefined" && import.meta.env.MODE !== "test") {
  setInterval(() => {
    const now = Date.now();
    for (const [serverName, conn] of _mcpStdioConnections) {
      if (now - conn.lastUsed > MCP_STDIO_IDLE_TIMEOUT_MS) {
        conn.child.kill().catch(() => {});
        _mcpStdioConnections.delete(serverName);
        _debugLog(`[MCP] Closed idle stdio connection: ${serverName}`);
      }
    }
  }, 60_000);
}


// ─── Internal Types ─────────────────────────────────────────
/** Shape of a provider entry from localStorage */
interface StoredProvider {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: string;
}

/** API message format for LLM providers (content can be string or multimodal parts) */
export interface ApiMessage {
  role: string;
  content: string | ApiContentPart[];
}

/** Content part for multimodal messages (OpenAI image_url, Anthropic image) */
interface ApiContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  source?: { type: string; media_type: string; data: string };
}

/** Minimal interface for the @tauri-apps/plugin-sql Database instance */
interface TerminalChild {
  write(input: string): Promise<void>;
  kill(): Promise<void>;
}

/** Anthropic-style content block from API response */
interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

// joinPath imported from pathUtils — use joinPathUtil to distinguish
// function joinPathUtil(...parts: string[]): string {
//   return parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
// }

/**
 * Scope-safe wrapper for Tauri's `exists()` function.
 * Catches "forbidden path" errors from Tauri's scope system and returns false
 * instead of throwing. This allows the app to gracefully handle workspaces
 * that haven't been granted filesystem scope yet.
 */
export async function scopeSafeExists(path: string): Promise<boolean> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch (e) {
    // Tauri throws "forbidden path" when the path is not in the allowed scope
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      return false;
    }
    throw e;
  }
}

/**
 * Scope-safe wrapper for Tauri's `mkdir()` function.
 * Catches "forbidden path" errors and returns false instead of throwing.
 */
export async function scopeSafeMkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<boolean> {
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(path, options);
    return true;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      return false;
    }
    throw e;
  }
}

/**
 * Scope-safe wrapper for Tauri's `writeTextFile()` function.
 * Catches "forbidden path" errors and returns false instead of throwing.
 */
export async function scopeSafeWriteFile(
  path: string,
  contents: string,
): Promise<boolean> {
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, contents);
    return true;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      return false;
    }
    throw e;
  }
}

/**
 * Scope-safe wrapper for Tauri's `readTextFile()` function.
 * Catches "forbidden path" errors and returns null instead of throwing.
 */
export async function scopeSafeReadFile(path: string): Promise<string | null> {
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes("forbidden") || msg.includes("scope")) {
      return null;
    }
    throw e;
  }
}

function dirname(p: string): string {
  if (!p) return "";
  const posix = p.replace(/\\/g, "/");
  const idx = posix.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return posix.slice(0, idx);
}

export function getRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem("dalam.recentFiles.v1");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] getRecentFiles:", e);
    return [];
  }
}

function addRecentFile(path: string) {
  const recent = getRecentFiles().filter((f) => f !== path);
  recent.unshift(path);
  localStorage.setItem("dalam.recentFiles.v1", JSON.stringify(recent.slice(0, 20)));
}

function getStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] const raw = localStorage.getItem(STORAGE_KEYS.sett:", e);
  }
  return { ...DEFAULT_SETTINGS };
}

function storeSettings(s: AppSettings) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(s));
}

function getProviderConfig(providerId: string): { baseUrl: string; apiKey: string; apiFormat: string } | null {
  try {
    // Try individual provider config first (custom providers saved by saveProviders)
    const raw = localStorage.getItem(`dalam.provider.${providerId}`);
    if (raw) return JSON.parse(raw);
    // Fall back to reading from the providers array
    const providersRaw = localStorage.getItem("dalam.providers.v1");
    if (providersRaw) {
      const providers = JSON.parse(providersRaw);
      const provider = providers.find((p: StoredProvider) => p.id === providerId);
      if (!provider?.baseUrl || !provider?.apiKey) return null;
      return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat };
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] const raw = localStorage.getItem(`dalam.provider.$:", e);
  }
  return null;
}

export class ProviderError extends Error {
  constructor(message: string, public code: "auth" | "credit" | "network" | "provider" | "timeout" | "validation") {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Shared helper to resolve the active provider configuration.
 * Used by sendPrompt, summarizeMessages, and tool handlers.
 */
export function getActiveProvider(requireModel = true): {
  settings: AppSettings;
  providerId: string;
  modelId: string;
  config: { baseUrl: string; apiKey: string; apiFormat: string };
} {
  const settings = getStoredSettings();
  const providerId = settings.selectedProvider;
  const modelId = settings.selectedModel;

  if (!providerId || (requireModel && !modelId)) {
    throw new ProviderError("No provider configured. Add one in Settings.", "provider");
  }
  const config = getProviderConfig(providerId);
  if (!config) {
    throw new ProviderError(`Provider "${providerId}" not configured. Check settings.`, "provider");
  }
  return { settings, providerId, modelId: modelId ?? "", config };
}

/**
 * Parse SSE (Server-Sent Events) data from a buffer.
 * Normalizes CRLF/LF, finds complete `data:` events delimited by blank lines,
 * and returns parsed events plus the raw unconsumed portion (for incremental streaming).
 *
 * This is pure — no cursor/state. The caller trims the buffer via `buffer = remaining`,
 * which naturally keeps per-call work proportional to new data (O(n), not O(n²)).
 */
function parseSSEEvents(buffer: string): { parsed: { data: string }[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const parsed: { data: string }[] = [];
  let currentData = "";
  let lastCompleteIdx = 0;
  let incompleteEventStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      if (currentData) {
        if (currentData !== "[DONE]") parsed.push({ data: currentData });
        currentData = "";
      }
      lastCompleteIdx = i + 1;
      incompleteEventStart = -1;
    } else if (line.startsWith(":")) {
      lastCompleteIdx = i + 1;
    } else if (line.startsWith("data:")) {
      if (incompleteEventStart === -1) incompleteEventStart = i;
      const dataContent = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      currentData += (currentData ? "\n" : "") + dataContent;
    }
  }

  const remaining = incompleteEventStart >= 0
    ? lines.slice(incompleteEventStart).join("\n")
    : lines.slice(lastCompleteIdx).join("\n");
  return { parsed, remaining };
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry non-retryable errors (auth, credit, validation, abort)
      if (err instanceof ProviderError && (err.code === "auth" || err.code === "credit" || err.code === "validation")) {
        throw err;
      }
      if (lastError.name === "AbortError") {
        throw err;
      }
      // Classify error for retry decision
      const isRetryable = isRetryableError(lastError.message);
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      // Exponential backoff with jitter and retry-after support
      const retryAfterMs = extractRetryAfter(lastError.message);
      const delay = retryAfterMs ?? (baseDelayMs * Math.pow(2, attempt) + Math.random() * 500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

/**
 * Check if an error message indicates a retryable condition.
 * Matches OpenCode's retryableStatus pattern (429, 503, 504, 529).
 */
function isRetryableError(message: string): boolean {
  const retryablePatterns = [
    /429/, /503/, /504/, /529/,           // HTTP status codes
    /rate.?limit/i, /too.?many.?requests/i, // Rate limiting
    /timeout/i, /timed.?out/i,              // Timeouts
    /ECONNRESET/, /ETIMEDOUT/, /EPIPE/,    // Network errors
    /network/i, /connection/i,              // Connection issues
    /overloaded/i, /busy/i,                 // Server overloaded
  ];
  return retryablePatterns.some(p => p.test(message));
}

/**
 * Extract retry-after duration from error message.
 * Matches OpenCode's retryAfterMs pattern.
 */
function extractRetryAfter(message: string): number | null {
  // Check milliseconds FIRST to avoid matching 's' in 'ms' as seconds
  const msMatch = message.match(/retry[_\s-]?after[_\s:]*(\d+)\s*ms/i);
  if (msMatch) return parseInt(msMatch[1], 10);
  // Then check seconds — use negative lookahead to reject 'ms'
  const secondsMatch = message.match(/retry[_\s-]?after[_\s:]*(\d+)\s*(?:sec(ond)?|s(?!ec))\b/i);
  if (secondsMatch) return parseInt(secondsMatch[1], 10) * 1000;
  return null;
}

/**
 * CORS-free fetch using Tauri's HTTP plugin (bypasses browser CORS restrictions).
 * Falls back to browser fetch if the plugin is unavailable.
 */
export async function corsFetch(url: string, options: RequestInit): Promise<Response> {
  // Try Tauri plugin HTTP first; fall back to browser fetch when the plugin
  // is unavailable or its runtime environment isn't available (vitest/JSDOM).
  // Real network/protocol errors from the plugin propagate normally.
  let tauriFetch: (url: string, opts: Record<string, unknown>) => Promise<{
    ok: boolean; status: number; statusText: string; headers: Headers | Record<string, string>;
    body: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  try {
    ({ fetch: tauriFetch } = await import("@tauri-apps/plugin-http"));
  } catch {
    return fetch(url, options);
  }
  try {
    const resp = await tauriFetch(url, {
      method: options.method as string || "GET",
      headers: options.headers as Record<string, string> || {},
      body: options.body as string | undefined,
      signal: options.signal,
    });
    const respHeaders = new Headers();
    if (resp.headers instanceof Headers) {
      resp.headers.forEach((v, k) => respHeaders.set(k, v));
    } else if (resp.headers) {
      for (const [k, v] of Object.entries(resp.headers as Record<string, string>)) respHeaders.set(k, v);
    }
    let bodyPromise: Promise<ArrayBuffer> | null = null;
    const getBody = (): Promise<ArrayBuffer> => {
      if (!bodyPromise) bodyPromise = resp.arrayBuffer();
      return bodyPromise;
    };
    
    const cloneResponse = (): Response => {
      if (bodyPromise) {
        const stream = new ReadableStream({
          async start(controller) {
            const buf = await bodyPromise!;
            controller.enqueue(new Uint8Array(buf));
            controller.close();
          },
        });
        return new Response(stream, { status: resp.status, statusText: resp.statusText, headers: respHeaders });
      }
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: respHeaders });
    };
    
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      type: "basic" as ResponseType,
      url: url,
      redirected: false,
      headers: respHeaders,
      body: resp.body,
      text: async () => new TextDecoder().decode(await getBody()),
      json: async () => JSON.parse(new TextDecoder().decode(await getBody())),
      arrayBuffer: getBody,
      clone: cloneResponse,
    } as Response;
  } catch (e) {
    // Plugin module loaded but its runtime (window.__TAURI__) isn't available
    if (e instanceof ReferenceError || (e as Error)?.message?.includes("window")) {
      if (import.meta.env.DEV) console.warn("[DALAM] corsFetch runtime fallback:", e);
      return fetch(url, options);
    }
    throw e;
  }
}

/**
 * Wraps a fetch call with retry-with-backoff for transient network/5xx errors.
 * Classifies the response into a ProviderError and retries on transient failures.
 * Non-transient errors (auth 401, credit 402) are thrown immediately.
 * Rate limits (429) are retried with backoff.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  baseDelayMs = 1000,
  signal?: AbortSignal
): Promise<Response> {
  return retryWithBackoff(async () => {
    const resp = await corsFetch(url, { ...options, signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) throw new ProviderError("Authentication failed. Check your API key.", "auth");
      if (resp.status === 403) throw new ProviderError("Access forbidden. Check your API key and permissions.", "auth");
      if (resp.status === 402) throw new ProviderError("Insufficient credits.", "credit");
      if (resp.status === 429) throw new ProviderError(`Rate limited. ${text.slice(0, 200)}`, "network");
      if (resp.status >= 500) throw new ProviderError(`Provider error (${resp.status}): ${text.slice(0, 200)}`, "provider");
      // Client errors (400, 404, etc.) are permanent — don't retry them
      if (text.includes("DEGRADED")) {
        throw new ProviderError(`Model temporarily unavailable (DEGRADED). The endpoint may be under maintenance. Try again later or switch to a different model.`, "provider");
      }
      throw new ProviderError(`HTTP ${resp.status}: ${text.slice(0, 200)}`, "validation");
    }
    return resp;
  }, maxRetries, baseDelayMs);
}

/**
 * Wraps a non-streaming fetch call with retry for non-GET requests.
 */
async function fetchJsonWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  baseDelayMs = 1000
): Promise<unknown> {
  return retryWithBackoff(async () => {
    const resp = await corsFetch(url, options);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) throw new ProviderError("Authentication failed. Check your API key.", "auth");
      if (resp.status === 403) throw new ProviderError("Access forbidden. Check your API key and permissions.", "auth");
      if (resp.status === 402 || resp.status === 429) throw new ProviderError("Insufficient credits or rate limited.", "credit");
      if (text.includes("DEGRADED")) {
        throw new ProviderError("Model temporarily unavailable (DEGRADED). Try again later or switch to a different model.", "provider");
      }
      throw new ProviderError(`Failed to summarize: HTTP ${resp.status} - ${text.slice(0, 300)}`, "provider");
    }
    return resp.json();
  }, maxRetries, baseDelayMs);
}

/** Build an XML tag from a completed tool call name + parsed JSON args */
function _emitToolCallXml(tcName: string, parsedArgs: Record<string, unknown>): string {
  const attrs = Object.entries(parsedArgs)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')}"`)
    .join(" ");
  const bodyTools = ["write_file", "clipboard_write", "memory_save"];
  if (bodyTools.includes(tcName) && parsedArgs.content) {
    const contentStr = typeof parsedArgs.content === "string" ? parsedArgs.content : "";
    const escapedContent = contentStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bodyAttrs = Object.entries(parsedArgs)
      .filter(([k, v]) => k !== "content" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')}"`)
      .join(" ");
    return `<${tcName} ${bodyAttrs}>${escapedContent}</${tcName}>`;
  }
  if (tcName === "edit_file" && parsedArgs.search && parsedArgs.replace !== undefined) {
    const occAttr = parsedArgs.occurrence ? ` occurrence="${parsedArgs.occurrence}"` : "";
    const escapedPath = String(parsedArgs.path || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const escapedSearch = String(parsedArgs.search).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
    const escapedReplace = String(parsedArgs.replace).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
    return `<${tcName} path="${escapedPath}"${occAttr}>\n<search>${escapedSearch}</search>\n<replace>${escapedReplace}</replace>\n</${tcName}>`;
  }
  return attrs ? `<${tcName} ${attrs}/>` : `<${tcName}/>`;
}

async function* streamOpenAI(
  baseUrl: string, apiKey: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (maxTokens !== undefined && maxTokens !== null) body.max_tokens = maxTokens;
  _debugLog(`[streamOpenAI] POST ${url} model=${model} messages=${messages.length} maxTokens=${maxTokens}`);
  let resp: Response;
  try {
    const fetchAbortController = new AbortController();
    const fetchTimeoutId = setTimeout(() => fetchAbortController.abort(), 120_000);
    if (signal) {
      signal.addEventListener("abort", () => fetchAbortController.abort());
    }
    try {
      resp = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      }, 2, 1000, fetchAbortController.signal);
    } finally {
      clearTimeout(fetchTimeoutId);
    }
  } catch (err) {
    _debugLog(`[streamOpenAI] fetchWithRetry failed:`, err);
    throw err;
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new ProviderError("No response body", "network");
  const decoder = new TextDecoder();
  let buffer = "";
  const STREAM_READ_TIMEOUT_MS = 60_000; // 60s per read — detect hung streams
  let lastTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearLastTimeout = () => { if (lastTimeout !== undefined) { clearTimeout(lastTimeout); lastTimeout = undefined; } };
  // Register abort listener ONCE to avoid accumulating listeners per iteration
  let currentClearFn: (() => void) | undefined;
  let abortHandlerOpenAI: (() => void) | null = null;
  if (signal) {
    abortHandlerOpenAI = () => {
      currentClearFn?.();
      try { void reader.cancel(); } catch { /* reader may already be closed */ }
    };
    signal.addEventListener("abort", abortHandlerOpenAI, { once: true });
  }

  // Tool call argument accumulation: OpenAI-compatible providers stream
  // function.arguments incrementally across SSE chunks (e.g. "{\"path\": \"/" then "etc/file\"}").
  // We must accumulate partial JSON by tool_call index before parsing.
  const _tcArgBuffers = new Map<number, { name: string; args: string }>();

  function jsonBracesBalanced(s: string): boolean {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      if (escaped) { escaped = false; continue; }
      const c = s[i];
      if (c === '\\' && inString) { escaped = true; continue; }
      if (c === '"' && !escaped) { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (depth < 0) return false;
    }
    return depth === 0 && !inString;
  }

  // Uses module-level _emitToolCallXml

  try {
    while (true) {
      clearLastTimeout();
      // Race reader.read() against a timeout to detect hung streams
      currentClearFn = clearLastTimeout;
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          lastTimeout = setTimeout(() => reject(new ProviderError("Stream read timed out (60s no data)", "network")), STREAM_READ_TIMEOUT_MS);
        }),
      ]);
      const { done, value } = readResult;
      if (done) {
        clearLastTimeout();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { parsed, remaining } = parseSSEEvents(buffer);
      buffer = remaining;
      for (const part of parsed) {
        try {
          if (part.data === "[DONE]") continue;
          const json = JSON.parse(part.data);
          if (json.error) {
            const errMsg = typeof json.error === "string" ? json.error : (json.error.message || JSON.stringify(json.error));
            _debugLog(`[streamOpenAI] Provider error: ${errMsg}`);
            throw new ProviderError(errMsg, "provider");
          }
          if (json.object === "error" || (json.code && json.message)) {
            const errMsg = json.message || JSON.stringify(json);
            _debugLog(`[streamOpenAI] API error: ${errMsg}`);
            throw new ProviderError(errMsg, "provider");
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
          if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
          if (json.usage) {
            const usage = parseUsageFromChunk(json);
            if (usage) yield { type: "usage" as const, usage };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index === undefined) continue; // skip malformed chunks without index
              const tcIdx = tc.index;
              const fn = tc.function;
              if (fn?.name) {
                const existing = _tcArgBuffers.get(tcIdx);
                if (existing) {
                  existing.args += fn.arguments || "";
                } else {
                  _tcArgBuffers.set(tcIdx, { name: fn.name, args: fn.arguments || "" });
                }
                const buf = _tcArgBuffers.get(tcIdx)!;
                if (jsonBracesBalanced(buf.args)) {
                  try {
                    const parsedArgs = JSON.parse(buf.args);
                    _tcArgBuffers.delete(tcIdx);
                    const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
                    yield { type: "message-delta", messageId: json.id || "", content: "\n" + xmlTag + "\n" };
                  } catch (e) {
                    _debugLog(`[streamOpenAI] Failed to parse tool call args for ${buf.name}:`, e);
                  }
                }
              }
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          _debugLog(`[streamOpenAI] SSE parse warning:`, e);
        }
      }
    }
    // Process any remaining buffered data
    if (buffer.trim()) {
      const { parsed } = parseSSEEvents(buffer + "\n\n");
      for (const part of parsed) {
        try {
          if (part.data === "[DONE]") continue;
          const json = JSON.parse(part.data);
          if (json.error) {
            const errMsg = typeof json.error === "string" ? json.error : (json.error.message || JSON.stringify(json.error));
            _debugLog(`[streamOpenAI] Buffer flush provider error: ${errMsg}`);
            throw new ProviderError(errMsg, "provider");
          }
          if (json.object === "error" || (json.code && json.message)) {
            const errMsg = json.message || JSON.stringify(json);
            _debugLog(`[streamOpenAI] Buffer flush API error: ${errMsg}`);
            throw new ProviderError(errMsg, "provider");
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
          if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
          if (json.usage) {
            const usage = parseUsageFromChunk(json);
            if (usage) yield { type: "usage" as const, usage };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index === undefined) continue; // skip malformed chunks without index
              const tcIdx = tc.index;
              const fn = tc.function;
              if (fn?.name) {
                const existing = _tcArgBuffers.get(tcIdx);
                if (existing) {
                  existing.args += fn.arguments || "";
                } else {
                  _tcArgBuffers.set(tcIdx, { name: fn.name, args: fn.arguments || "" });
                }
                const buf = _tcArgBuffers.get(tcIdx)!;
                if (jsonBracesBalanced(buf.args)) {
                  try {
                    const parsedArgs = JSON.parse(buf.args);
                    _tcArgBuffers.delete(tcIdx);
                    const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
                    yield { type: "message-delta", messageId: json.id || "", content: "\n" + xmlTag + "\n" };
                  } catch (e) {
                    _debugLog(`[streamOpenAI] Failed to parse tool call args for ${buf.name}:`, e);
                  }
                }
              }
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          _debugLog(`[streamOpenAI] Buffer flush SSE parse warning:`, e);
        }
      }
    }
    // Flush any remaining incomplete tool call buffers (emit with whatever args we have)
    for (const [, buf] of _tcArgBuffers) {
      if (!buf.args || !buf.args.trim()) continue; // skip empty buffers
      try {
        const parsedArgs = JSON.parse(buf.args || "{}")
        const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
        yield { type: "message-delta", messageId: "", content: "\n" + xmlTag + "\n" };
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] JSON parse:", e);
        // Emit as raw text fallback so the tool call isn't silently dropped
        yield { type: "message-delta", messageId: "", content: "\n<" + buf.name + ">" + buf.args + "</" + buf.name + ">\n" };
      }
    }
    _tcArgBuffers.clear();
  } finally {
    _tcArgBuffers.clear();
    reader.releaseLock();
    if (abortHandlerOpenAI && signal) {
      signal.removeEventListener("abort", abortHandlerOpenAI);
    }
  }
}

async function* streamAnthropic(
  baseUrl: string, apiKey: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  // Combine ALL system messages (first is system prompt, second may be compaction summary)
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const systemMsg = systemParts.join("\n\n");
  const chatMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, system: systemMsg, messages: chatMessages, stream: true, max_tokens: maxTokens || 16384 };
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  }, 2, 1000, signal);
  const reader = resp.body?.getReader();
  if (!reader) throw new ProviderError("No response body", "network");
  const decoder = new TextDecoder();
  let buffer = "";
  let msgId = "";
  const STREAM_READ_TIMEOUT_MS = 60_000;
  let lastReadTimer: ReturnType<typeof setTimeout> | undefined;
  const clearLastTimer = () => { if (lastReadTimer !== undefined) { clearTimeout(lastReadTimer); lastReadTimer = undefined; } };
  let currentClearFnAnth: (() => void) | undefined;
  let abortHandlerAnthropic: (() => void) | null = null;
  if (signal) {
    abortHandlerAnthropic = () => {
      currentClearFnAnth?.();
      reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abortHandlerAnthropic, { once: true });
  }
  // Tool call accumulation for Anthropic native tool calling
  const _anthropicToolBuffers = new Map<string, { name: string; args: string }>();
  _debugLog("[streamAnthropic] Starting stream, url:", url);
  try {
    while (true) {
      clearLastTimer();
      currentClearFnAnth = clearLastTimer;
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          lastReadTimer = setTimeout(() => reject(new ProviderError("Stream read timed out (60s no data)", "network")), STREAM_READ_TIMEOUT_MS);
        }),
      ]);
      const { done, value } = readResult;
      if (done) {
        clearLastTimer();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { parsed, remaining } = parseSSEEvents(buffer);
      buffer = remaining;
      for (const part of parsed) {
        try {
          const json = JSON.parse(part.data);
          if (json.type === "error") {
            throw new ProviderError(json.error?.message || "Anthropic stream error", "provider");
          }
          if (json.type === "message_start") { msgId = json.message?.id || ""; }
          if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
            const toolName = json.content_block.name || "";
            _anthropicToolBuffers.set(json.content_block.id, { name: toolName, args: "" });
          }
          if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta" && json.content_block_id) {
            const buf = _anthropicToolBuffers.get(json.content_block_id);
            if (buf) buf.args += json.delta.partial_json || "";
          }
          if (json.type === "content_block_stop" && json.content_block_id) {
            const buf = _anthropicToolBuffers.get(json.content_block_id);
            if (buf) {
              try {
                const parsedArgs = JSON.parse(buf.args || "{}");
                const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
                yield { type: "message-delta", messageId: msgId, content: "\n" + xmlTag + "\n" };
              } catch (e) {
                if (import.meta.env.DEV) console.warn("[DALAM] JSON parse:", e);
                yield { type: "message-delta", messageId: msgId, content: "\n<" + buf.name + ">" + buf.args + "</" + buf.name + ">\n" };
              }
              _anthropicToolBuffers.delete(json.content_block_id);
            }
          }
          if (json.type === "content_block_delta" && json.delta?.text) {
            yield { type: "message-delta", messageId: msgId, content: json.delta.text };
          }
          if (json.type === "content_block_delta" && json.delta?.thinking) {
            yield { type: "activity-think", content: json.delta.thinking };
          }
          // Anthropic usage comes in the message_delta event at stream end
          if (json.type === "message_delta" && json.usage) {
            const usage = parseUsageFromChunk({ usage: json.usage });
            if (usage) yield { type: "usage" as const, usage };
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          console.warn("SSE parse error (Anthropic):", e);
        }
      }
    }
    // Process any remaining buffered data
    if (buffer.trim()) {
      const { parsed } = parseSSEEvents(buffer + "\n\n");
      for (const part of parsed) {
        try {
          const json = JSON.parse(part.data);
          if (json.type === "error") {
            throw new ProviderError(json.error?.message || "Anthropic stream error", "provider");
          }
          if (json.type === "content_block_delta" && json.delta?.text) {
            yield { type: "message-delta", messageId: msgId, content: json.delta.text };
          }
          if (json.type === "content_block_delta" && json.delta?.thinking) {
            yield { type: "activity-think", content: json.delta.thinking };
          }
          if (json.type === "message_delta" && json.usage) {
            const usage = parseUsageFromChunk({ usage: json.usage });
            if (usage) yield { type: "usage" as const, usage };
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          console.warn("SSE parse error (Anthropic):", e);
        }
      }
    }
    // Flush remaining Anthropic tool buffers
    for (const [, buf] of _anthropicToolBuffers) {
      try {
        const parsedArgs = JSON.parse(buf.args || "{}");
        const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
        yield { type: "message-delta", messageId: msgId, content: "\n" + xmlTag + "\n" };
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] JSON parse:", e);
        yield { type: "message-delta", messageId: msgId, content: "\n<" + buf.name + ">" + buf.args + "</" + buf.name + ">\n" };
      }
    }
    _anthropicToolBuffers.clear();
  } finally {
    reader.releaseLock();
    if (abortHandlerAnthropic && signal) {
      signal.removeEventListener("abort", abortHandlerAnthropic);
    }
  }
}

export async function* streamChat(
  baseUrl: string, apiKey: string, apiFormat: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  _debugLog(`[streamChat] apiFormat=${apiFormat} model=${model} baseUrl=${baseUrl} messages=${messages.length} maxTokens=${maxTokens}`);
  if (apiFormat === "anthropic") {
    yield* streamAnthropic(baseUrl, apiKey, model, messages, signal, maxTokens);
  } else {
    yield* streamOpenAI(baseUrl, apiKey, model, messages, signal, maxTokens);
  }
}

export const JUNK_DIRS = new Set([".git", "node_modules", "__pycache__", ".next", ".nuxt", "dist", "build", ".turbo", ".cache", ".vscode", ".idea", "coverage", ".output"]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".gitkeep"]);

async function readDirRecursive(dirPath: string, maxDepth: number = 20, maxFiles: number = 10000, _count: { n: number } = { n: 0 }, _visited: Set<string> = new Set()): Promise<FileNode[]> {
  if (_visited.has(dirPath)) return [];
  _visited.add(dirPath);
  if (_count.n >= maxFiles) return [];
  const { readDir, stat } = await import("@tauri-apps/plugin-fs");
  let entries;
  try {
    entries = await readDir(dirPath);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] readDir(dirPath);:", e);
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (_count.n >= maxFiles) break;
    if (!entry.name) continue;
    if (JUNK_FILES.has(entry.name)) continue;
    if (entry.isDirectory && JUNK_DIRS.has(entry.name)) continue;
    const fullPath = joinPathUtil(dirPath, entry.name!);
    if (entry.isDirectory) {
      // Check for symlinks by comparing real path
      // Skip if the resolved real path differs from the logical path
      try {
        const fileInfo = await stat(fullPath);
        const info = fileInfo as { isSymlink?: boolean; realpath?: string };
        if (info.isSymlink || (info.realpath && info.realpath !== fullPath)) {
          continue;
        }
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] stat(fullPath);:", e);
        // if stat fails, skip to be safe
        continue;
      }
      const children = maxDepth > 1 ? await readDirRecursive(fullPath, maxDepth - 1, maxFiles, _count, _visited) : [];
      nodes.push({ name: entry.name!, path: fullPath, type: "directory", gitStatus: null, children });
    } else {
      _count.n++;
      nodes.push({ name: entry.name!, path: fullPath, type: "file", gitStatus: null });
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    const aDot = a.name.startsWith(".");
    const bDot = b.name.startsWith(".");
    if (aDot !== bDot) return aDot ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function createDalamAPI(): DalamAPI {
  return dalamAPI;
}

const dalamAPI: DalamAPI = {
  fs: {
    async readFile(path) {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const textExts = new Set(["ts", "tsx", "js", "jsx", "json", "md", "mdx", "py", "rs", "css", "html", "yml", "yaml", "toml", "txt", "csv", "xml", "svg", "sh", "bash", "zsh", "fish", "sql", "graphql", "prisma", "env", "gitignore", "dockerignore", "editorconfig", "prettierrc", "eslintrc"]);
      if (textExts.has(ext)) {
        return new TextDecoder().decode(bytes);
      }
      // For unknown or binary extensions, try UTF-8 decode — if it contains
      // null bytes or excessive replacement chars, treat as binary and return
      // a placeholder.
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (decoded.includes("\0") || (decoded.match(/\uFFFD/g)?.length ?? 0) > bytes.length * 0.01) {
        return `[Binary file: ${path.split("/").pop()} — ${bytes.length} bytes]`;
      }
      return decoded;
    },
    async writeFile(path, content) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, new TextEncoder().encode(content));
      addRecentFile(path);
    },
    async listDir(path) {
      if (!path || path === "") {
        return [];
      }
      return readDirRecursive(path);
    },
    async createFile(parentPath, name) {
      const { writeFile, exists } = await import("@tauri-apps/plugin-fs");
      const fullPath = joinPathUtil(parentPath, name);
      if (!(await exists(fullPath))) await writeFile(fullPath, new Uint8Array());
      return { name, path: fullPath, type: "file" };
    },
    async createDirectory(parentPath, name) {
      const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
      const fullPath = joinPathUtil(parentPath, name);
      if (!(await exists(fullPath))) await mkdir(fullPath);
      return { name, path: fullPath, type: "directory" };
    },
    async deletePath(path) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(path, { recursive: true });
      // Close any open tabs for files under this path
      try {
        const { useWorkspace } = await import("../store/useAppStore");
        const { openTabs, closeTab } = useWorkspace.getState();
        for (const tab of openTabs) {
          if (tab.path === path || tab.path.startsWith(path + "/") || tab.path.startsWith(path + "\\")) {
            closeTab(tab.path);
          }
        }
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
      }
    },
    async renamePath(path, newName) {
      const { rename, readFile, writeFile: fsWriteFile, remove: fsRemove } = await import("@tauri-apps/plugin-fs");
      const parentDir = dirname(path);
      const newPath = joinPathUtil(parentDir, newName);
      try {
        await rename(path, newPath);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] rename(path, newPath);:", e);
        const bytes = await readFile(path);
        await fsWriteFile(newPath, bytes);
        await fsRemove(path);
      }
      // Update open tabs to reflect the new path
      try {
        const { useWorkspace } = await import("../store/useAppStore");
        const { closeTab, setActiveFile } = useWorkspace.getState();
        const wasActive = useWorkspace.getState().activeFilePath === path;
        closeTab(path);
        if (wasActive) setActiveFile(newPath);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
      }
    },
    async watchPath(path: string, sessionId?: string) {
      const { watchImmediate } = await import("@tauri-apps/plugin-fs");
      try {
        const unwatch = await watchImmediate(path, (_event) => {
        });
        // Store with composite key for session-scoped cleanup
        const key = sessionId ? `${sessionId}:${path}` : path;
        fileWatchers.set(key, unwatch);
      } catch (e) {
        console.warn("[FileWatch] Failed to watch path:", path, e);
      }
    },
  },

  terminal: (() => {
    const processes = new Map<string, { child: TerminalChild; command: unknown }>();
    const listeners = new Map<string, Set<(data: string) => void>>();
    const pendingErrors = new Map<string, string>();

    return {
      async create(cwd?: string, shell?: string) {
        const id = "t-" + crypto.randomUUID();
        try {
          const { Command } = await import("@tauri-apps/plugin-shell");
          // Use provided shell or default to platform-appropriate shell
          const knownShells = ["bash", "zsh", "fish", "powershell", "cmd", "pwsh"];
          const shellCmd = shell && knownShells.includes(shell) ? shell : (isWindows() ? "powershell" : "bash");

          const currentSettings = getStoredSettings();
          const args: string[] = [];
          if (currentSettings.inheritSystemTerminal && (shellCmd === "zsh" || shellCmd === "bash")) {
            args.push("-l");
          }

          const env: Record<string, string> = {};
          if (currentSettings.httpProxy) {
            env.HTTP_PROXY = currentSettings.httpProxy;
            env.HTTPS_PROXY = currentSettings.httpProxy;
            env.http_proxy = currentSettings.httpProxy;
            env.https_proxy = currentSettings.httpProxy;
          }

          const command = Command.create(shellCmd, args, {
            cwd: cwd ?? undefined,
            env: Object.keys(env).length > 0 ? env : undefined
          });
          const cbs = new Set<(data: string) => void>();
          listeners.set(id, cbs);

          command.stdout.on("data", (data: string) => {
            cbs.forEach((cb) => cb(data));
          });
          command.stderr.on("data", (data: string) => {
            cbs.forEach((cb) => cb(data));
          });
          command.on("error", (error: string) => {
            cbs.forEach((cb) => cb(`\x1b[31m${error}\x1b[0m\r\n`));
          });
          command.on("close", () => {
            cbs.forEach((cb) => cb("\r\n[process exited]\r\n"));
            processes.delete(id);
            listeners.delete(id);
          });

          const child = await command.spawn();
          processes.set(id, { child, command });
        } catch (err) {
          const termListeners = new Set<(data: string) => void>();
          listeners.set(id, termListeners);
          const errMsg = `\x1b[31mFailed to start shell: ${(err as Error)?.message ?? String(err)}\x1b[0m\r\n`;
          pendingErrors.set(id, errMsg);
        }
        return id;
      },

      async writeInput(id: string, input: string) {
        const proc = processes.get(id);
        if (proc) await proc.child.write(input);
      },

      async resize(_id: string, _cols: number, _rows: number) {
        // Tauri shell plugin doesn't support PTY resize — xterm handles display.
        // Terminal content may wrap incorrectly until this is addressed upstream.
        console.warn("[Terminal] resize called but PTY resize is not supported by Tauri shell plugin");
      },

      async kill(id: string) {
        const proc = processes.get(id);
        if (proc) {
          await proc.child.kill();
          processes.delete(id);
        }
      },

      onData(id: string, cb: (data: string) => void): () => void {
        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id)!.add(cb);
        // Replay buffered error message if terminal failed before listener was registered
        const pending = pendingErrors.get(id);
        if (pending) {
          cb(pending);
          pendingErrors.delete(id);
        }
        return () => { listeners.get(id)?.delete(cb); };
      },
    };
  })(),

  agent: {
    async startSession(options: { workspacePath: string; model: string; mode: AgentSessionMode }) {
      const sessionId = "ses-" + crypto.randomUUID();
      sessionStartTimes.set(sessionId, Date.now());
      // Hook: SessionStart
      await hookBus.emit("SessionStart", {
        sessionId,
        workspacePath: options.workspacePath,
        model: options.model,
        agentName: options.mode,
        mode: options.mode,
        timestamp: Date.now(),
      });
      return { sessionId };
    },
    async sendPrompt(sessionId, prompt, conversationHistory?, agentName?, attachments?) {
      const { settings, providerId, modelId, config } = getActiveProvider();

      // Multi-model routing: select model based on prompt complexity
      let activeModelId = modelId;
      let activeConfig = config;
      if (settings.autoRouteModels && settings.modelProfiles && settings.modelProfiles.length > 0) {
        const { selectModelForPrompt } = await import("./modelRouter");
        const routed = selectModelForPrompt(prompt, settings.modelProfiles, modelId);
        if (routed.modelId !== modelId && routed.providerId) {
          const routedConfig = getProviderConfig(routed.providerId);
          if (routedConfig) {
            activeModelId = routed.modelId;
            activeConfig = routedConfig;
            _debugLog(`[sendPrompt] Auto-routed to ${activeModelId} (complexity: ${routed.complexity})`);
          }
        }
      }

      /** Assemble the system prompt and context blocks for the LLM. */
      async function assembleContext(cleanPrompt: string): Promise<string> {
        const { useChat, useSkillsMcp, useWorkspace } = await import("../store/useAppStore");
        const skillsState = useSkillsMcp.getState();
        const enabledSkills = skillsState.skills.filter((sk) => sk.enabled);

        const skillInfos = enabledSkills.map((sk) => ({
          name: sk.name,
          description: sk.description,
          content: sk.prompt,
          location: sk.source === "bundled" ? `bundled://${sk.name}/SKILL.md` : `user://${sk.name}/SKILL.md`,
          source: (sk.source === "bundled" ? "bundled" : sk.source === "project" ? "project" : "user-global") as "bundled" | "project" | "user-global" | "user-workspace",
        }));

        const matched = matchSkillInvocation(cleanPrompt, skillInfos);
        let activeSkillPrompt = "";
        if (matched) {
          if (!matched.skill.content) {
            matched.skill.content = await loadSkillContent(matched.skill, { readFile: dalamAPI.fs.readFile });
          }
          activeSkillPrompt = renderSkillForPrompt(matched.skill);
        }

        // Active MCP tools documentation
        const mcpServers = skillsState.mcpServers.filter((m) => m.enabled && m.status === "connected");
        let mcpToolsDocumentation = "";
        if (mcpServers.length > 0) {
          const MCP_DOC_CHARS_MAX = 5000;
          mcpToolsDocumentation = "\n\n=== CONNECTED MCP TOOLS ===\nYou have access to external tools provided by connected MCP servers. To call an MCP tool, output an XML tag of the form:\n<mcp_<server_name>_<tool_name> [args] />\n\nAvailable MCP Tools:\n";
          for (const server of mcpServers) {
            if (server.tools && server.tools.length > 0 && mcpToolsDocumentation.length < MCP_DOC_CHARS_MAX) {
              mcpToolsDocumentation += `\nFrom MCP Server "${server.name}":\n`;
              for (const tool of server.tools) {
                if (mcpToolsDocumentation.length >= MCP_DOC_CHARS_MAX) {
                  mcpToolsDocumentation += `\n... and more (truncated at ${MCP_DOC_CHARS_MAX} chars)`;
                  break;
                }
                const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema).slice(0, 300) : "{}";
                mcpToolsDocumentation += `- <mcp_${server.name}_${tool.name}/>: ${tool.description?.slice(0, 150) || "No description"}\n  Args: ${schema}\n`;
              }
            }
          }
          mcpToolsDocumentation += "\n==========================";
        }

        // Active file and editor tabs context
        const workspaceState = useWorkspace.getState();
        const activeFile = workspaceState.activeFilePath;
        const openTabs = workspaceState.openTabs;
        let activeFileContext = "";
        if (activeFile) {
          const activeTab = openTabs.find((t) => t.path === activeFile);
          const cursorInfo = activeTab?.cursor ? ` (Cursor is at Line ${activeTab.cursor.line}, Column ${activeTab.cursor.column})` : "";
          activeFileContext = `\n\n=== CURRENT EDITOR STATE ===\nYou are currently looking at this file: ${activeFile}${cursorInfo}\n`;
          if (activeTab && activeTab.content) {
            const MAX_ACTIVE_FILE_CHARS = 30000; // ~7500 tokens
            if (activeTab.content.length > MAX_ACTIVE_FILE_CHARS) {
              activeFileContext += `\n--- Active File Content (truncated, ${activeTab.content.length} chars total) ---\n${activeTab.content.slice(0, MAX_ACTIVE_FILE_CHARS)}\n... [truncated]\n`;
            } else {
              activeFileContext += `\n--- Active File Content ---\n${activeTab.content}\n`;
            }
          }
          if (openTabs.length > 1) {
            activeFileContext += `- Other open tabs: ${openTabs.filter(t => t.path !== activeFile).map(t => t.name).join(", ")}\n`;
          }
          activeFileContext += "============================";
        }

        const workspacePath = useChat.getState().chatSessions.find((s) => s.id === sessionId)?.workspacePath
          ?? useChat.getState().session?.workspacePath;

        // Workspace memory
        let workspaceMemoryBlock = "";
        if (workspacePath) {
          try {
            const memoryPath = joinPathUtil(workspacePath, ".dalam/memory.json");
            if (await scopeSafeExists(memoryPath)) {
              const memoryContent = await dalamAPI.fs.readFile(memoryPath);
              const memoryObj = JSON.parse(memoryContent);
              workspaceMemoryBlock = `\n\n=== PERSISTENT WORKSPACE MEMORY ===\nDalam maintains a persistent memory file for this workspace at \`.dalam/memory.json\`. You can modify this file using your edit/write file tools to remember key rules, paths, build commands, or context for future turns.\n\nCurrent Contents:\n- Project Overview: ${memoryObj.projectOverview || "Not specified."}\n- Key Files/Directories: ${JSON.stringify(memoryObj.keyFiles || [])}\n- Build/Test Commands: ${JSON.stringify(memoryObj.buildCommands || [])}\n- Learned Rules:\n${(memoryObj.learnedRules || []).map((r: string) => `  * ${r}`).join("\n")}\n===================================`;
            }
          } catch (e) {
            // Only log if it's not a scope error (scope errors are expected for new workspaces)
            const msg = (e as Error)?.message ?? String(e);
            if (!msg.includes("forbidden") && !msg.includes("scope")) {
              console.warn("Failed to load workspace memory:", e);
            }
          }
        }

        // SQLite memories
        let sqliteMemoriesBlock = "";
        if (workspacePath) {
          try {
            const { isDatabaseReady } = await import("./database");
            if (isDatabaseReady()) {
              const { searchMemories, getCriticalMemories } = await import("./memoryStore");
              const critical = await getCriticalMemories(5);
              const queryText = cleanPrompt || prompt;
              const relevant = queryText ? await searchMemories(queryText, { limit: 5 }).catch(() => []) : [];
              const criticalIds = new Set(critical.map((m) => m.id));
              const uniqueRelevant = relevant.filter((m) => !criticalIds.has(m.id));
              const allInjected = [...critical, ...uniqueRelevant];
              if (allInjected.length > 0) {
                const MEMORIES_BLOCK_MAX = 3000;
                sqliteMemoriesBlock = `\n\n=== RETRIEVED WORKSPACE MEMORIES ===\nRelevant memories from persistent store:\n`;
                for (const mem of allInjected) {
                  if (sqliteMemoriesBlock.length >= MEMORIES_BLOCK_MAX) {
                    sqliteMemoriesBlock += `\n... and ${allInjected.length - allInjected.indexOf(mem)} more memories (truncated)`;
                    break;
                  }
                  const tierIcon = { critical: "🔴", high: "🟡", medium: "🔵", low: "⚪" }[mem.tier];
                  const contentPreview = mem.content.length > 200 ? mem.content.slice(0, 200) + "..." : mem.content;
                  sqliteMemoriesBlock += `\n- ${tierIcon} [${mem.category}] ${mem.summary}\n  ${contentPreview.split("\n").join("\n  ")}\n`;
                }
                sqliteMemoriesBlock += `====================================`;
              }
            }
          } catch (e) { console.warn("Failed to retrieve memories for prompt injection:", e); }
        }

        // Pinned files
        let workspacePinnedBlock = "";
        if (workspacePath) {
          try {
            const contextPath = joinPathUtil(workspacePath, ".dalam/context.json");
            if (await scopeSafeExists(contextPath)) {
              const contextContent = await dalamAPI.fs.readFile(contextPath);
              const contextObj = JSON.parse(contextContent);
              if (contextObj.pinnedFiles && contextObj.pinnedFiles.length > 0) {
                const PINNED_MAX_CHARS = 8000;
                let pinnedBlock = "\n\n=== PINNED FILES ===\nThe following files are pinned in your context. You should keep their contents in mind:\n";
                for (const filePath of contextObj.pinnedFiles) {
                  if (pinnedBlock.length >= PINNED_MAX_CHARS) {
                    pinnedBlock += `\n... more pinned files truncated at ${PINNED_MAX_CHARS} chars`;
                    break;
                  }
                  try {
                    const fullPath = joinPathUtil(workspacePath, filePath);
                    if (await scopeSafeExists(fullPath)) {
                      const fileContent = await dalamAPI.fs.readFile(fullPath);
                      const truncated = fileContent.length > 3000 ? fileContent.slice(0, 3000) + "\n... [truncated at 3000 chars]" : fileContent;
                      pinnedBlock += `\n--- Pinned File: ${filePath} ---\n${truncated}\n`;
                    }
                  } catch (e) { console.warn(`Failed to read pinned file ${filePath}:`, e); }
                }
                pinnedBlock += "=====================";
                workspacePinnedBlock = pinnedBlock;
              }
            }
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            if (!msg.includes("forbidden") && !msg.includes("scope")) {
              console.warn("Failed to load workspace context:", e);
            }
          }
        }

        // 4-layer instructions hierarchy
        let workspaceRulesBlock = "";
        if (workspacePath) {
          try {
            const instructions = await loadInstructions(workspacePath, {
              readFile: dalamAPI.fs.readFile,
              exists: scopeSafeExists,
              getHomeDir: async () => {
                const { homeDir } = await import("@tauri-apps/api/path");
                return homeDir();
              },
            });
            workspaceRulesBlock = formatInstructionsForPrompt(instructions, activeFile ?? undefined);
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            if (!msg.includes("forbidden") && !msg.includes("scope")) {
              console.warn("Failed to load workspace instructions:", e);
            }
          }
        }

        // Compact tool documentation — full version always included; if context is tight, use minimal
        const toolsDocumentation = `
=== TOOLS ===
Output XML tags to use tools. Multiple tools in one response execute in parallel.

FILE OPS: <read_file path="..."/> | <write_file path="...">content</write_file> | <list_dir path="..."/>
EDIT: <edit_file path="..."><search>old</search><replace>new</replace></edit_file> (occurrence="N" for Nth match, 0-indexed: 0=first, 1=second)
SEARCH: <grep_file path="..." pattern="..." regex="false"/> | <search_files pattern="..." glob="**/*.ts"/>
SHELL: <run_command command="..."/> | <bash command="..."/>
GIT: <git_status/> | <git_log/> | <git_branch/> | <git_commit message="..."/> | <git_checkout branch="..."/> | <git_diff_file path="..."/>
MEMORY: <memory_save category="project" tier="medium" summary="...">content</memory_save> | <memory_search query="..."/> | <memory_delete id="..."/> | <memory_stats/> | <memory_maintain/> | <memory_extract/> | <memory_export/> | <memory_import/>
BROWSER: <browser_navigate url="..."/> | <browser_execute script="..."/> | <screenshot/> | <run_preview command="..." port="..."/>
SYSTEM: <clipboard_read/> | <clipboard_write>text</clipboard_write> | <notify title="..." body="..."/> | <system_info/> | <open_url url="..."/> | <launch_app name="..." args="..."/>
UI: <open_panel panel="..."/> | <set_theme theme="light|dark|system"/> | <set_view_mode mode="editor|chat"/>
SUB-AGENT: <task prompt="..." subagent_type="general" description="..."/>
PLAN: <create_task_plan tasks="..."/>
QUESTION: <question question="..." options="opt1,opt2,..."/>
TASK: <todowrite>...</todowrite>
PREVIEW: <run_preview command="..." port="..."/>
NEW_TERMINAL: <new_terminal cwd="..." shell="bash"/>
WRITE_TERMINAL: <terminal_write command="..."/>
ABSOLUTE PATHS required. Workspace: ${workspacePath || "."}
`;

        // Genes (SQLite-backed, per-workspace persistence)
        const genePool = await loadGenePool();
        const rawHistory = conversationHistory ? [...conversationHistory] : [];
        const recentMsgs = rawHistory.filter((msg) => msg.role !== "system").slice(-5);
        const activeGenes = await expressGenes(genePool, cleanPrompt, recentMsgs);
        const genesPrompt = formatGenesForPrompt(activeGenes);

        // Inject browser context if user mentions @browser, @tab:, or @url: in their prompt
        let browserContextBlock = "";
        const hasBrowserRef = cleanPrompt.includes("@browser") || cleanPrompt.includes("@tab:") || cleanPrompt.includes("@url:");
        if (hasBrowserRef) {
          try {
            const { useUI } = await import("../store/useAppStore");
            const ui = useUI.getState();
            // Check for specific tab reference: @tab:<tabId> or @url:<url>
            const tabMatch = cleanPrompt.match(/@tab:(\S+)/);
            const urlMatch = cleanPrompt.match(/@url:(\S+)/);
            let targetTab = ui.browserTabs.find((t) => t.id === ui.activeBrowserTabId);
            if (tabMatch) {
              targetTab = ui.browserTabs.find((t) => t.id === tabMatch[1] || t.title.toLowerCase().includes(tabMatch[1].toLowerCase()));
            }
            if (urlMatch && !targetTab) {
              targetTab = ui.browserTabs.find((t) => t.url.includes(urlMatch[1]));
            }
            if (targetTab) {
              const allTabs = ui.browserTabs.map(t => `  - ${t.title}: ${t.url}`).join("\n");
              browserContextBlock = `\n\n=== BROWSER CONTEXT ===\nThe user is referencing the browser panel.\nActive tab: ${targetTab.title} — ${targetTab.url}\nAll open tabs:\n${allTabs}\nUse <browser_navigate url="..."/> to change the URL.\nUse <browser_execute script="..."/> to interact with the page.\nUse <screenshot/> to inspect the current page content.\nUse <open_panel panel="browser"/> to show the browser panel.\n========================`;
            } else {
              browserContextBlock = `\n\n=== BROWSER CONTEXT ===\nThe user referenced @browser but no matching tab is found.\nOpen tabs: ${ui.browserTabs.length}\nUse <browser_navigate url="..."/> to open a page first.\n========================`;
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
          }
        }

        const systemPrompt =
          "You are Dalam, an AI coding assistant. You MUST use XML tool tags to read, create, and modify files. " +
          "NEVER output file content as markdown code blocks — they do NOT create files. " +
          "NEVER describe what you will do or summarize what you did — just emit the tool tag with complete content and nothing else. " +
          "Be extremely concise: output ONLY the tool tag, no preamble, no explanation, no summary.\n\n" +
          "Rules:\n" +
          "1. CREATE: <write_file path=\"/abs/path\">full content</write_file>\n" +
          "2. EDIT (preferred): <edit_file path=\"/abs/path\"><search>exact old lines</search><replace>new lines</replace></edit_file>\n" +
          "   Only change what's needed — never rewrite the whole file.\n" +
          "3. READ: <read_file path=\"/abs/path\"/> or <read_file path=\"/abs/path\" offset=\"100\" limit=\"50\"/>\n" +
          "4. Workspace path: " + (workspacePath || ".") + "\n" +
          "5. Complex tasks: plan with <create_task_plan>, then execute each step.\n" +
          "6. Need input? <question> with options.\n" +
          "7. After creating files, <run_preview> then <screenshot> to verify.\n" +
          "8. TO COMPLETE A TASK: After reading context, output the edit/write tool tag. Do NOT just read and stop."
          + workspaceMemoryBlock
          + sqliteMemoriesBlock
          + workspaceRulesBlock
          + toolsDocumentation
          + activeSkillPrompt
          + mcpToolsDocumentation
          + activeFileContext
          + workspacePinnedBlock
          + genesPrompt
          + browserContextBlock;

        return systemPrompt;
      }

      // Abort previous sendPrompt for the same session, if any
      const prev = activeControllers.get(sessionId);
      if (prev) prev.abort();
      const ac = new AbortController();
      activeControllers.set(sessionId, ac);
      const emit = (event: StreamEvent) => { streamCallbacks.get(sessionId)?.(event); };
      const sessionStartTime = Date.now();

      await hookBus.emit("UserPromptSubmit", {
        sessionId,
        prompt,
        conversationHistory: conversationHistory ?? [],
        agentName: agentName ?? "yolo",
        attachments: (attachments ?? []).map((a) => ({ name: a.name, mimeType: a.mimeType })),
        timestamp: Date.now(),
      });

      try {
        const { useChat } = await import("../store/useAppStore");

      // Skill matching
      const { useSkillsMcp } = await import("../store/useAppStore");
      const skillsState = useSkillsMcp.getState();
      const enabledSkills = skillsState.skills.filter((sk) => sk.enabled);
      const skillInfos = enabledSkills.map((sk) => ({
        name: sk.name,
        description: sk.description,
        content: sk.prompt,
        location: sk.source === "bundled" ? `bundled://${sk.name}/SKILL.md` : `user://${sk.name}/SKILL.md`,
        source: (sk.source === "bundled" ? "bundled" : sk.source === "project" ? "project" : "user-global") as "bundled" | "project" | "user-global" | "user-workspace",
      }));
      const matched = matchSkillInvocation(prompt, skillInfos);
      let cleanPrompt = prompt;
      if (matched) {
        if (!matched.skill.content) {
          matched.skill.content = await loadSkillContent(matched.skill, { readFile: dalamAPI.fs.readFile });
        }
        const regex = new RegExp(`\\$${matched.skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        cleanPrompt = prompt.replace(regex, "").trim();
        emit({ type: "activity-skill", name: matched.skill.name, content: matched.skill.description, args: matched.args });
      }

      // Assemble system prompt and context
      const systemPrompt = await assembleContext(cleanPrompt);

      // Workspace path for tool execution (doesn't change during session)
      const workspacePath = useChat.getState().chatSessions.find((s) => s.id === sessionId)?.workspacePath
        ?? useChat.getState().session?.workspacePath
        ?? "";

      // Loop state
      const currentHistory: ChatMessage[] = conversationHistory ? [...conversationHistory] : [];
      let totalFullContent = "";
      let totalToolCalls = 0;
      let loopCount = 0;
      const MAX_LOOP_HARD = 30;
      const loopStartTime = Date.now();
      const MAX_LOOP_DURATION_MS = 30 * 60 * 1000; // 30 minutes — matches cumulative stream timeout in useAppStore

      // Build messages from LIVE currentHistory (not pre-loop snapshot)
      // Token-budget-aware: uses estimateTokens for accurate counting
      // compactionSummary is re-read fresh each call to reflect compaction results
      async function buildMessages(): Promise<ApiMessage[]> {
          const { estimateTokens: estTokens, parseContextWindow } = await import("./contextManager");
          const { useChat: ucBuild, useModelProviders, useSettings: settingsStore } = await import("../store/useAppStore");
          const liveSummaries = ucBuild.getState().compactionSummaries || {};
          const localCompactionSummary = liveSummaries[sessionId];
          // Use the model's actual context window, with 120K fallback
          const modelId = settingsStore.getState().settings.selectedModel || "";
          const allModels = useModelProviders.getState().getAllModels();
          const modelInfo = allModels.find((m) => m.model.modelId === modelId);
          const MAX_TOKENS = parseContextWindow(modelInfo?.model?.contextWindow) || 120000;
          // Reserve tokens for system prompt, compaction summary, and output
          const systemTokenEst = estTokens(systemPrompt);
          const OUTPUT_RESERVE = 8000;
          const allMsgs = currentHistory.filter((m) => m.role !== "system");
          const COMPACT_RESERVE = localCompactionSummary && allMsgs.length > 10 ? estTokens(localCompactionSummary) + 100 : 0;
          const availableForHistory = MAX_TOKENS - systemTokenEst - OUTPUT_RESERVE - COMPACT_RESERVE;
          if (availableForHistory <= 0) {
            // System prompt alone exceeds budget — send minimal context
            return [{ role: "system", content: systemPrompt }];
          }

          // Always include the last message; work backward from there
          const msgs: ChatMessage[] = [];
          let tokenCount = 0;
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const m = allMsgs[i];
            const content = typeof m.content === "string" ? m.content : "";
            // Account for tool call overhead in message token estimation
            let contentTokens = estTokens(content);
            if (m.toolCalls?.length) contentTokens += m.toolCalls.length * 20;
            if (m.fileChanges?.length) contentTokens += m.fileChanges.length * 10;
            contentTokens += 4; // role overhead
            if (tokenCount + contentTokens > availableForHistory && msgs.length >= 2) break;
            tokenCount += contentTokens;
            msgs.unshift(m);
          }

          // Always include the first user message (original prompt) for task context
          // The first user message is the first message with role="user" AND content that
          // doesn't start with "[Tool result" or "[Tool error" — this prevents picking
          // a tool result message as the "first user prompt" when tool results use "user" role.
          const firstUserMsg = allMsgs.find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[Tool ") && !m.content.startsWith("[TOOL "));
          if (firstUserMsg && !msgs.includes(firstUserMsg)) {
            const firstContent = typeof firstUserMsg.content === "string" ? firstUserMsg.content : "";
            const firstTokens = estTokens(firstContent);
            // Only add if it fits within budget (with small margin)
            if (tokenCount + firstTokens <= availableForHistory * 0.9) {
              msgs.unshift(firstUserMsg);
            }
          }

          const result: ApiMessage[] = [{ role: "system", content: systemPrompt }];
          if (localCompactionSummary && allMsgs.length > 10) {
            result.push({ role: "system", content: `[COMPACTED HISTORY]\n${localCompactionSummary}\n` });
          }
          for (const m of msgs) {
            // Map roles correctly: user→user, tool→user, everything else→assistant
            const role = m.role === "user" || m.role === "tool" ? "user" : "assistant";
            result.push({ role, content: m.content });
          }
          return result;
        }

        // Adaptive rate limiting: some providers (Groq, Together, fireworks) have very low RPM limits
        // and very fast token speeds. We need a per-provider minimum inter-request delay.
        async function rateLimitDelay(): Promise<void> {
          // providerId and modelId come from the outer destructuring on line 847
          const providerLower = String(providerId ?? "").toLowerCase();
          const modelLower = String(modelId ?? "").toLowerCase();
          // Providers/models known for extremely fast inference with strict RPM limits
          const isFastRpmProvider =
            providerLower.includes("groq") ||
            providerLower.includes("together") ||
            providerLower.includes("fireworks") ||
            providerLower.includes("together.ai") ||
            modelLower.includes("llama-3.3-70b") ||
            modelLower.includes("llama-3.1-8b") ||
            modelLower.includes("mixtral") ||
            modelLower.startsWith("gemma-");

          const abortOnDelay = (delay: number) =>
            new Promise<void>((resolve) => {
              if (ac.signal.aborted) return resolve();
              const onAbort = () => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(() => {
                ac.signal.removeEventListener("abort", onAbort);
                resolve();
              }, delay);
              ac.signal.addEventListener("abort", onAbort, { once: true });
            });

          const sessionErrors = sessionRateLimitErrors.get(sessionId) ?? 0;
          if (sessionErrors > 0) {
            // Exponential backoff: 2s, 4s, 8s, 16s, 60s max
            // For fast providers, start with higher base to avoid hitting limits again
            const baseBackoff = isFastRpmProvider ? 2000 : 1000;
            const delay = Math.min(baseBackoff * Math.pow(2, sessionErrors), 60000);
            await abortOnDelay(delay);
            return;
          }
          // Base delay between turns: minimal — most providers handle 60+ RPM
          const baseDelay = isFastRpmProvider ? 800 : 300;
          await abortOnDelay(baseDelay);
        }

        let emittedEndInThisIteration = false;

        // Don't reset rate limit backoff here — let it persist across turns
        // to provide meaningful rate limit protection. Only reset on explicit
        // success (line ~1798) or after a long quiet period.

        while (loopCount < MAX_LOOP_HARD) {
          loopCount++;
          emittedEndInThisIteration = false;

          // Check abort signal at the top of each iteration to avoid wasting an LLM call
          if (ac.signal.aborted) {
            emit({ type: "error", error: "Aborted by user." });
            emit({ type: "message-end", messageId: sessionId });
            emittedEndInThisIteration = true;
            break;
          }

          if (Date.now() - loopStartTime > MAX_LOOP_DURATION_MS) {
            emit({ type: "error", error: `Agent loop timed out after ${MAX_LOOP_DURATION_MS / 1000}s.` });
            emit({ type: "message-end", messageId: sessionId });
            emittedEndInThisIteration = true;
            break;
          }

          const messages = await buildMessages();

          // Enrich the user's message with attachments on the first turn
          // (images as base64, file content appended to text)
          if (loopCount === 1) {
            const hasImages = attachments?.some((a) => a.mimeType.startsWith("image/"));
            // Find the user message in the messages array and enrich it
            const userMsgIdx = messages.map((m) => m.role).lastIndexOf("user");
            if (userMsgIdx >= 0) {
              if (hasImages && config.apiFormat === "openai") {
                const parts: ApiContentPart[] = [{ type: "text", text: messages[userMsgIdx].content as string }];
                for (const att of attachments ?? []) {
                  if (att.mimeType.startsWith("image/")) {
                    parts.push({ type: "image_url", image_url: { url: `data:${att.mimeType};base64,${att.content}` } });
                  } else if (att.content) {
                    parts.push({ type: "text", text: `\n\n--- File: ${att.name} ---\n${att.content}` });
                  }
                }
                messages[userMsgIdx] = { role: "user", content: parts };
              } else if (hasImages && config.apiFormat === "anthropic") {
                const parts: ApiContentPart[] = [{ type: "text", text: messages[userMsgIdx].content as string }];
                for (const att of attachments ?? []) {
                  if (att.mimeType.startsWith("image/")) {
                    parts.push({ type: "image", source: { type: "base64", media_type: att.mimeType, data: att.content } });
                  } else if (att.content) {
                    parts.push({ type: "text", text: `\n\n--- File: ${att.name} ---\n${att.content}` });
                  }
                }
                messages[userMsgIdx] = { role: "user", content: parts };
              } else {
                let fullPrompt = messages[userMsgIdx].content;
                for (const att of attachments ?? []) {
                  if (att.mimeType.startsWith("image/")) continue;
                  if (att.content) fullPrompt += `\n\n--- File: ${att.name} ---\n${att.content}`;
                }
                messages[userMsgIdx] = { role: "user", content: fullPrompt };
              }
            }
          }

          // Start turn
          emit({ type: "message-start", messageId: sessionId });
          // isStreaming handled by appendStream on message-start

          // Skip rate limit delay on the first turn — no point delaying before
          // the very first chunk. The 2.5s base delay is only meaningful between
          // subsequent turns to avoid hitting RPM limits.
          if (loopCount > 1) {
            await rateLimitDelay();
          }

          const maxTokens = settings.maxTokens ?? 4096;

          // Pre-flight context check: estimate total tokens and compact if needed
          const { estimateTokens: estTk, parseContextWindow, computePressure: computePressureFn } = await import("./contextManager");
          const modelInfo2 = (await import("../store/useAppStore")).useModelProviders.getState().getAllModels().find((m) => m.model.modelId === activeModelId);
          const ctxWindow = parseContextWindow(modelInfo2?.model?.contextWindow) || 120000;
          const totalEstTokens = messages.reduce((sum, m) => {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return sum + estTk(content) + 4;
          }, 0);

          // Emit ContextPressure event so hookListeners can auto-save memories
          {
            const { pressure, ratio } = computePressureFn(totalEstTokens, ctxWindow);
            if (pressure !== "none" && pressure !== "low") {
              void hookBus.emit("ContextPressure", {
                sessionId,
                pressure,
                pressureRatio: ratio,
                totalTokens: totalEstTokens,
                usableTokens: ctxWindow,
                shouldPrune: ratio >= 0.5,
                shouldCompact: ratio >= 0.85,
                timestamp: Date.now(),
              });
            }
          }

          if (totalEstTokens + maxTokens > ctxWindow * 0.9) {
            _debugLog(`[sendPrompt] Pre-flight: estimated ${totalEstTokens} tokens + ${maxTokens} output > ${ctxWindow} context. Triggering compaction.`);
            try {
              const { useChat: uc2 } = await import("../store/useAppStore");
              await uc2.getState().compactSessionHistory(sessionId);
              // Rebuild currentHistory from the live store so buildMessages()
              // reflects the compaction result, preventing infinite compaction loops.
              const liveMessages = uc2.getState().sessionMessages[sessionId] ?? [];
              currentHistory.length = 0;
              currentHistory.push(...liveMessages);
              _debugLog(`[sendPrompt] Pre-flight compaction completed, rebuilding messages (${currentHistory.length} msgs).`);
              emit({ type: "message-end", messageId: sessionId });
              emittedEndInThisIteration = true;
              continue;
            } catch (e) { _debugLog(`[sendPrompt] Pre-flight compaction failed:`, e); }
          }

          _debugLog(`[sendPrompt] Turn ${loopCount}: starting stream, model=${activeModelId}, messages=${messages.length}, estTokens=${totalEstTokens}`);
          const llmStartTime = Date.now();
          const stream = streamChat(activeConfig.baseUrl, activeConfig.apiKey, activeConfig.apiFormat || "openai", activeModelId, messages, ac.signal, maxTokens);
          let fullContent = "";
          let lastMessageId = "";
          let eventCount = 0;

          for await (const event of stream) {
            eventCount++;
            if (event.type === "message-delta") {
              fullContent += event.content;
              lastMessageId = event.messageId;
            }
            if (event.type === "usage") {
              recordTokenUsage(sessionId, modelId, event.usage);
            }
            emit(event);
          }
          const llmDurationMs = Date.now() - llmStartTime;
          recordLlmCall(llmDurationMs, false);
          _debugLog(`[sendPrompt] Turn ${loopCount}: stream ended, events=${eventCount}, contentLen=${fullContent.length}, contentPreview=${fullContent.slice(0, 200)}`);

          totalFullContent += fullContent;

          // FIX: Extract tool calls from code blocks FIRST, then strip code blocks.
          // Previously, code block stripping replaced tool calls with "[code block]"
          // before they could be parsed, causing LLMs like Llama 3.3 to get stuck.
          const parsedFromCodeBlocks = extractToolCallsFromCodeBlocks(fullContent);

          const cleanedFromCodeBlocks = fullContent.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
          const safeTextForParsing = cleanedFromCodeBlocks;

          // Parse tool calls from cleaned text (code-block-stripped but tool calls extracted first)
          const parsedToolsFromText = await parseToolCalls(safeTextForParsing);
          // Merge: code block tool calls take priority (they're more explicit), then text-parsed ones
          // Deduplicate: if the same tool+args appears in both, keep only the code-block version
          const sortedStringify = (obj: Record<string, unknown>) => JSON.stringify(obj, Object.keys(obj).sort());
          const parsedTools = [...parsedFromCodeBlocks];
          const codeBlockKeys = new Set(parsedFromCodeBlocks.map((t) => `${t.name}:${sortedStringify(t.args)}`));
          for (const tc of parsedToolsFromText) {
            const key = `${tc.name}:${sortedStringify(tc.args)}`;
            if (!codeBlockKeys.has(key)) {
              parsedTools.push(tc);
              codeBlockKeys.add(key);
            }
          }
          _debugLog(`[sendPrompt] Turn ${loopCount}: parsed tools: codeBlock=${parsedFromCodeBlocks.length}, text=${parsedToolsFromText.length}, total=${parsedTools.length}`);
          if (parsedTools.length > 0) {
            _debugLog(`[sendPrompt] Turn ${loopCount}: tools:`, parsedTools.map(t => `${t.name}(${JSON.stringify(t.args).slice(0, 100)})`));
          }

          // FIX: Single parse pass for display content — strip all tool tags from
          // the ORIGINAL fullContent (not safeTextForParsing which had code blocks
          // already removed, causing garbled fragments in display).
          // The UI store independently strips tags for display via stripXmlToolCallTags.

          // Push RAW content to API history so the LLM sees its own tool calls.
          // The UI store independently strips tags for display.
          const assistantTurnMsg = {
            id: lastMessageId || sessionId,
            role: "assistant" as const,
            content: fullContent || "(executing tools...)",
            timestamp: Date.now(),
          };
          currentHistory.push(assistantTurnMsg);

          if (parsedTools.length > 0) {
            // FIX 2: Parallel tool approval and execution
            const toolCallMetas = parsedTools.map((pt) => ({
              id: "tc-" + crypto.randomUUID(),
              name: pt.name,
              args: pt.args,
              status: "pending" as const,
              raw: pt,
            }));

            // Show all tool calls to user at once
            for (const tc of toolCallMetas) {
              emit({ type: "tool-call", toolCall: { id: tc.id, name: tc.name, args: tc.args, status: tc.status } });
            }

            // Check which tools may be auto-approved (permission = "allow") so executeTool knows
            // to skip diff proposals for write/edit tools. This is advisory only — the store's
            // appendStream handler is the single source of truth for the actual approval decision.
            const autoApprovedTools = new Set<string>();
            try {
              const { useAgents } = await import("../store/useAppStore");
              const agentState = useAgents.getState();
              for (const tc of toolCallMetas) {
                const isBashTool = ["shell", "bash", "execute", "run_command", "launch_app"].includes(tc.name);
                const isReadTool = ["read_file", "list_dir", "grep_file", "search_files", "git_status", "git_log", "git_branch", "git_diff_file", "clipboard_read", "system_info", "memory_search", "memory_stats", "memory_extract", "memory_export", "memory_import", "task", "open_panel", "screenshot", "notify", "get_env", "get_screen_info", "list_processes", "get_disk_space", "set_theme", "toggle_theme", "set_view_mode", "toggle_view_mode", "toggle_right_panel", "toggle_bottom_panel", "set_right_panel_tab", "set_bottom_panel_tab", "webfetch", "websearch", "grep", "search", "question"].includes(tc.name);
                const permissionKey = isBashTool ? "bash" : isReadTool ? "read" : "edit";
                const canonicalPattern = tc.name;
                const action = agentState.evaluatePermission(permissionKey, canonicalPattern);
                if (action === "allow") {
                  autoApprovedTools.add(tc.id);
                }
              }
            } catch (e) {
              if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
            }

            // Execute tools with approval — parallel for read-only, sequential for write tools
            const toolResults: string[] = [];
            let abortedMidBatch = false;

            // Group tool calls into parallel batches using dependency analysis
            const executorToolCalls: (ExecutorToolCall & { originalIndex: number })[] = toolCallMetas.map((tc, idx) => ({
              name: tc.name,
              args: tc.args as Record<string, unknown>,
              raw: "",
              originalIndex: idx,
            }));
            const batches = groupToolCallsForExecution(executorToolCalls);

            for (const batch of batches) {
              // Map batch back to original toolCallMetas by original index
              const batchMetas = batch.map(bc =>
                toolCallMetas[(bc as ExecutorToolCall & { originalIndex: number }).originalIndex]
              );

              if (batch.length === 1) {
                // Single tool: execute sequentially (preserves existing approval flow)
                const tc = batchMetas[0]!;
                _debugLog(`[sendPrompt] Turn ${loopCount}: executing tool ${tc.id} (${tc.name})`);
                const decision = await waitForToolApproval(tc.id, ac.signal);
                _debugLog(`[sendPrompt] Turn ${loopCount}: tool ${tc.id} approval decision: ${decision}`);
                if (ac.signal.aborted) {
                  abortedMidBatch = true;
                  break;
                }
                if (decision === "approved") {
                  const isAutoApproved = autoApprovedTools.has(tc.id);
                  const toolStartTime = Date.now();
                  try {
                    let result: string;
                    if (tc.name === "task") {
                      result = await executeSubAgentTask(tc.args, sessionId, workspacePath || ".", emit, ac.signal);
                    } else {
                      result = await executeTool(tc.name, tc.args, workspacePath || ".", emit, isAutoApproved);
                    }
                    const durationMs = Date.now() - toolStartTime;
                    emit({ type: "tool-result", toolCallId: tc.id, result });
                    if (tc.name === "read_file" || tc.name === "list_dir") {
                      emit({ type: "activity-explore", query: (tc.args.path as string) ?? ".", kind: tc.name === "read_file" ? "definition" : "files", matches: [{ path: (tc.args.path as string) ?? "." }] });
                    } else if (tc.name === "grep_file" || tc.name === "search_files") {
                      emit({ type: "activity-explore", query: (tc.args.pattern as string) ?? "", kind: "grep", matches: result.split("\n").filter(Boolean).map((line: string) => ({ path: line.split(":")[0] ?? "", preview: line })) });
                    } else if (tc.name === "run_command") {
                      emit({ type: "activity-bash", command: tc.args.command as string, result });
                    } else if (tc.name === "write_file" || tc.name === "edit_file") {
                      emit({ type: "activity-bash", command: `${tc.name} ${(tc.args.path as string) ?? ""}`, result });
                    }
                    await hookBus.emit("PostToolUse", { sessionId, toolName: tc.name, toolArgs: tc.args, result, durationMs, timestamp: Date.now() });
                    const truncatedResult = truncateToolResult(result, tc.name);
                    toolResults.push(`[Tool result for ${tc.name}]\n${truncatedResult || "(no output)"}`);
                  } catch (err) {
                    const errMsg = (err as Error)?.message ?? String(err);
                    const { matchErrorPattern } = await import("./errorPatterns");
                    const errorMatch = matchErrorPattern(errMsg);
                    const suggestion = errorMatch ? `\nSuggestion: ${errorMatch.suggestion}` : "";
                    emit({ type: "tool-result", toolCallId: tc.id, result: `Error: ${errMsg}` });
                    await hookBus.emit("PostToolUse", { sessionId, toolName: tc.name, toolArgs: tc.args, result: `Error: ${errMsg}`, error: errMsg, durationMs: Date.now() - toolStartTime, timestamp: Date.now() });
                    toolResults.push(`[Tool error for ${tc.name}]\nError: ${errMsg}${suggestion}`);
                  }
                } else if (ac.signal.aborted) {
                  emit({ type: "tool-result", toolCallId: tc.id, result: "Aborted by user." });
                  toolResults.push(`[TOOL RESULT: ${tc.name}]\nAborted by user.`);
                } else {
                  emit({ type: "tool-result", toolCallId: tc.id, result: "Permission Denied by user." });
                  toolResults.push(`[Tool result for ${tc.name}]\nPermission Denied by user.`);
                }
              } else {
                // Multiple read-only tools: execute in parallel
                _debugLog(`[sendPrompt] Turn ${loopCount}: executing ${batch.length} read-only tools in parallel`);
                const parallelResults = await Promise.allSettled(
                  batchMetas.map(async (tc) => {
                    const decision = await waitForToolApproval(tc.id, ac.signal);
                    if (ac.signal.aborted) {
                      return `[TOOL RESULT: ${tc.name}]\nAborted by user.`;
                    }
                    if (decision !== "approved") {
                      emit({ type: "tool-result", toolCallId: tc.id, result: "Permission Denied by user." });
                      return `[Tool result for ${tc.name}]\nPermission Denied by user.`;
                    }
                    const isAutoApproved = autoApprovedTools.has(tc.id);
                    const toolStartTime = Date.now();
                    try {
                      let result: string;
                      if (tc.name === "task") {
                        result = await executeSubAgentTask(tc.args, sessionId, workspacePath || ".", emit, ac.signal);
                      } else {
                      result = await executeTool(tc.name, tc.args, workspacePath || ".", emit, isAutoApproved, ac.signal);
                      }
                      const durationMs = Date.now() - toolStartTime;
                      emit({ type: "tool-result", toolCallId: tc.id, result });
                      if (tc.name === "read_file" || tc.name === "list_dir") {
                        emit({ type: "activity-explore", query: (tc.args.path as string) ?? ".", kind: tc.name === "read_file" ? "definition" : "files", matches: [{ path: (tc.args.path as string) ?? "." }] });
                      } else if (tc.name === "grep_file" || tc.name === "search_files") {
                        emit({ type: "activity-explore", query: (tc.args.pattern as string) ?? "", kind: "grep", matches: result.split("\n").filter(Boolean).map((line: string) => ({ path: line.split(":")[0] ?? "", preview: line })) });
                      }
                      await hookBus.emit("PostToolUse", { sessionId, toolName: tc.name, toolArgs: tc.args, result, durationMs, timestamp: Date.now() });
                      const truncatedResult = truncateToolResult(result, tc.name);
                      return `[Tool result for ${tc.name}]\n${truncatedResult || "(no output)"}`;
                    } catch (err) {
                      const errMsg = (err as Error)?.message ?? String(err);
                      const { matchErrorPattern } = await import("./errorPatterns");
                      const errorMatch = matchErrorPattern(errMsg);
                      const suggestion = errorMatch ? `\nSuggestion: ${errorMatch.suggestion}` : "";
                      emit({ type: "tool-result", toolCallId: tc.id, result: `Error: ${errMsg}` });
                      await hookBus.emit("PostToolUse", { sessionId, toolName: tc.name, toolArgs: tc.args, result: `Error: ${errMsg}`, error: errMsg, durationMs: Date.now() - toolStartTime, timestamp: Date.now() });
                      return `[Tool error for ${tc.name}]\nError: ${errMsg}${suggestion}`;
                    }
                  })
                );
                for (const result of parallelResults) {
                  if (result.status === "fulfilled") {
                    toolResults.push(result.value);
                  } else {
                    toolResults.push(`[Tool error]\n${result.reason?.message || "Unknown error"}`);
                  }
                }
                if (ac.signal.aborted) {
                  abortedMidBatch = true;
                }
              }

              if (abortedMidBatch) break;
            }

            // Emit tool-result for any remaining tools skipped by abort
            if (abortedMidBatch) {
              const executedIds = new Set(toolCallMetas.slice(0, toolResults.length).map(tc => tc.id));
              for (const tc of toolCallMetas) {
                if (!executedIds.has(tc.id)) {
                  emit({ type: "tool-result", toolCallId: tc.id, result: "Aborted by user." });
                  toolResults.push(`[TOOL RESULT: ${tc.name}]\nAborted by user.`);
                }
              }
            }

            // Push combined tool results as single user message
            if (toolResults.length > 0) {
              const toolResultContent = toolResults.join("\n\n");
              currentHistory.push({ id: "tr-" + crypto.randomUUID(), role: "user" as const, content: toolResultContent, timestamp: Date.now() });
              totalToolCalls += parsedTools.length;
            }

            // Reset streaming state
            emit({ type: "message-end", messageId: lastMessageId || sessionId });
            emittedEndInThisIteration = true;

            // If the abort signal fired during tool execution, break out of the
            // while loop entirely rather than continuing (which would hit the
            // aborted stream, throw AbortError, and double-emit message-end).
            if (ac.signal.aborted) {
              break;
            }

            // Re-create safety timer immediately for the next iteration
            // (message-end handler clears it, but the loop is still running)
            try {
              const { resetSafetyTimer } = await import("./safetyTimer");
              resetSafetyTimer(
                () => useChat.getState() as TimerState,
                (update: Record<string, unknown>) => useChat.setState(update as Partial<ReturnType<typeof useChat.getState>>),
                "normal",
              );
            } catch (e) {
              if (import.meta.env.DEV) console.warn("[DALAM] import(\"./safetyTimer\");:", e);
            }

            sessionRateLimitErrors.set(sessionId, 0);
            continue;
          }

          // No tools parsed — turn is complete
          emit({ type: "message-end", messageId: lastMessageId || sessionId });
          emittedEndInThisIteration = true;
          sessionRateLimitErrors.set(sessionId, 0);
          break;
        }

        // If loop exhausted all iterations without break, do a finalizer turn
        if (loopCount >= MAX_LOOP_HARD) {
          // Hermes TurnFinalizer pattern: make one toolless API call to get a summary
          // instead of failing silently when iteration budget exhausts.
          try {
            emit({ type: "message-start", messageId: sessionId });
            const finalizerMessages: ApiMessage[] = [
              { role: "system", content: "The iteration budget has been exhausted. Please provide a concise summary of what you have accomplished so far and what remains to be done. Do not call any tools." },
              ...await buildMessages(),
            ];
            const finalConfig = getProviderConfig(providerId);
            const finalBaseUrl = finalConfig?.baseUrl || activeConfig.baseUrl;
            const finalApiKey = finalConfig?.apiKey || activeConfig.apiKey;
            const finalApiFormat = finalConfig?.apiFormat || activeConfig.apiFormat || "openai";
            const finalizerStream = streamChat(finalBaseUrl, finalApiKey, finalApiFormat, activeModelId, finalizerMessages, ac.signal, 2048);
            let finalizerContent = "";
            for await (const event of finalizerStream) {
              if (event.type === "message-delta") {
                finalizerContent += event.content;
                emit(event);
              }
            }
            if (finalizerContent) {
              totalFullContent += finalizerContent;
              currentHistory.push({
                id: "tf-" + crypto.randomUUID(),
                role: "assistant",
                content: finalizerContent,
                timestamp: Date.now(),
              });
            }
            // Always emit message-end for finalizer turn
            emit({ type: "message-end", messageId: sessionId });
            emittedEndInThisIteration = true;
          } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] operation:", e);
            emit({ type: "message-delta", messageId: sessionId, content: "\n\n[Agent reached iteration limit. No summary available.]" });
            // Emit message-end even on error
            if (!emittedEndInThisIteration) {
              emit({ type: "message-end", messageId: sessionId });
              emittedEndInThisIteration = true;
            }
          }
        }

        // Hook: Stop (after loop exits)
        await hookBus.emit("Stop", {
          sessionId,
          fullContent: totalFullContent,
          messageCount: currentHistory.length,
          toolCallsExecuted: totalToolCalls,
          timestamp: Date.now(),
        });

        // Hook: SessionEnd (natural completion) — guard against double emission with abort()
        if (!emittedSessionEnds.has(sessionId)) {
          emittedSessionEnds.add(sessionId);
          await hookBus.emit("SessionEnd", {
            sessionId,
            reason: "completed",
            messageCount: currentHistory.length,
            durationMs: Date.now() - sessionStartTime,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        const startTime = sessionStartTimes.get(sessionId) ?? Date.now();
        let messageCount = 0;
        try {
          const { useChat } = await import("../store/useAppStore");
          messageCount = useChat.getState().sessionMessages[sessionId]?.length ?? 0;
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
        }

        if (err instanceof ProviderError) {
          if (err.code === "credit") sessionRateLimitErrors.set(sessionId, (sessionRateLimitErrors.get(sessionId) ?? 0) + 1);
          emit({ type: "error", error: err.message });
          emit({ type: "message-end", messageId: sessionId });
          if (!emittedSessionEnds.has(sessionId)) {
            emittedSessionEnds.add(sessionId);
            await hookBus.emit("SessionEnd", {
              sessionId,
              reason: "error",
              messageCount,
              durationMs: Date.now() - startTime,
              timestamp: Date.now(),
            });
          }
        } else if ((err as Error)?.name === "AbortError") {
          emit({ type: "message-end", messageId: sessionId });
          if (!emittedSessionEnds.has(sessionId)) {
            emittedSessionEnds.add(sessionId);
            await hookBus.emit("SessionEnd", {
              sessionId,
              reason: "aborted",
              messageCount,
              durationMs: Date.now() - startTime,
              timestamp: Date.now(),
            });
          }
        } else {
          emit({ type: "error", error: `${(err as Error)?.message ?? "Unknown error"}` });
          emit({ type: "message-end", messageId: sessionId });
          if (!emittedSessionEnds.has(sessionId)) {
            emittedSessionEnds.add(sessionId);
            await hookBus.emit("SessionEnd", {
              sessionId,
              reason: "error",
              messageCount,
              durationMs: Date.now() - startTime,
              timestamp: Date.now(),
            });
          }
        }
      } finally {
        // Only clean up if THIS call's controller is still the active one.
        // A concurrent sendPrompt for the same session would have replaced it.
        const currentController = activeControllers.get(sessionId);
        const isStillActive = currentController === ac;
        if (isStillActive) {
          activeControllers.delete(sessionId);
        }
        sessionStartTimes.delete(sessionId);
        // Clean up file watchers — only clean watchers registered by this call
        for (const [key, unwatch] of fileWatchers) {
          if (key.startsWith(sessionId + ":")) {
            try {              unwatch();} catch (e) { if (import.meta.env.DEV) console.warn("[DALAM] unwatch();", e); }
            fileWatchers.delete(key);
          }
        }
        // MCP HTTP sessions are keyed by server name → session token (not Dalam session ID),
        // so we cannot match them here. They will be cleaned up by the MCP module on error/close.
        // Clean up stale pending diff proposals (older than 5 minutes) rather than clearing all,
        // to avoid discarding proposals from concurrent sessions.
        const staleThreshold = Date.now() - 5 * 60 * 1000;
        for (const [key, proposal] of pendingDiffProposals) {
          if (proposal.createdAt < staleThreshold) pendingDiffProposals.delete(key);
        }
// Safety: ensure isStreaming is always cleared, even if message-end/error failed to fire.
          // Only do this if we're still the active controller — otherwise a concurrent sendPrompt
          // owns the streaming state and we must not interfere.
          if (isStillActive) {
            try {
              const { useChat } = await import("../store/useAppStore");
              const state = useChat.getState();
              if (state.isStreaming && state.activeSessionId === sessionId) {
                _debugLog(`[sendPrompt] finally: isStreaming still true for ${sessionId}, force-clearing`);
                emit({ type: "message-end", messageId: sessionId });
              }
            } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
          }
        }
        // Clean up stream listener cleanup functions — execute the cleanup to release streamCallbacks
        const streamCleanup = streamCleanups.get(sessionId);
        if (streamCleanup) streamCleanup();
        streamCleanups.delete(sessionId);
        streamCallbacks.delete(sessionId);
        // Clean up rate limit errors for completed sessions
        sessionRateLimitErrors.delete(sessionId);
        // Clean up SessionEnd dedup tracking AFTER all cleanup is done.
        // Use queueMicrotask instead of setTimeout to avoid a fragile 100ms timer
        // that can race with concurrent abort() calls.
        queueMicrotask(() => emittedSessionEnds.delete(sessionId));
        // Only delete callback if this session doesn't have a newer listener
        // (checked via streamCleanups — a newer onStreamEvent would have replaced it)
      }

    },
    async abort(sessionId) {
      const startTime = sessionStartTimes.get(sessionId) ?? Date.now();
      let messageCount = 0;
      try {
        const { useChat } = await import("../store/useAppStore");
        const sessionMessages = useChat.getState().sessionMessages[sessionId];
        messageCount = sessionMessages?.length ?? 0;
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
      }
      // Only emit SessionEnd if we're the ones cleaning up (not sendPrompt's finally)
      if (activeControllers.has(sessionId) && !emittedSessionEnds.has(sessionId)) {
        emittedSessionEnds.add(sessionId);
        await hookBus.emit("SessionEnd", {
          sessionId,
          reason: "aborted",
          messageCount,
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        });
      }
      const ac = activeControllers.get(sessionId);
      if (ac) { ac.abort(); activeControllers.delete(sessionId); }
      sessionStartTimes.delete(sessionId);
      // Emit message-end to clean up UI streaming state
      const cb = streamCallbacks.get(sessionId);
      if (cb) {
        cb({ type: "message-end", messageId: sessionId });
        streamCallbacks.delete(sessionId);
      }
    },
    async summarizeMessages(model, messages) {
      const { config } = getActiveProvider(false);

      const isAnthropic = config.apiFormat === "anthropic";
      const url = config.baseUrl.replace(/\/+$/, "") + (isAnthropic ? "/v1/messages" : "/chat/completions");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (isAnthropic) {
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const defaultSystemPrompt = "You are a context compaction assistant. Summarize the following early conversation history between the user and assistant. Focus on: 1) What has been achieved, 2) Key decisions/plans approved, 3) Current state. Keep it very concise (under 200 words). Do not include any meta-commentary, intros, or outros. Just output the summary directly as markdown bullet points.";
      const systemMsg = messages.find((m) => m.role === "system")?.content || defaultSystemPrompt;
      const chatMessages = messages.filter((m) => m.role !== "system");

      const body = isAnthropic
        ? { model, system: systemMsg, messages: chatMessages, max_tokens: 1000 }
        : { model, messages: [{ role: "system", content: systemMsg }, ...chatMessages], max_tokens: 1000 };

      const json = await fetchJsonWithRetry(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, 2, 1000) as Record<string, unknown>;
      if (isAnthropic) {
        const content = (json.content as Array<{ text: string }>);
        return content?.[0]?.text || "";
      } else {
        const choices = (json.choices as Array<{ message: { content: string } }>);
        return choices?.[0]?.message?.content || "";
      }
    },
    async approveDiff(sessionId: string, diffId: string) {
      const pending = pendingDiffProposals.get(diffId);
      if (pending) {
        pendingDiffProposals.delete(diffId);
        // Write the file now that the user approved the diff
        await dalamAPI.fs.writeFile(pending.filePath, pending.newContent);
        // Record change for undo support
        try {
          const { recordChange: rc } = await import("./changeStack");
          rc({ filePath: pending.filePath, beforeContent: pending.oldContent, afterContent: pending.newContent, toolCallId: "diff-" + diffId, messageId: sessionId });
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[DALAM] import(\"./changeStack\");:", e);
        }
        const cb = streamCallbacks.get(sessionId);
        if (cb) {
          cb({
            type: "file-changed",
            change: {
              path: pending.filePath,
              action: pending.oldContent === "" ? "created" : "modified",
              additions: pending.hunks.reduce((n, h) => n + h.newLines, 0),
              deletions: pending.hunks.reduce((n, h) => n + h.oldLines, 0),
            },
          });
        }
        // Notify the LLM that the diff was approved and the file was written.
        // Without this, the LLM may re-request the same operation on the next turn.
        try {
          const { useChat } = await import("../store/useAppStore");
          const chatState = useChat.getState();
          const msgs = chatState.sessionMessages[sessionId];
          if (msgs) {
            const approvalMsg: import("@dalam/shared-types").ChatMessage = {
              id: "diff-approval-" + crypto.randomUUID(),
              role: "user",
              content: `User approved the file write. ${pending.filePath} has been updated (${pending.hunks.reduce((n, h) => n + h.newLines, 0)} lines added, ${pending.hunks.reduce((n, h) => n + h.oldLines, 0)} removed). Continue with your task.`,
              timestamp: Date.now(),
            };
            const newMsgs = [...msgs, approvalMsg];
            useChat.setState({
              sessionMessages: { ...chatState.sessionMessages, [sessionId]: newMsgs },
              messages: [...chatState.messages, approvalMsg],
            });
          }
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
        }
      }
    },
    async rejectDiff(_sessionId: string, diffId: string) {
      const pending = pendingDiffProposals.get(diffId);
      if (pending) {
        pendingDiffProposals.delete(diffId);
        // File was never written (writes only happen on approveDiff), so no action needed.
        // The diff proposal is cleaned up and the UI will close the diff view.
      }
    },
    onStreamEvent(sessionId, cb) {
      // Clean up previous listener for this session to prevent leaks
      const prevCleanup = streamCleanups.get(sessionId);
      if (prevCleanup) prevCleanup();
      streamCallbacks.set(sessionId, cb);
      const cleanup = () => {
        streamCallbacks.delete(sessionId);
        streamCleanups.delete(sessionId);
      };
      streamCleanups.set(sessionId, cleanup);
      return cleanup;
    },
    cleanupStream(sessionId) {
      const cleanup = streamCleanups.get(sessionId);
      if (cleanup) cleanup();
    },
  },

  git: {
    async status(repoPath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ branch: string; modified: string[]; added: string[]; deleted: string[]; untracked: string[]; ahead?: number; behind?: number }>("git_status", { path: repoPath });
        return { ...result, ahead: result.ahead ?? 0, behind: result.behind ?? 0 };
      } catch (err) {
        throw new Error(`Git status failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
    async commit(repoPath, message) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ sha: string }>("git_commit", { path: repoPath, message });
      } catch (err) {
        throw new Error(`Git commit failed: ${(err as Error)?.message ?? "Unknown error"}`, { cause: err });
      }
    },
    async log(repoPath, limit = 20) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ sha: string; message: string; date: string; author: string }[]>("git_log", { path: repoPath, limit });
      } catch (err) {
        throw new Error(`Git log failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
    async branches(repoPath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ name: string; current: boolean }[]>("git_branches", { path: repoPath });
      } catch (err) {
        throw new Error(`Git branches failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
    async checkout(repoPath, branch) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("git_checkout", { path: repoPath, branch });
      } catch (err) {
        throw new Error(`Git checkout failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
    async createBranch(repoPath, name) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("git_create_branch", { path: repoPath, name });
      } catch (err) {
        throw new Error(`Git create branch failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
    async diffFile(repoPath, filePath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<string>("git_diff_file", { path: repoPath, file_path: filePath });
      } catch (err) {
        throw new Error(`Git diff failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
      }
    },
  },

  settings: {
    async get<T = unknown>(key: keyof AppSettings): Promise<T> {
      return (getStoredSettings() as unknown as Record<string, unknown>)[key] as T;
    },
    async set(key, value) {
      const s = getStoredSettings() as unknown as Record<string, unknown>;
      s[key as string] = value;
      storeSettings(s as unknown as AppSettings);
    },
    async getAll() { return getStoredSettings(); },
  },

  system: {
    async openDirectoryPicker() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "Open Workspace" });
      if (selected) return selected as string;
      return null;
    },
    async openLink(url) {
      const { open: shellOpen } = await import("@tauri-apps/plugin-shell");
      await shellOpen(url);
    },
    async revealInFinder(path) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("reveal_in_finder", { path });
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"@tauri-apps/api/core\");:", e);
        try {
          const { Command } = await import("@tauri-apps/plugin-shell");
          const cmd = isWindows() ? "explorer" : platform() === "mac" ? "open" : "xdg-open";
          const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path.includes("\\") ? path.split("\\").slice(0, -1).join("\\") : path;
          await Command.create(cmd, [dir]).execute();
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[DALAM] import(\"@tauri-apps/plugin-shell\");:", e);
        }
      }
    },
    async getAppVersion() { return "0.1.0"; },
    async clipboardReadText() {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("clipboard_read_text");
    },
    async clipboardWriteText(text: string) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clipboard_write_text", { text });
    },
    async clipboardHasImage() {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("clipboard_has_image");
    },
    async clipboardReadImage(): Promise<string | null> {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        return await invoke<string>("clipboard_read_image");
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] invoke<string>(\"clipboard_read_image\");:", e);
        return null;
      }
    },
    async notify(payload: { title: string; body: string; icon?: string }) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("notify", { payload });
    },
    async getSystemInfo() {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ os: string; arch: string; hostname: string; home_dir: string; shell: string; locale?: string }>("system_get_info");
      return { os: info.os, arch: info.arch, hostname: info.hostname, homeDir: info.home_dir, shell: info.shell, locale: info.locale };
    },
    async getWorkingDir() {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_working_dir");
    },
    async openWithSystemHandler(pathOrUrl: string) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_with_system_handler", { pathOrUrl });
    },
    async launchApp(appName: string, args?: string[], cwd?: string) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("launch_app", { appName, args, cwd });
    },
    async getEnv(key: string) {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("get_env", { key });
    },
    async getScreenInfo() {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ width: number; height: number; scale_factor: number }>("get_screen_info");
      return { width: info.width, height: info.height, scaleFactor: info.scale_factor };
    },
    async listProcesses() {
      const { invoke } = await import("@tauri-apps/api/core");
      const procs = await invoke<{ pid: number; name: string; cpu_usage: number; memory_kb: number }[]>("list_processes");
      return procs.map((p) => ({ pid: p.pid, name: p.name, cpuUsage: p.cpu_usage, memoryKb: p.memory_kb }));
    },
    async killProcess(pid: number) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("kill_process", { pid });
    },
    async getDiskSpace(path: string) {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ total_bytes: number; available_bytes: number; used_bytes: number }>("get_disk_space", { path });
      return { totalBytes: info.total_bytes, availableBytes: info.available_bytes, usedBytes: info.used_bytes };
    },
    async detectAvailableShells() {
      const { invoke } = await import("@tauri-apps/api/core");
      const shells = await invoke<{ name: string; path: string }[]>("detect_available_shells");
      return shells;
    },
    async detectInstalledIdes() {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<{ name: string; command: string; kind: string }[]>("detect_installed_ides");
    },
  },
};

export interface ParsedToolCall {
  name: string;
  args: Record<string, string>;
  raw: string;
}

export function decodeHtmlEntities(s: string): string {
  // Decode HTML entities in correct order: &amp; first (to avoid double-decoding)
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function parseAttributes(tagStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match key="value" or key='value', ensuring matching opening and closing quotes
  const regex = /([a-zA-Z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let match;
  while ((match = regex.exec(tagStr)) !== null) {
    const val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : "");
    // Unescape: remove backslash before quotes, then decode HTML entities
    attrs[match[1]] = decodeHtmlEntities(val.replace(/\\(["'])/g, "$1"));
  }
  return attrs;
}

/**
 * Extract tool calls from markdown code blocks.
 * LLMs like Llama 3.3 70B often wrap tool calls in ```xml or ``` tags.
 * Previously, code block stripping replaced these with "[code block]"
 * before they could be parsed, causing the agent to get stuck.
 */
export const KNOWN_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "create_file", "list_dir", "grep_file", "search_files",
  "run_command", "git_status", "git_commit", "git_log", "git_branch", "git_checkout", "git_diff_file",
  "clipboard_read", "clipboard_write", "notify", "system_info", "open_url",
  "launch_app", "reveal_in_finder",
  "get_env", "get_screen_info", "list_processes", "kill_process", "get_disk_space",
  "memory_save", "memory_search", "memory_delete", "memory_stats",
  "memory_maintain", "memory_extract", "memory_export", "memory_import",
  "task", "open_panel", "screenshot", "browser_navigate", "run_preview", "browser_execute", "create_task_plan", "question",
  // UI control tools
  "set_theme", "toggle_theme", "set_view_mode", "toggle_view_mode",
  "toggle_right_panel", "toggle_bottom_panel", "set_right_panel_tab", "set_bottom_panel_tab",
  "new_terminal", "terminal_write",
]);

export function extractToolCallsFromCodeBlocks(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  // Match any code block — LLMs may use any language hint or none at all
  const codeBlockRegex = /```[\w-]*\s*\n([\s\S]*?)```/gi;
  let blockMatch;
  while ((blockMatch = codeBlockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    // Extract all XML-like tool tags from inside the code block
    const tagRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?\/?>/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(blockContent)) !== null) {
      const tagName = tagMatch[1];
      if (!KNOWN_TOOL_NAMES.has(tagName) && !tagName.startsWith("mcp_")) continue;
      const attrsStr = tagMatch[2] || "";
      const args = parseAttributes(attrsStr);
      // For non-self-closing tags, extract content between open and close
      const fullTag = tagMatch[0];
      const isSelfClosing = fullTag.endsWith("/>");
      if (!isSelfClosing) {
        const closeTag = `</${tagName}>`;
        const closeIdx = blockContent.indexOf(closeTag, tagMatch.index + fullTag.length);
        if (closeIdx !== -1) {
          const innerContent = blockContent.slice(tagMatch.index + fullTag.length, closeIdx).trim();
          if (innerContent) {
            // For edit_file, extract <search> and <replace> tags from inner content
            if (tagName === "edit_file") {
              const searchMatch = /<search>([\s\S]*?)<\/search>/i.exec(innerContent);
              const replaceMatch = /<replace>([\s\S]*?)<\/replace>/i.exec(innerContent);
              if (searchMatch && replaceMatch) {
                args["search"] = searchMatch[1];
                args["replace"] = replaceMatch[1];
              } else {
                args["content"] = innerContent;
              }
            } else {
              args["content"] = innerContent;
            }
          }
        }
      }
      toolCalls.push({ name: tagName, args, raw: fullTag });
    }
  }
  return toolCalls;
}

// All tool regex patterns pre-compiled at module level (compiled once, reused per call)
// Fixed: Use proper key="value" attribute patterns instead of broken ATTRSelfClose
const REGEX_READ_FILE = /<read_file\s+path=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_WRITE_FILE = /<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/gi;
// Use greedy match for edit_file content to handle replacement text containing </edit_file>
const REGEX_EDIT_FILE = /<edit_file\s+path=["']([^"']+)["'](?:\s+(?:occurrence|occurence)=["'](\d+)["']?)?\s*>([\s\S]*?)<\/edit_file>/gi;
const REGEX_LIST_DIR = /<list_dir\s+path=["']([^"']+)["']\s*\/?>/gi;
const REGEX_GREP_FILE = /<grep_file\s+path=["']([^"']+)["']\s+pattern=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_SEARCH_FILES = /<search_files\s+([^>]*)\/?>/gi;
const REGEX_RUN_COMMAND = /<run_command\s+command=(?:"([^"]*)"|'([^']*)')\s*\/?>/gi;
const REGEX_BASH = /<bash\s+command=(?:"([^"]*)"|'([^']*)')\s*\/?>/gi;
const REGEX_SHELL = /<shell\s+command=(?:"([^"]*)"|'([^']*)')\s*\/?>/gi;
const REGEX_EXECUTE = /<execute\s+command=(?:"([^"]*)"|'([^']*)')\s*\/?>/gi;
const REGEX_GIT_STATUS = /<git_status\s*\/?>/gi;
const REGEX_GIT_COMMIT = /<git_commit\s+message=["']([^"']+)["']\s*\/?>/gi;
const REGEX_GIT_LOG = /<git_log\s*\/?>/gi;
const REGEX_GIT_BRANCH = /<git_branch\s*\/?>/gi;
const REGEX_GIT_CHECKOUT = /<git_checkout\s+branch=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_GIT_DIFF_FILE = /<git_diff_file\s+path=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_CLIPBOARD_READ = /<clipboard_read\s*\/?>/gi;
const REGEX_CLIPBOARD_WRITE = /<clipboard_write>([\s\S]*?)<\/clipboard_write>/gi;
const REGEX_NOTIFY = /<notify\s+title=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_SYSTEM_INFO = /<system_info\s*\/?>/gi;
const REGEX_OPEN_URL = /<open_url\s+url=["']([^"']+)["'](?:\s+[^>]*)?\s*\/?>/gi;
const REGEX_LAUNCH_APP = /<launch_app\s+([^>]*)\/?>/gi;
const REGEX_REVEAL_IN_FINDER = /<reveal_in_finder\s+([^>]*)\/?>/gi;
const REGEX_MEMORY_SAVE = /<memory_save\s+([\s\S]*?)>([\s\S]*?)<\/memory_save>/gi;
const REGEX_MEMORY_SEARCH = /<memory_search\s+([^>]*)\/?>/gi;
const REGEX_MEMORY_DELETE = /<memory_delete\s+([^>]*)\/?>/gi;
const REGEX_MEMORY_STATS = /<memory_stats\s*\/?>/gi;
const REGEX_MEMORY_MAINTAIN = /<memory_maintain\s*\/?>/gi;
const REGEX_MEMORY_EXTRACT = /<memory_extract\s*\/?>/gi;
const REGEX_MEMORY_EXPORT = /<memory_export\s*\/?>/gi;
const REGEX_MEMORY_IMPORT = /<memory_import\s*\/?>/gi;
const REGEX_TASK = /<task\s+([^>]*)\/?>/gi;
const REGEX_OPEN_PANEL = /<open_panel\s+([^>]*)\/?>/gi;
const REGEX_SCREENSHOT = /<screenshot\s*\/?>/gi;
const REGEX_BROWSER_NAVIGATE = /<browser_navigate\s+([^>]*)\/?>/gi;
const REGEX_RUN_PREVIEW = /<run_preview\s+([^>]*)\/?>/gi;
const REGEX_BROWSER_EXECUTE = /<browser_execute\s+([^>]*)\/?>/gi;
const REGEX_BROWSER_EXECUTE_BLOCK = /<browser_execute>([\s\S]*?)<\/browser_execute>/gi;
const REGEX_CREATE_TASK_PLAN = /<create_task_plan\s+([^>]*)\/?>/gi;
const REGEX_CREATE_TASK_PLAN_BLOCK = /<create_task_plan>([\s\S]*?)<\/create_task_plan>/gi;
const REGEX_QUESTION = /<question\s+([^>]*)\/?>/gi;
const REGEX_QUESTION_BLOCK = /<question>([\s\S]*?)<\/question>/gi;
const REGEX_MALFORMED_QUESTION = /(?:^|[\s<])question\s+question="([^"]*)"\s+options="([^"]*)"\s*\/?/gi;
const REGEX_GET_ENV = /<get_env\s+([^>]*)\/?>/gi;
const REGEX_GET_SCREEN_INFO = /<get_screen_info\s*\/?>/gi;
const REGEX_LIST_PROCESSES = /<list_processes\s*\/?>/gi;
const REGEX_KILL_PROCESS = /<kill_process\s+([^>]*)\/?>/gi;
const REGEX_GET_DISK_SPACE = /<get_disk_space\s+([^>]*)\/?>/gi;

export async function parseToolCalls(text: string): Promise<ParsedToolCall[]> {

  const toolCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  // 1. read_file
  REGEX_READ_FILE.lastIndex = 0;
  while ((match = REGEX_READ_FILE.exec(text)) !== null) {
    // New regex directly captures path in match[1]
    if (match[1]) {
      toolCalls.push({ name: "read_file", args: { path: match[1] }, raw: match[0] });
    }
  }

  // 2. write_file — greedy match to handle closing tags in content
  REGEX_WRITE_FILE.lastIndex = 0;
  while ((match = REGEX_WRITE_FILE.exec(text)) !== null) {
    toolCalls.push({ name: "write_file", args: { path: match[1], content: match[2] }, raw: match[0] });
  }

  // 3. edit_file — support optional occurrence attribute
  // Use greedy match to prevent premature closing on </edit_file> in content
  REGEX_EDIT_FILE.lastIndex = 0;
  while ((match = REGEX_EDIT_FILE.exec(text)) !== null) {
    const innerText = match[3];
    const searchMatch = /<search>([\s\S]*?)<\/search>/i.exec(innerText);
    const replaceMatch = /<replace>([\s\S]*?)<\/replace>/i.exec(innerText);
    if (searchMatch && replaceMatch) {
      const args: Record<string, string> = {
        path: match[1],
        search: searchMatch[1],
        replace: replaceMatch[1],
      };
      if (match[2]) args.occurrence = match[2];
      toolCalls.push({
        name: "edit_file",
        args,
        raw: match[0]
      });
    }
  }

  // 4. list_dir
  REGEX_LIST_DIR.lastIndex = 0;
  while ((match = REGEX_LIST_DIR.exec(text)) !== null) {
    toolCalls.push({ name: "list_dir", args: { path: match[1] }, raw: match[0] });
  }

  // 5. grep_file — new regex directly captures path and pattern
  REGEX_GREP_FILE.lastIndex = 0;
  while ((match = REGEX_GREP_FILE.exec(text)) !== null) {
    if (match[1] && match[2]) {
      // Extract optional regex and max_results from remaining attributes
      const extraAttrs = parseAttributes(match[0].slice(match[0].indexOf(match[2]) + match[2].length));
      toolCalls.push({ name: "grep_file", args: { path: match[1], pattern: match[2], regex: extraAttrs.regex, max_results: extraAttrs.max_results }, raw: match[0] });
    }
  }

  // 6. search_files — new regex directly captures pattern
  REGEX_SEARCH_FILES.lastIndex = 0;
  while ((match = REGEX_SEARCH_FILES.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.pattern) {
      toolCalls.push({
        name: "search_files",
        args: { path: attrs.path, pattern: attrs.pattern, glob: attrs.glob, regex: attrs.regex, max_results: attrs.max_results },
        raw: match[0],
      });
    }
  }

  // 7. run_command
  REGEX_RUN_COMMAND.lastIndex = 0;
  while ((match = REGEX_RUN_COMMAND.exec(text)) !== null) {
    toolCalls.push({ name: "run_command", args: { command: decodeHtmlEntities(match[1] != null ? match[1] : (match[2] ?? "")) }, raw: match[0] });
  }
  // bash/shell/execute aliases for run_command
  REGEX_BASH.lastIndex = 0;
  while ((match = REGEX_BASH.exec(text)) !== null) {
    toolCalls.push({ name: "bash", args: { command: decodeHtmlEntities(match[1] != null ? match[1] : (match[2] ?? "")) }, raw: match[0] });
  }
  REGEX_SHELL.lastIndex = 0;
  while ((match = REGEX_SHELL.exec(text)) !== null) {
    toolCalls.push({ name: "shell", args: { command: decodeHtmlEntities(match[1] != null ? match[1] : (match[2] ?? "")) }, raw: match[0] });
  }
  REGEX_EXECUTE.lastIndex = 0;
  while ((match = REGEX_EXECUTE.exec(text)) !== null) {
    toolCalls.push({ name: "execute", args: { command: decodeHtmlEntities(match[1] != null ? match[1] : (match[2] ?? "")) }, raw: match[0] });
  }

  // 8. git_status
  REGEX_GIT_STATUS.lastIndex = 0;
  while ((match = REGEX_GIT_STATUS.exec(text)) !== null) {
    toolCalls.push({ name: "git_status", args: {}, raw: match[0] });
  }

  // 9. git_commit
  REGEX_GIT_COMMIT.lastIndex = 0;
  while ((match = REGEX_GIT_COMMIT.exec(text)) !== null) {
    toolCalls.push({ name: "git_commit", args: { message: match[1] }, raw: match[0] });
  }

  // 10. git_log
  REGEX_GIT_LOG.lastIndex = 0;
  while ((match = REGEX_GIT_LOG.exec(text)) !== null) {
    toolCalls.push({ name: "git_log", args: {}, raw: match[0] });
  }

  // 11. git_branch
  REGEX_GIT_BRANCH.lastIndex = 0;
  while ((match = REGEX_GIT_BRANCH.exec(text)) !== null) {
    toolCalls.push({ name: "git_branch", args: {}, raw: match[0] });
  }

  // 12. git_checkout — new regex directly captures branch
  REGEX_GIT_CHECKOUT.lastIndex = 0;
  while ((match = REGEX_GIT_CHECKOUT.exec(text)) !== null) {
    if (match[1]) {
      toolCalls.push({ name: "git_checkout", args: { branch: match[1] }, raw: match[0] });
    }
  }

  // 13. git_diff_file — new regex directly captures path
  REGEX_GIT_DIFF_FILE.lastIndex = 0;
  while ((match = REGEX_GIT_DIFF_FILE.exec(text)) !== null) {
    if (match[1]) {
      toolCalls.push({ name: "git_diff_file", args: { path: match[1] }, raw: match[0] });
    }
  }

  // 14. clipboard_read
  REGEX_CLIPBOARD_READ.lastIndex = 0;
  while ((match = REGEX_CLIPBOARD_READ.exec(text)) !== null) {
    toolCalls.push({ name: "clipboard_read", args: {}, raw: match[0] });
  }

  // 15. clipboard_write
  REGEX_CLIPBOARD_WRITE.lastIndex = 0;
  while ((match = REGEX_CLIPBOARD_WRITE.exec(text)) !== null) {
    toolCalls.push({ name: "clipboard_write", args: { text: match[1] }, raw: match[0] });
  }

  // 16. notify — new regex directly captures title
  REGEX_NOTIFY.lastIndex = 0;
  while ((match = REGEX_NOTIFY.exec(text)) !== null) {
    if (match[1]) {
      // Extract optional body from remaining attributes
      const extraAttrs = parseAttributes(match[0].slice(match[0].indexOf(match[1]) + match[1].length));
      toolCalls.push({ name: "notify", args: { title: match[1], body: extraAttrs.body ?? "" }, raw: match[0] });
    }
  }

  // 17. system_info
  REGEX_SYSTEM_INFO.lastIndex = 0;
  while ((match = REGEX_SYSTEM_INFO.exec(text)) !== null) {
    toolCalls.push({ name: "system_info", args: {}, raw: match[0] });
  }

  // 18. open_url — new regex directly captures url
  REGEX_OPEN_URL.lastIndex = 0;
  while ((match = REGEX_OPEN_URL.exec(text)) !== null) {
    if (match[1]) {
      toolCalls.push({ name: "open_url", args: { url: match[1] }, raw: match[0] });
    }
  }

  // 19. launch_app
  REGEX_LAUNCH_APP.lastIndex = 0;
  while ((match = REGEX_LAUNCH_APP.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.name) {
      toolCalls.push({ name: "launch_app", args: { name: attrs.name, args: attrs.args, cwd: attrs.cwd }, raw: match[0] });
    }
  }

  // 20. reveal_in_finder
  REGEX_REVEAL_IN_FINDER.lastIndex = 0;
  while ((match = REGEX_REVEAL_IN_FINDER.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.path) {
      toolCalls.push({ name: "reveal_in_finder", args: { path: attrs.path }, raw: match[0] });
    }
  }

  // 21. memory_save
  REGEX_MEMORY_SAVE.lastIndex = 0;
  while ((match = REGEX_MEMORY_SAVE.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    toolCalls.push({
      name: "memory_save",
      args: {
        category: attrs.category || "project",
        tier: attrs.tier || "medium",
        summary: attrs.summary || "",
        tags: attrs.tags || "",
        content: match[2].trim(),
      },
      raw: match[0],
    });
  }

  // 22. memory_search
  REGEX_MEMORY_SEARCH.lastIndex = 0;
  while ((match = REGEX_MEMORY_SEARCH.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.query) {
      toolCalls.push({
        name: "memory_search",
        args: { query: attrs.query, category: attrs.category, limit: attrs.limit },
        raw: match[0],
      });
    }
  }

  // 23. memory_delete
  REGEX_MEMORY_DELETE.lastIndex = 0;
  while ((match = REGEX_MEMORY_DELETE.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.id) {
      toolCalls.push({
        name: "memory_delete",
        args: { id: attrs.id },
        raw: match[0],
      });
    }
  }

  // 24. memory_stats
  REGEX_MEMORY_STATS.lastIndex = 0;
  while ((match = REGEX_MEMORY_STATS.exec(text)) !== null) {
    toolCalls.push({ name: "memory_stats", args: {}, raw: match[0] });
  }

  // 25. memory_maintain
  REGEX_MEMORY_MAINTAIN.lastIndex = 0;
  while ((match = REGEX_MEMORY_MAINTAIN.exec(text)) !== null) {
    toolCalls.push({ name: "memory_maintain", args: {}, raw: match[0] });
  }

  // 26. memory_extract
  REGEX_MEMORY_EXTRACT.lastIndex = 0;
  while ((match = REGEX_MEMORY_EXTRACT.exec(text)) !== null) {
    toolCalls.push({ name: "memory_extract", args: {}, raw: match[0] });
  }

  // 27. memory_export
  REGEX_MEMORY_EXPORT.lastIndex = 0;
  while ((match = REGEX_MEMORY_EXPORT.exec(text)) !== null) {
    toolCalls.push({ name: "memory_export", args: {}, raw: match[0] });
  }

  // 28. memory_import
  REGEX_MEMORY_IMPORT.lastIndex = 0;
  while ((match = REGEX_MEMORY_IMPORT.exec(text)) !== null) {
    toolCalls.push({ name: "memory_import", args: {}, raw: match[0] });
  }

  // 29. task (sub-agent spawn)
  REGEX_TASK.lastIndex = 0;
  while ((match = REGEX_TASK.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.prompt) {
      toolCalls.push({
        name: "task",
        args: {
          prompt: attrs.prompt,
          description: attrs.description || "",
          subagent_type: attrs.subagent_type || "general",
          background: attrs.background || "false",
        },
        raw: match[0],
      });
    }
  }

  // 30. open_panel
  REGEX_OPEN_PANEL.lastIndex = 0;
  while ((match = REGEX_OPEN_PANEL.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.panel) {
      toolCalls.push({ name: "open_panel", args: attrs, raw: match[0] });
    }
  }

  // 31. screenshot
  REGEX_SCREENSHOT.lastIndex = 0;
  while ((match = REGEX_SCREENSHOT.exec(text)) !== null) {
    toolCalls.push({ name: "screenshot", args: {}, raw: match[0] });
  }

  // 32. browser_navigate
  REGEX_BROWSER_NAVIGATE.lastIndex = 0;
  while ((match = REGEX_BROWSER_NAVIGATE.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.url) {
      toolCalls.push({ name: "browser_navigate", args: attrs, raw: match[0] });
    }
  }

  // 33. run_preview
  REGEX_RUN_PREVIEW.lastIndex = 0;
  while ((match = REGEX_RUN_PREVIEW.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.command) {
      toolCalls.push({ name: "run_preview", args: attrs, raw: match[0] });
    }
  }

  // 34. browser_execute (self-closing)
  REGEX_BROWSER_EXECUTE.lastIndex = 0;
  while ((match = REGEX_BROWSER_EXECUTE.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.script) {
      toolCalls.push({ name: "browser_execute", args: attrs, raw: match[0] });
    }
  }
  // Also handle <browser_execute>script content</browser_execute>
  REGEX_BROWSER_EXECUTE_BLOCK.lastIndex = 0;
  while ((match = REGEX_BROWSER_EXECUTE_BLOCK.exec(text)) !== null) {
    toolCalls.push({ name: "browser_execute", args: { script: match[1].trim() }, raw: match[0] });
  }

  // 35. create_task_plan (self-closing)
  REGEX_CREATE_TASK_PLAN.lastIndex = 0;
  while ((match = REGEX_CREATE_TASK_PLAN.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.tasks) {
      toolCalls.push({ name: "create_task_plan", args: attrs, raw: match[0] });
    }
  }
  // Also handle <create_task_plan>task list</create_task_plan>
  REGEX_CREATE_TASK_PLAN_BLOCK.lastIndex = 0;
  while ((match = REGEX_CREATE_TASK_PLAN_BLOCK.exec(text)) !== null) {
    toolCalls.push({ name: "create_task_plan", args: { tasks: match[1].trim() }, raw: match[0] });
  }

  // 36. question (self-closing)
  REGEX_QUESTION.lastIndex = 0;
  while ((match = REGEX_QUESTION.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.question) {
      toolCalls.push({ name: "question", args: attrs, raw: match[0] });
    }
  }
  // Also handle <question>text</question>
  REGEX_QUESTION_BLOCK.lastIndex = 0;
  while ((match = REGEX_QUESTION_BLOCK.exec(text)) !== null) {
    toolCalls.push({ name: "question", args: { question: match[1].trim() }, raw: match[0] });
  }
  // Handle malformed question tags without opening < (LLM output quirk)
  REGEX_MALFORMED_QUESTION.lastIndex = 0;
  while ((match = REGEX_MALFORMED_QUESTION.exec(text)) !== null) {
    // Only add if not already captured by the proper regex
    if (match[1] && !toolCalls.some(tc => tc.name === "question" && tc.args.question === match![1])) {
      toolCalls.push({ name: "question", args: { question: match[1], options: match[2] }, raw: match[0] });
    }
  }

  // 37. get_env
  REGEX_GET_ENV.lastIndex = 0;
  while ((match = REGEX_GET_ENV.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.key) {
      toolCalls.push({ name: "get_env", args: { key: attrs.key }, raw: match[0] });
    }
  }

  // 38. get_screen_info
  REGEX_GET_SCREEN_INFO.lastIndex = 0;
  while ((match = REGEX_GET_SCREEN_INFO.exec(text)) !== null) {
    toolCalls.push({ name: "get_screen_info", args: {}, raw: match[0] });
  }

  // 39. list_processes
  REGEX_LIST_PROCESSES.lastIndex = 0;
  while ((match = REGEX_LIST_PROCESSES.exec(text)) !== null) {
    toolCalls.push({ name: "list_processes", args: {}, raw: match[0] });
  }

  // 40. kill_process
  REGEX_KILL_PROCESS.lastIndex = 0;
  while ((match = REGEX_KILL_PROCESS.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.pid) {
      toolCalls.push({ name: "kill_process", args: { pid: attrs.pid }, raw: match[0] });
    }
  }

  // 41. get_disk_space
  REGEX_GET_DISK_SPACE.lastIndex = 0;
  while ((match = REGEX_GET_DISK_SPACE.exec(text)) !== null) {
    const attrs = parseAttributes(match[1]);
    if (attrs.path) {
      toolCalls.push({ name: "get_disk_space", args: { path: attrs.path }, raw: match[0] });
    }
  }

  // 25. Generic MCP Tool calls
  // Server names may contain underscores, so we match the full mcp_ prefix + greedy body
  // and later split against known MCP server names
  // Hoisted dynamic import to avoid repeating per match
  // NOTE: Uses local regex instance to avoid lastIndex sharing race from the await above
  let mcpServers: { name: string; enabled: boolean; transport?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }[] = [];
  try {
    const { useSkillsMcp } = await import("../store/useAppStore");
    mcpServers = useSkillsMcp.getState().mcpServers;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DALAM] import(\"../store/useAppStore\");:", e);
  }
  const localMcpTagRe = /<mcp_([\w-]+(?:_[\w-]+)*)\s*([\s\S]*?)\s*(\/?)>/gi;
  let mcpMatch;
  while ((mcpMatch = localMcpTagRe.exec(text)) !== null) {
    const rawTag = mcpMatch[0];
    const afterPrefix = mcpMatch[1]; // everything after "mcp_" before attributes/close
    const bodyOrAttrs = mcpMatch[2] || "";
    const selfClose = mcpMatch[3] === "/";
    if (!afterPrefix) continue;

    // Try to find the split point by matching against known server names
    // Prefer exact match, then fall back to prefix match
    let serverName = "";
    let toolName = "";
    let foundServer = false;
    const exactMatch = mcpServers.find(s => afterPrefix === s.name + "_");
    if (exactMatch) {
      serverName = exactMatch.name;
      toolName = afterPrefix.slice(exactMatch.name.length + 1);
      foundServer = true;
    } else {
      // Sort by name length descending to match longest server name first (e.g. "stitch-api" before "stitch")
      const sortedServers = [...mcpServers].sort((a, b) => b.name.length - a.name.length);
      for (const srv of sortedServers) {
        const prefix = srv.name + "_";
        if (afterPrefix.startsWith(prefix)) {
          serverName = srv.name;
          toolName = afterPrefix.slice(prefix.length);
          foundServer = true;
          break;
        }
      }
    }
    if (!foundServer) {
      // Fallback: use first underscore split
      const firstUnderscore = afterPrefix.indexOf("_");
      if (firstUnderscore === -1) continue;
      serverName = afterPrefix.slice(0, firstUnderscore);
      toolName = afterPrefix.slice(firstUnderscore + 1);
    }
    if (!toolName) continue;
    const fullName = `mcp_${serverName}_${toolName}`;

    if (selfClose || rawTag.endsWith("/>") || rawTag.trim().endsWith("/>")) {
      const args: Record<string, string> = {};
      const attrRegex = /([a-z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gi;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(bodyOrAttrs)) !== null) {
        const val = attrMatch[2] !== undefined ? attrMatch[2] : (attrMatch[3] !== undefined ? attrMatch[3] : "");
        args[attrMatch[1]] = val.replace(/\\(["'])/g, "$1");
      }
      toolCalls.push({ name: fullName, args, raw: rawTag });
    } else {
      const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const closeTagName = `</mcp_${escapeRegex(serverName)}_${escapeRegex(toolName)}>`;
      const closeRegex = new RegExp(closeTagName, "i");
      const subText = text.slice(mcpMatch.index);
      const closeMatch = closeRegex.exec(subText);
      if (closeMatch) {
        const fullBlock = subText.slice(0, closeMatch.index + closeMatch[0].length);
        const innerContent = subText.slice(rawTag.length, closeMatch.index);

        const args: Record<string, string> = {};
        const childRegex = /<([a-z0-9_-]+)>([\s\S]*?)<\/\1>/gi;
        let childMatch;
        let foundAny = false;
        while ((childMatch = childRegex.exec(innerContent)) !== null) {
          args[childMatch[1]] = childMatch[2].trim();
          foundAny = true;
        }

        if (!foundAny) {
          const trimmed = innerContent.trim();
          if (trimmed) {
            args["content"] = trimmed;
          }
        }
        toolCalls.push({ name: fullName, args, raw: fullBlock });
        // Advance past the full block. Guard against fullBlock being shorter
        // than the raw match (which would cause an infinite loop if we jumped
        // backwards). Fall back to the regex's natural advancement otherwise.
        const naturalEnd = mcpMatch.index + mcpMatch[0].length;
        const safeEnd = fullBlock.length >= mcpMatch[0].length
          ? mcpMatch.index + fullBlock.length
          : naturalEnd;
        localMcpTagRe.lastIndex = safeEnd;
      }
    }
  }

  // 26. Anthropic antml:function_calls / <invoke> format
  // Models like MiniMax output: antml:function_calls<invoke name="tool">parameter name="key">value</antml:parameter></antml:function_calls
  const localAntmlBlockRe = /(?:antml:function_calls\s*)?<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:antml:)?function_calls\s*>/gi;
  let antmlMatch;
  while ((antmlMatch = localAntmlBlockRe.exec(text)) !== null) {
    const toolName = antmlMatch[1];
    const inner = antmlMatch[2];
    const args: Record<string, string> = {};
    const paramRegex = /(?:parameter\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(inner)) !== null) {
      if (paramMatch[1]) args[paramMatch[1]] = paramMatch[2].trim();
    }
    if (Object.keys(args).length === 0) {
      const trimmed = inner.trim();
      if (trimmed) args["content"] = trimmed;
    }
    toolCalls.push({ name: toolName, args, raw: antmlMatch[0] });
  }

  // 27. Standalone <invoke> tags without wrapping antml:function_calls
  const localInvokeRe = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
  let invokeMatch;
  while ((invokeMatch = localInvokeRe.exec(text)) !== null) {
    // Skip if already captured by the antml block regex above
    if (toolCalls.some(tc => tc.raw.includes(invokeMatch![0]))) continue;
    const toolName = invokeMatch[1];
    const inner = invokeMatch[2];
    const args: Record<string, string> = {};
    const paramRegex = /parameter\s*name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(inner)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }
    if (Object.keys(args).length === 0) {
      const trimmed = inner.trim();
      if (trimmed) args["content"] = trimmed;
    }
    toolCalls.push({ name: toolName, args, raw: invokeMatch[0] });
  }

  // Decode HTML entities in all parsed tool call args (handles &quot; from _emitToolCallXml)
  for (const tc of toolCalls) {
    for (const [k, v] of Object.entries(tc.args)) {
      if (typeof v === "string") tc.args[k] = decodeHtmlEntities(v);
    }
  }

  return toolCalls;
}

function waitForToolApproval(toolCallId: string, abortSignal?: AbortSignal): Promise<"approved" | "denied"> {
  const TIMEOUT_MS = 600_000; // 10 minutes — matches the safety timer's tool-approval timeout
  _debugLog(`waitForToolApproval: waiting for tool ${toolCallId}`);
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (abortHandler && abortSignal) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
      // Unregister from resolver map and pending resolutions
      import("../store/useAppStore").then(({ _toolCallResolvers, _pendingResolutions }) => {
        _toolCallResolvers.delete(toolCallId);
        _pendingResolutions.delete(toolCallId);
      }).catch(() => { });
    };

    const finish = (decision: "approved" | "denied") => {
      // Guard against stale resolution after abort
      if (resolved) return;
      resolved = true;
      cleanup();
      _debugLog(`waitForToolApproval: resolved tool ${toolCallId} -> ${decision}`);
      resolve(decision);
    };

    // Check if decision was already made (e.g., auto-approved before waitForToolApproval was registered)
    // Register resolver FIRST, THEN check for pre-existing decision.
    // Previously these were two separate import().then() chains which created
    // a race window: resolveToolApproval could store a decision in
    // _pendingResolutions after the check but before the resolver was registered,
    // leaving the promise stuck forever. Combining into a single chain eliminates
    // this window.
    import("../store/useAppStore").then(({ _toolCallResolvers, _pendingResolutions }) => {
      if (resolved) return;
      // Register resolver so resolveToolApproval can call us directly
      _toolCallResolvers.set(toolCallId, (decision: "approved" | "denied") => {
        finish(decision);
        return decision;
      });
      // Now check for pre-existing decision (e.g., auto-approved before we registered)
      const existing = _pendingResolutions.get(toolCallId);
      if (existing) {
        _pendingResolutions.delete(toolCallId);
        _toolCallResolvers.delete(toolCallId);
        finish(existing);
      }
    }).catch((err) => {
      if (import.meta.env.DEV) console.error("Failed to register tool call resolver:", err);
      finish("denied");
    });

    // Listen for abort signal (must assign handler before addEventListener to avoid race)
    if (abortSignal) {
      abortHandler = () => finish("denied");
      if (abortSignal.aborted) {
        finish("denied");
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    // Safety timeout
    timer = setTimeout(() => {
      if (!resolved) {
        _debugLog(`waitForToolApproval: timed out after ${TIMEOUT_MS}ms for tool ${toolCallId}`);
        // Notify the store so the UI tool status is updated
        void import("../store/useAppStore").then(({ useChat }) => {
          try {            void useChat.getState().resolveToolApproval(toolCallId, "denied");} catch (e) { if (import.meta.env.DEV) console.warn("[DALAM] useChat.getState().resolveToolApproval(toolCallId,", e); }
        }).catch(() => { });
        finish("denied");
      }
    }, TIMEOUT_MS);
  });
}

// Per-tool execution timeouts (ms)
const TOOL_TIMEOUTS: Record<string, number> = {
  read_file: 10_000,
  write_file: 30_000,
  edit_file: 30_000,
  run_command: 60_000,
  bash: 60_000,
  shell: 60_000,
  execute: 60_000,
  grep_file: 30_000,
  search_files: 60_000,
  git_status: 15_000,
  git_commit: 30_000,
  git_log: 15_000,
  git_branch: 15_000,
  git_checkout: 15_000,
  git_diff_file: 15_000,
  list_dir: 10_000,
  question: 600_000,
  default: 30_000,
};

// Unified tool result truncation limits (chars)
const TOOL_RESULT_LIMITS = {
  default: 30_000,
  run_command: 50_000,
  sub_agent: 15_000,
  read_file: 100_000,
} as const;

function truncateToolResult(result: string, toolName: string): string {
  const limit = (TOOL_RESULT_LIMITS as Record<string, number>)[toolName] ?? TOOL_RESULT_LIMITS.default;
  if (result.length <= limit) return result;
  return result.slice(0, limit) + `\n\n[Truncated at ${limit} chars, showing first ${limit} of ${result.length} total]`;
}

async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
  abortSignal?: AbortSignal
): Promise<T> {
  if (abortSignal?.aborted) throw new Error("Tool execution aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const abortPromise = abortSignal
    ? new Promise<T>((_, reject) => {
        abortHandler = () => reject(new Error("Tool execution aborted"));
        abortSignal.addEventListener("abort", abortHandler);
      })
    : undefined;
  const competitors: Promise<T>[] = [
    promise.finally(() => { if (timer !== undefined) clearTimeout(timer); }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    }),
  ];
  if (abortPromise) competitors.push(abortPromise);
  try {
    return await Promise.race(competitors);
  } finally {
    if (abortHandler !== undefined && abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
    clearTimeout(timer);
  }
}

async function executeTool(name: string, args: Record<string, string>, workspacePath: string, emit: (event: StreamEvent) => void, autoApprove = false, abortSignal?: AbortSignal): Promise<string> {
  const { validateToolArgs } = await import("./toolSchemas");
  const validation = validateToolArgs(name, args);
  if (!validation.valid) {
    return `Error: ${validation.error}`;
  }

  const timeout = TOOL_TIMEOUTS[name] ?? TOOL_TIMEOUTS.default;
  return executeWithTimeout(executeToolInner(name, validation.args as Record<string, string>, workspacePath, emit, autoApprove, abortSignal), timeout, name, abortSignal);
}

async function executeToolInner(name: string, args: Record<string, string>, workspacePath: string, emit: (event: StreamEvent) => void, autoApprove = false, abortSignal?: AbortSignal): Promise<string> {

  if (name === "read_file") {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const MAX_READ_SIZE = 1024 * 1024; // 1MB limit for agent reads
    let fileSize: number | undefined;
    let statFailed = false;
    try {
      const fileInfo = await stat(args.path);
      fileSize = (fileInfo as { size?: number }).size ?? 0;
      if (fileSize > MAX_READ_SIZE) {
        return `[File too large to read: ${fileSize} bytes. Use offset/limit to read specific portions, or list_dir/grep_file to inspect.]`;
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] stat(args.path);:", e);
      // stat() failed — mark as failed but DON'T proceed with full read
      statFailed = true;
    }
    if (statFailed) {
      return `[Unable to read file: ${args.path}. The file may not exist or access was denied.]`;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(args.path);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] readFile(args.path);:", e);
      return `[Unable to read file: ${args.path}. The file may have been deleted or access was denied.]`;
    }
    const ext = args.path.split(".").pop()?.toLowerCase() ?? "";
    const textExts = new Set(["ts", "tsx", "js", "jsx", "json", "md", "mdx", "py", "rs", "css", "html", "yml", "yaml", "toml", "txt", "csv", "xml", "svg", "sh", "bash", "zsh", "fish", "sql", "graphql", "prisma", "env", "gitignore", "dockerignore", "editorconfig", "prettierrc", "eslintrc", "lock", "log", "cfg", "ini", "conf"]);
    let text: string;
    if (textExts.has(ext) || ext === "") {
      text = new TextDecoder().decode(bytes);
    } else {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (decoded.includes("\0") || (decoded.match(/\uFFFD/g)?.length ?? 0) > decoded.length * 0.01) {
        return `[Binary file: ${args.path.split("/").pop()} — ${bytes.length} bytes]`;
      }
      text = decoded;
    }
    // Support offset (line-based) and limit for reading specific portions
    const offsetRaw = args.offset !== undefined ? parseInt(String(args.offset), 10) : undefined;
    const limitRaw = args.limit !== undefined ? parseInt(String(args.limit), 10) : undefined;
    const offset = offsetRaw !== undefined && !isNaN(offsetRaw) ? Math.max(1, offsetRaw) : undefined;
    const limit = limitRaw !== undefined && !isNaN(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    if (offset !== undefined || limit !== undefined) {
      const lines = text.split("\n");
      const totalLines = lines.length;
      const startLine = Math.max(0, (offset ?? 1) - 1); // 1-indexed to 0-indexed
      const endLine = limit !== undefined ? Math.min(totalLines, startLine + limit) : totalLines;
      const selectedLines = lines.slice(startLine, endLine);
      const lineStart = startLine + 1;
      const lineEnd = Math.min(endLine, totalLines);
      const header = `--- ${args.path} (lines ${lineStart}-${lineEnd} of ${totalLines}) ---`;
      const numbered = selectedLines.map((line, i) => `${lineStart + i}: ${line}`).join("\n");
      return `${header}\n${numbered}`;
    }
    // Full file read — add header with line count and size
    const totalLines = text.split("\n").length;
    const sizeKB = (bytes.length / 1024).toFixed(1);
    const header = `--- ${args.path} (lines 1-${totalLines}, ${sizeKB}KB) ---`;
    return `${header}\n${text}`;
  }

  if (name === "write_file") {
    if (typeof args.content !== "string") {
      return "Error: write_file requires a 'content' argument (string)";
    }
    const { writeFile, readFile: fsReadFile, mkdir: fsMkdir } = await import("@tauri-apps/plugin-fs");
    // Auto-create parent directory if it doesn't exist (like mkdir -p)
    const parentDir = dirname(args.path);
    if (parentDir && parentDir !== "." && parentDir !== "/") {
      try { await fsMkdir(parentDir, { recursive: true }); } catch { /* directory may already exist */ }
    }
    let oldContent = "";
    try {
      const existingBytes = await fsReadFile(args.path);
      oldContent = new TextDecoder().decode(existingBytes);
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] fsReadFile(args.path);:", e);
    }
    const newContent = args.content;

    // When auto-approved (permission already granted), write directly without diff proposal
    if (autoApprove) {
      await writeFile(args.path, new TextEncoder().encode(newContent));
      // Record change for undo support
      try {
        const { recordChange: rc } = await import("./changeStack");
        rc({ filePath: args.path, beforeContent: oldContent, afterContent: newContent, toolCallId: "write-" + crypto.randomUUID(), messageId: "auto" });
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"./changeStack\");:", e);
      }
      // Emit file-changed event for UI tracking
      emit({
        type: "file-changed",
        change: {
          path: args.path,
          action: oldContent ? "modified" : "created",
          additions: newContent.split("\n").length,
          deletions: oldContent ? oldContent.split("\n").length : 0,
          preview: newContent.split("\n").slice(0, 20).join("\n"),
        },
      });
      return `Wrote ${args.path} (${newContent.length} bytes)`;
    }

    // Otherwise create diff proposal for user approval
    const diffId = "diff-" + crypto.randomUUID();
    // Use proper Myers diff algorithm instead of crude all-removes-then-adds
    const { computeDiff } = await import("./diff");
    const computed = computeDiff(oldContent, newContent);
    const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
    for (const hunk of computed.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "remove") {
          diffLines.push({ type: "remove", content: line.content });
        } else if (line.type === "add") {
          diffLines.push({ type: "add", content: line.content });
        }
      }
    }
    const hunks = computed.hunks.length > 0
      ? computed.hunks.map(h => ({ oldStart: h.oldStart, oldLines: h.oldCount, newStart: h.newStart, newLines: h.newCount, lines: h.lines.map(l => ({ type: l.type === "remove" ? "remove" as const : "add" as const, content: l.content })) }))
      : [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: newContent.split("\n").length, lines: newContent.split("\n").map(l => ({ type: "add" as const, content: l })) }];
    const proposal: DiffProposal = { diffId, filePath: args.path, oldContent, newContent, hunks, createdAt: Date.now() };
    pendingDiffProposals.set(diffId, proposal);
    emit({ type: "diff-proposed", proposal });
    // File is written only when the diff is approved via approveDiff()
    return `File write proposed: ${args.path} (awaiting approval)`;
  }

  if (name === "edit_file") {
    if (typeof args.search !== "string") {
      return "Error: edit_file requires a 'search' argument (string)";
    }
    if (typeof args.replace !== "string") {
      return "Error: edit_file requires a 'replace' argument (string)";
    }
    if (args.search.trim() === "") {
      return "Error: edit_file 'search' argument cannot be empty. Provide the exact text to find in the file.";
    }
    const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(args.path);
    const original = new TextDecoder().decode(bytes);

    // Support optional occurrence index (0-based) for targeting specific matches
    const occurrenceRaw = args.occurrence !== undefined ? parseInt(String(args.occurrence), 10) : 0;
    const occurrence = isNaN(occurrenceRaw) || occurrenceRaw < 0 ? 0 : occurrenceRaw;

    // Find the N-th occurrence of the search string
    let searchIdx = -1;
    let searchCount = 0;
    let scanFrom = 0;
    while (searchCount <= occurrence) {
      const idx = original.indexOf(args.search, scanFrom);
      if (idx === -1) break;
      if (searchCount === occurrence) {
        searchIdx = idx;
        break;
      }
      scanFrom = idx + 1;
      searchCount++;
    }

    if (searchIdx === -1) {
      // Provide context about what was searched and where it might be
      const totalOccurrences = (() => {
        let count = 0, from = 0;
        while ((from = original.indexOf(args.search, from)) !== -1) { count++; from += 1; }
        return count;
      })();
      const searchPreview = args.search.length > 100 ? args.search.slice(0, 100) + "..." : args.search;
      if (totalOccurrences === 0) {
        return `Error: Search block not found in ${args.path}.\nSearched for: "${searchPreview}"\nFile has ${original.split("\n").length} lines. Verify the search text matches exactly (including whitespace and indentation).`;
      }
      return `Error: Found ${totalOccurrences} occurrence(s) of search block in ${args.path}, but occurrence ${occurrence} does not exist (0-indexed). Use occurrence="0" for the first match, "1" for the second, etc.`;
    }

    const updated = original.slice(0, searchIdx) + args.replace + original.slice(searchIdx + args.search.length);
    const oldLines = args.search.split("\n");
    const newLines = args.replace.split("\n");

    // When auto-approved (permission already granted), write directly without diff proposal
    if (autoApprove) {
      await writeFile(args.path, new TextEncoder().encode(updated));
      // Record change for undo support
      try {
        const { recordChange: rc } = await import("./changeStack");
        rc({ filePath: args.path, beforeContent: original, afterContent: updated, toolCallId: "edit-" + crypto.randomUUID(), messageId: "auto" });
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] import(\"./changeStack\");:", e);
      }
      // Emit file-changed event for UI tracking
      const searchLine = original.substring(0, searchIdx).split("\n").length;
      emit({
        type: "file-changed",
        change: {
          path: args.path,
          action: "modified",
          additions: newLines.length,
          deletions: oldLines.length,
          preview: [
            `@@ -${searchLine},${oldLines.length} +${searchLine},${newLines.length} @@`,
            ...oldLines.map((l: string) => `- ${l}`),
            ...newLines.map((l: string) => `+ ${l}`),
          ].join("\n"),
        },
      });
      return `Edited ${args.path} (${oldLines.length} → ${newLines.length} lines)`;
    }

    // Otherwise create diff proposal for user approval
    const diffId = "diff-" + crypto.randomUUID();
    // Use proper Myers diff algorithm instead of crude all-removes-then-adds
    const { computeDiff: computeDiffEdit } = await import("./diff");
    const computedEdit = computeDiffEdit(original, updated);
    const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
    for (const hunk of computedEdit.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "remove") {
          diffLines.push({ type: "remove", content: line.content });
        } else if (line.type === "add") {
          diffLines.push({ type: "add", content: line.content });
        }
      }
    }
    const searchLine = searchIdx >= 0 ? original.substring(0, searchIdx).split("\n").length : 1;
    const hunks = computedEdit.hunks.length > 0
      ? computedEdit.hunks.map(h => ({ oldStart: h.oldStart, oldLines: h.oldCount, newStart: h.newStart, newLines: h.newCount, lines: h.lines.map(l => ({ type: l.type === "remove" ? "remove" as const : "add" as const, content: l.content })) }))
      : [{ oldStart: searchLine, oldLines: oldLines.length, newStart: searchLine, newLines: newLines.length, lines: diffLines }];
    const proposal: DiffProposal = { diffId, filePath: args.path, oldContent: original, newContent: updated, hunks, createdAt: Date.now() };
    pendingDiffProposals.set(diffId, proposal);
    emit({ type: "diff-proposed", proposal });
    // File is written only when the diff is approved via approveDiff()
    return `File edit proposed: ${args.path} (line ${searchLine}, awaiting approval)`;
  }

  if (name === "list_dir") {
    const nodes = await dalamAPI.fs.listDir(args.path);
    return JSON.stringify(nodes.map(n => ({ name: n.name, path: n.path, type: n.type })), null, 2);
  }

  if (name === "grep_file") {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    try {
      const fileInfo = await stat(args.path);
      const fileSize = (fileInfo as { size?: number }).size ?? 0;
      if (fileSize > 5 * 1024 * 1024) {
        return `[File too large to grep: ${(fileSize / 1024 / 1024).toFixed(1)}MB. Use run_command with grep instead.]`;
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] stat(args.path);:", e);
    }
    const bytes = await readFile(args.path);
    const contentDecoder = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (contentDecoder.includes("\0") || (contentDecoder.match(/\uFFFD/g)?.length ?? 0) > bytes.length * 0.01) {
      return `[Binary file: ${args.path.split("/").pop()} — ${bytes.length} bytes. Use run_command with grep instead.]`;
    }
    const lines = contentDecoder.split("\n");
    const pattern = args.pattern;
    const isRegex = args.regex === "true";
    const maxResults = args.max_results ? parseInt(args.max_results, 10) : 50;
    const matches: { line: number; text: string }[] = [];
    try {
      const re = isRegex ? new RegExp(pattern, "i") : null;
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        const line = lines[i];
        // Skip very long lines with regex to prevent ReDoS
        if (re && line.length > 10000) continue;
        if (re ? re.test(line) : line.includes(pattern)) {
          matches.push({ line: i + 1, text: line.trim() });
        }
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] const re = isRegex ? new RegExp(pattern, \"i\") : nu:", e);
      return "Error: Invalid regex pattern";
    }
    if (matches.length === 0) return `No matches found for "${pattern}" in ${args.path}`;
    return matches.map(m => `${m.line}: ${m.text}`).join("\n");
  }

  if (name === "search_files") {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const searchPath = args.path || workspacePath;
    const pattern = args.pattern;
    const fileGlob = args.glob || "*";
    const maxResults = args.max_results ? parseInt(args.max_results, 10) : 100;
    const isRegex = args.regex === "true";
    const results: { file: string; line: number; text: string }[] = [];
    let re: RegExp | null = null;
    try {
      re = isRegex ? new RegExp(pattern, "i") : null;
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] re = isRegex ? new RegExp(pattern, \"i\") : null;:", e);
      return "Error: Invalid regex pattern";
    }
    // Convert glob to regex, preserving character classes like [abc].
    // Strategy: escape all regex metacharacters EXCEPT [ and ] which are glob character classes.
    // Then convert glob wildcards to regex equivalents.
    const globRegex = new RegExp(
      "^" + fileGlob
        .replace(/[.+^${}()|\\]/g, "\\$&")  // Escape regex metacharacters EXCEPT brackets
        .replace(/\*\*\//g, ".*")  // **/ → match any path prefix
        .replace(/\*\*/g, ".*")    // ** → match anything
        .replace(/\*/g, "[^/]*")   // * → match within segment
        .replace(/\?/g, "[^/]") +  // ? → single char
      "$"
    );
    async function searchDir(dir: string, depth: number, visited: Set<string> = new Set()) {
      if (depth > 10 || results.length >= maxResults) return;
      // Check for symlink cycles by tracking visited directory paths
      if (visited.has(dir)) return;
      visited.add(dir);
      const { readDir: rd } = await import("@tauri-apps/plugin-fs");
      let entries;
      try {
        entries = await rd(dir);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] entries = await rd(dir);", e);
        return;
      }
      for (const entry of entries) {
        if (!entry.name || results.length >= maxResults) break;
        if (JUNK_DIRS.has(entry.name)) continue;
        const full = joinPathUtil(dir, entry.name!);
        if (entry.isDirectory) {
          await searchDir(full, depth + 1, visited);
        } else {
          // Check glob against both bare filename and relative path (to support dir-prefixed globs like src/**/*.ts)
          const relPath = full.startsWith(searchPath) ? full.slice(searchPath.length + 1) : full;
          if (!globRegex.test(relPath) && !globRegex.test(entry.name)) continue;
          // Skip binary files
          const ext = entry.name?.split(".").pop()?.toLowerCase() ?? "";
          const binaryExts = new Set(["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "mp3", "mp4", "avi", "mov", "pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite"]);
          if (binaryExts.has(ext)) continue;
          try {
            const bytes = await readFile(full);
            const content = new TextDecoder().decode(bytes);
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const line = lines[i];
              // Skip very long lines with regex to prevent ReDoS
              if (re && line.length > 10000) continue;
              const match = re ? re.test(line) : line.includes(pattern);
              if (match) {
                results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
              }
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] readFile(full);:", e);
          }
        }
      }
    }
    await searchDir(searchPath, 0);
    if (results.length === 0) return `No matches found for "${pattern}" in ${searchPath}`;
    return results.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n");
  }

  if (name === "bash" || name === "shell" || name === "execute") {
    return executeToolInner("run_command", args, workspacePath, emit, autoApprove);
  }

  if (name === "grep") {
    return executeToolInner("grep_file", args, workspacePath, emit, autoApprove);
  }
  if (name === "search") {
    return executeToolInner("search_files", args, workspacePath, emit, autoApprove);
  }

  if (name === "run_command") {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const program = isWindows() ? "powershell" : "bash";
    const commandArgs = isWindows() ? ["-NoProfile", "-NonInteractive", "-Command", args.command] : ["-c", args.command];
    const cmd = Command.create(program, commandArgs, { cwd: workspacePath || "." });
    const child = await cmd.spawn();
    let killed = false;
    const timeoutMs = TOOL_TIMEOUTS.run_command ?? 60_000;

    // Abort signal handler: kill the child process immediately
    const abortHandler = () => {
      if (!killed) {
        killed = true;
        child.kill().catch(() => {});
      }
    };
    if (abortSignal?.aborted) abortHandler();
    else if (abortSignal) abortSignal.addEventListener("abort", abortHandler);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        new Promise<string>((resolve) => {
          let stdout = "";
          let stderr = "";
          cmd.stdout.on("data", (data: string) => { if (!killed) stdout += data; });
          cmd.stderr.on("data", (data: string) => { if (!killed) stderr += data; });
          cmd.on("close", () => { resolve(stdout + (stderr ? "\n" + stderr : "")); });
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            if (!killed) {
              killed = true;
              child.kill().catch(() => { });
            }
            reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);
        }),
      ]);
      return truncateToolResult(output, "run_command");
    } finally {
      clearTimeout(timeoutId);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    }
  }

  if (name === "git_status") {
    const status = await dalamAPI.git.status(workspacePath);
    return JSON.stringify(status, null, 2);
  }

  if (name === "git_commit") {
    const result = await dalamAPI.git.commit(workspacePath, args.message);
    return `Committed successfully. SHA: ${result.sha}`;
  }

  if (name === "git_log") {
    const log = await dalamAPI.git.log(workspacePath, 10);
    return JSON.stringify(log, null, 2);
  }

  if (name === "git_branch") {
    const branches = await dalamAPI.git.branches(workspacePath);
    return branches.map((b) => `${b.current ? "* " : "  "}${b.name}`).join("\n");
  }

  if (name === "git_checkout") {
    const branch = args.branch;
    if (!branch) return "Error: git_checkout requires a 'branch' argument";
    await dalamAPI.git.checkout(workspacePath, branch);
    return `Checked out branch: ${branch}`;
  }

  if (name === "git_diff_file") {
    const filePath = args.path;
    if (!filePath) return "Error: git_diff_file requires a 'path' argument";
    const diff = await dalamAPI.git.diffFile(workspacePath, filePath);
    return diff || `No changes in ${filePath}`;
  }

  if (name === "clipboard_read") {
    return await dalamAPI.system.clipboardReadText();
  }

  if (name === "clipboard_write") {
    await dalamAPI.system.clipboardWriteText(args.text);
    return "Clipboard written successfully.";
  }

  if (name === "notify") {
    await dalamAPI.system.notify({ title: args.title, body: args.body });
    return `Notification sent: ${args.title}`;
  }

  if (name === "system_info") {
    const info = await dalamAPI.system.getSystemInfo();
    return JSON.stringify(info, null, 2);
  }

  if (name === "open_url") {
    await dalamAPI.system.openLink(args.url);
    return `Opened URL: ${args.url}`;
  }

  if (name === "launch_app") {
    // Shell-style argument splitting that respects quoted strings
    function splitArgs(str: string): string[] {
      const result: string[] = [];
      let current = '';
      let inSingle = false;
      let inDouble = false;
      let escape = false;
      for (const ch of str) {
        if (escape) { current += ch; escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (/\s/.test(ch) && !inSingle && !inDouble) {
          if (current) result.push(current);
          current = '';
          continue;
        }
        current += ch;
      }
      if (current) result.push(current);
      return result;
    }
    const appArgs = args.args ? splitArgs(args.args) : undefined;
    const result = await dalamAPI.system.launchApp(args.name, appArgs, args.cwd || workspacePath);
    return result || `Launched app: ${args.name}`;
  }

  if (name === "reveal_in_finder") {
    await dalamAPI.system.revealInFinder(args.path);
    return `Revealed in Finder: ${args.path}`;
  }

  if (name === "memory_save") {
    const { saveMemory } = await import("./memoryStore");
    const tags = args.tags ? args.tags.split(/,\s*/).map((t: string) => t.trim()).filter(Boolean) : [];
    const content = args.content ?? "";
    const result = await saveMemory(
      {
        category: (args.category as import("./memoryTypes").MemoryCategory) || "project",
        tier: (args.tier as import("./memoryTypes").MemoryTier) || "medium",
        summary: args.summary || content.slice(0, 150),
        content,
        tags,
      },
      workspacePath,
    );
    return `Memory ${result.action}: id=${result.id}`;
  }

  if (name === "memory_search") {
    const { searchMemories } = await import("./memoryStore");
    const limit = args.limit ? parseInt(args.limit, 10) : 10;
    const results = await searchMemories(args.query, {
      category: (args.category as import("./memoryTypes").MemoryCategory) || undefined,
      limit,
    });
    if (results.length === 0) return "No memories found matching the query.";
    return results.map((r) =>
      `[${r.tier}/${r.category}] ${r.summary} (id:${r.id}, tags: ${r.tags.join(", ")})\n${r.content}`
    ).join("\n---\n");
  }

  if (name === "memory_delete") {
    const { markStale } = await import("./memoryStore");
    await markStale(args.id);
    return `Memory ${args.id} marked stale (soft-deleted). It will be excluded from search and purged during maintenance.`;
  }

  if (name === "memory_stats") {
    const { getMemoryStats } = await import("./memoryStore");
    const stats = await getMemoryStats();
    const tierOrder = ["critical", "high", "medium", "low"];
    const lines = [
      `Total memories: ${stats.total}`,
      `Stale (pending purge): ${stats.staleCount}`,
      "",
      "By category:",
      ...Object.entries(stats.byCategory).map(([cat, count]) => `  ${cat}: ${count}`),
      "",
      "By tier:",
      ...Object.entries(stats.byTier).map(([tier, count]) => `  ${tier}: ${count}`),
      "",
      "Per-category tier breakdown:",
      ...Object.entries(stats.byCategoryTier).map(([cat, tiers]) => {
        const tierStr = tierOrder.map((t) => `${t}: ${tiers[t] ?? 0}`).join(", ");
        return `  ${cat} — ${tierStr}`;
      }),
    ];
    return lines.join("\n");
  }

  if (name === "memory_maintain") {
    const { runMaintenance } = await import("./memoryStore");
    const result = await runMaintenance();
    const lines = [
      "Memory maintenance complete:",
      `  Stale detected: ${result.staleDetected}`,
      `  Budget pruned: ${result.pruned}`,
      `  Purged (hard delete): ${result.purged}`,
      `  Total actions: ${result.staleDetected + result.pruned + result.purged}`,
    ];
    return lines.join("\n");
  }

  if (name === "memory_export") {
    const { exportMemories } = await import("./memoryStore");
    const count = await exportMemories(workspacePath);
    return `Exported ${count} memories to .dalam/memories/ as markdown files. Ready for git commit.`;
  }

  if (name === "memory_import") {
    const { importMemories } = await import("./memoryStore");
    const count = await importMemories(workspacePath);
    return `Imported ${count} memories from .dalam/memories/ markdown files into SQLite cache.`;
  }

  if (name === "memory_extract") {
    const { extractMemoriesWithLLM } = await import("./memoryStore");
    let settings: AppSettings;
    let config: { baseUrl: string; apiKey: string; apiFormat: string };
    try {
      ({ settings, config } = getActiveProvider());
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] ({ settings, config } = getActiveProvider());:", e);
      return "Error: No provider configured. Cannot run LLM extraction.";
    }

    // Build fetchLLM callback using the configured provider
    const fetchLLM = async (prompt: string): Promise<string> => {
      const isAnthropic = config.apiFormat === "anthropic";
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
      const resp = await fetchJsonWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, 2, 1000) as Record<string, unknown>;
      const r = resp as Record<string, unknown>;
      if (isAnthropic) {
        const content = (r.content as Array<{ text: string }>);
        return content?.[0]?.text || "";
      }
      const choices = (r.choices as Array<{ message: { content: string } }>);
      return choices?.[0]?.message?.content || "";
    };

    // Get last exchange from session messages
    const { useChat } = await import("../store/useAppStore");
    const activeSessionId = useChat.getState().session?.id ?? useChat.getState().chatSessions.at(-1)?.id;
    if (!activeSessionId) return "Error: No active session found.";
    const sessionMessages = useChat.getState().sessionMessages[activeSessionId];
    if (!sessionMessages || sessionMessages.length < 2) return "Error: No conversation history available for extraction.";

    let lastUserIdx = -1;
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return "Error: No user message found in conversation.";
    let assistantIdx = -1;
    for (let i = lastUserIdx + 1; i < sessionMessages.length; i++) {
      if (sessionMessages[i].role === "assistant") { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return "Error: No assistant response found after last user message.";

    const userInput = sessionMessages[lastUserIdx].content;
    const assistantResponse = sessionMessages[assistantIdx].content;

    const result = await extractMemoriesWithLLM(userInput, assistantResponse, fetchLLM, {
      sessionId: activeSessionId,
      workspacePath,
    });

    const lines = [
      `LLM memory extraction complete (${result.source} source):`,
      `  Entries found: ${result.entries.length}`,
      `  Saved: ${result.saved}`,
      "",
      "Extracted entries:",
      ...result.entries.map((e) => `  [${e.tier}/${e.category}] ${e.summary}`),
    ];
    return lines.join("\n");
  }

  if (name === "get_env") {
    const { invoke } = await import("@tauri-apps/api/core");
    const key = String(args.key ?? "");
    if (!key) return "Error: key is required";
    const value = await invoke<string>("get_env", { key });
    return value || "(empty)";
  }
  if (name === "get_screen_info") {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ width: number; height: number; scale_factor: number }>("get_screen_info");
    return JSON.stringify(info);
  }
  if (name === "list_processes") {
    const { invoke } = await import("@tauri-apps/api/core");
    const procs = await invoke<{ pid: number; name: string; cpu_usage: number; memory_kb: number }[]>("list_processes");
    if (!procs || procs.length === 0) return "(no processes found)";
    return procs.map((p) => `${p.pid}\t${p.name}\tCPU: ${p.cpu_usage.toFixed(1)}%\tMem: ${p.memory_kb}KB`).join("\n");
  }
  if (name === "kill_process") {
    const { invoke } = await import("@tauri-apps/api/core");
    const pid = Number(args.pid ?? 0);
    if (!pid) return "Error: pid is required";
    await invoke("kill_process", { pid });
    return `Process ${pid} killed`;
  }
  if (name === "get_disk_space") {
    const { invoke } = await import("@tauri-apps/api/core");
    const diskPath = String(args.path ?? "/");
    const info = await invoke<{ total_bytes: number; available_bytes: number; used_bytes: number }>("get_disk_space", { path: diskPath });
    const totalGB = (info.total_bytes / (1024 ** 3)).toFixed(2);
    const availGB = (info.available_bytes / (1024 ** 3)).toFixed(2);
    const usedGB = (info.used_bytes / (1024 ** 3)).toFixed(2);
    return `Total: ${totalGB}GB, Available: ${availGB}GB, Used: ${usedGB}GB`;
  }

  // ─── Agentic UI Control Tools ─────────────────────────────────

  if (name === "open_panel") {
    const panel = args.panel as string;
    if (panel === "terminal") {
      const { useUI } = await import("../store/useAppStore");
      const ui = useUI.getState();
      if (ui.viewMode !== "editor") ui.setViewMode("editor");
      ui.setBottomPanelTab("terminal");
      ui.setBottomPanelOpen(true);
      return "Opened terminal panel";
    }
    const validPanels = ["git", "diff", "review", "browser", "progress"];
    if (!validPanels.includes(panel)) {
      return `Error: Invalid panel "${panel}". Valid panels: ${validPanels.join(", ")}, terminal`;
    }
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().setRightPanelTab(panel as "git" | "diff" | "review" | "browser" | "progress");
    useUI.getState().setRightPanelOpen(true);
    return `Opened ${panel} panel`;
  }

  if (name === "screenshot") {
    // Capture the current browser state — returns page metadata for agent inspection
    const { useUI } = await import("../store/useAppStore");
    const ui = useUI.getState();
    if (ui.rightPanelTab !== "browser" || !ui.rightPanelOpen) {
      ui.setRightPanelTab("browser");
      ui.setRightPanelOpen(true);
    }
    const iframe = document.querySelector("iframe[title]") as HTMLIFrameElement | null;
    if (iframe) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          // Same-origin: extract rich page metadata
          const title = doc.title || "(no title)";
          const url = iframe.src || "(no URL)";
          const bodyText = doc.body?.innerText?.slice(0, 2000) || "";
          const links = Array.from(doc.querySelectorAll("a[href]")).slice(0, 20).map(a => ({
            text: a.textContent?.trim().slice(0, 50) || "",
            href: a.getAttribute("href") || "",
          }));
          const images = Array.from(doc.querySelectorAll("img")).slice(0, 10).map(img => ({
            src: img.src?.slice(0, 100) || "",
            alt: img.alt || "",
          }));
          const forms = Array.from(doc.querySelectorAll("form")).length;
          const inputs = Array.from(doc.querySelectorAll("input, textarea, select")).slice(0, 10).map(el => ({
            type: el.tagName.toLowerCase() === "input" ? (el as HTMLInputElement).type : el.tagName.toLowerCase(),
            name: el.getAttribute("name") || el.getAttribute("placeholder") || "",
            value: (el as HTMLInputElement).value?.slice(0, 50) || "",
          }));
          const headings = Array.from(doc.querySelectorAll("h1,h2,h3")).slice(0, 10).map(h => h.textContent?.trim().slice(0, 80) || "");
          return [
            `Page: ${title}`,
            `URL: ${url}`,
            `Headings: ${headings.length > 0 ? headings.join(" | ") : "(none)"}`,
            `Links: ${links.length} found${links.length > 0 ? " — " + links.slice(0, 5).map(l => `"${l.text}" → ${l.href}`).join(", ") : ""}`,
            `Images: ${images.length} found`,
            `Forms: ${forms}, Inputs: ${inputs.length}`,
            inputs.length > 0 ? `Input fields: ${inputs.map(i => `${i.type}("${i.name}")=${i.value}`).join(", ")}` : "",
            `Text preview: ${bodyText.slice(0, 500)}`,
          ].filter(Boolean).join("\n");
        }
        // Cross-origin fallback
        return `Browser URL: ${iframe.src || "(loading...)"}. Page is cross-origin — cannot read content. Use browser_navigate to a same-origin URL.`;
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] operation:", e);
        return `Browser URL: ${iframe.src || "(unknown)"}. Cannot read cross-origin content.`;
      }
    }
    return "No browser page open. Use browser_navigate to open a URL first.";
  }

  if (name === "browser_navigate") {
    const url = args.url as string;
    const { useUI } = await import("../store/useAppStore");
    const ui = useUI.getState();
    // Ensure browser panel is open
    if (ui.rightPanelTab !== "browser" || !ui.rightPanelOpen) {
      ui.setRightPanelTab("browser");
      ui.setRightPanelOpen(true);
    }
    // Create a browser tab if none exists, or navigate the active one
    const activeTabId = ui.activeBrowserTabId;
    if (!activeTabId || ui.browserTabs.length === 0) {
      ui.addBrowserTab({ url, title: url });
    } else {
      ui.navigateBrowser(activeTabId, url);
    }
    return `Navigated browser to: ${url}`;
  }

  if (name === "run_preview") {
    const command = args.command as string;
    const port = args.port as string | undefined;
    const previewPort = port || "5173";

    // Run the command in the terminal
    const { useTerminal } = await import("../store/useAppStore");
    const cwd = workspacePath || ".";
    const defaultShell = isWindows() ? "powershell" : "bash";
    useTerminal.getState().addTab(cwd, defaultShell, command);

    // Open browser panel to show the preview
    const { useUI } = await import("../store/useAppStore");
    const ui = useUI.getState();
    ui.setRightPanelTab("browser");
    ui.setRightPanelOpen(true);

    // Create a browser tab pointing to the dev server
    const previewUrl = `http://localhost:${previewPort}`;
    ui.addBrowserTab({ url: previewUrl, title: `Preview: ${command.slice(0, 30)}` });

    return `Started preview: running "${command}" and opening ${previewUrl} in the browser panel. The terminal will show the server output.`;
  }

  if (name === "browser_execute") {
    const script = args.script as string;
    // Execute JavaScript in the browser iframe context
    const iframe = document.querySelector("iframe[title]") as HTMLIFrameElement | null;
    if (!iframe) {
      return "Error: No browser iframe found. Use browser_navigate to open a page first.";
    }
    try {
      // For same-origin iframes, we can access contentDocument
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        // Execute script in iframe context
        const result = (iframe.contentWindow as Window & { eval?: (script: string) => unknown })?.eval?.(script);
        return result !== undefined ? String(result) : "Script executed (no return value)";
      }
      // Cross-origin: can't access iframe content directly
      return `Error: Cannot execute script in cross-origin iframe. The browser is showing: ${iframe.src || "(unknown URL)"}. Use browser_navigate to a same-origin URL, or use open_url to open in the system browser.`;
    } catch (err) {
      return `Error executing browser script: ${(err as Error)?.message ?? String(err)}`;
    }
  }

  if (name === "create_task_plan") {
    const tasksText = args.tasks as string;
    const lines = tasksText.split("\n").filter((l: string) => l.trim());
    const { useChat } = await import("../store/useAppStore");
    const tasks = lines.map((line: string, i: number) => ({
      id: `task-${i + 1}`,
      title: line.replace(/^[-*]\s*/, "").trim(),
      status: "pending" as const,
    }));
    if (tasks.length > 0) {
      useChat.setState({ taskPlan: tasks, taskPlanSummary: null });
      // Also open the progress panel so the user can see the tasks
      const { useUI } = await import("../store/useAppStore");
      useUI.getState().setRightPanelTab("progress");
      useUI.getState().setRightPanelOpen(true);
      return `Created task plan with ${tasks.length} tasks. Progress panel opened.`;
    }
    return "Error: No valid tasks provided. Provide newline-separated task titles.";
  }

  if (name === "question") {
    const questionText = args.question as string;
    const optionsStr = args.options as string | undefined;
    const options = optionsStr
      ? optionsStr.split(/[,;\n]/).filter((o: string) => o.trim()).map((o: string) => o.trim())
      : [];
    const questionType = (args.type as string) || "text";
    const allowFreeText = args.allowFreeText !== "false";
    const placeholder = (args.placeholder as string) || (questionType === "number" ? "Enter a number..." : "Type your answer...");
    const defaultValue = args.defaultValue as string | undefined;
    const required = args.required !== "false";

    try {
      const { extendSafetyTimerForApproval } = await import("./safetyTimer");
      const { useChat } = await import("../store/useAppStore");
      extendSafetyTimerForApproval(
        () => useChat.getState(),
        (update: Record<string, unknown>) => useChat.setState(update as Partial<typeof useChat.getState>),
      );
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[DALAM] import(\"./safetyTimer\");:", e);
    }

    const { useQuestion } = await import("../store/useAppStore");
    const answer = await useQuestion.getState().ask({
      header: "Question",
      question: questionText,
      options: options.map((o: string) => ({ label: o, description: "" })),
      type: questionType as "text" | "number" | "confirm" | undefined,
      allowFreeText: allowFreeText && options.length > 0 ? true : options.length === 0 ? true : allowFreeText,
      placeholder,
      defaultValue,
      required,
    });

    const answerText = answer === null ? "Dismissed" : (answer.customText || answer.selectedLabel);

    const { useChat } = await import("../store/useAppStore");
    const chatState = useChat.getState();
    const currentMessages = chatState.messages;
    let lastAssistantIdx = -1;
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      if (currentMessages[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx >= 0) {
      const msg = currentMessages[lastAssistantIdx];
      const existingQuestions = msg.questions ?? [];
      const newQuestion = {
        id: "q-" + crypto.randomUUID(),
        question: questionText,
        options,
        answer: answerText,
        timestamp: Date.now(),
      };
      const updatedMessages = [...currentMessages];
      updatedMessages[lastAssistantIdx] = { ...msg, questions: [...existingQuestions, newQuestion] };
      useChat.setState({ messages: updatedMessages });
    }

    return `User answered: ${answerText}`;
  }

  if (name.startsWith("mcp_")) {
    // Coerce string args to proper types for MCP servers
    function coerceMcpArgs(raw: Record<string, string>): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v === "true") out[k] = true;
        else if (v === "false") out[k] = false;
        else if (v === "null") out[k] = null;
        else if (v !== "" && !isNaN(Number(v))) out[k] = Number(v);
        else if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
          try {
            out[k] = JSON.parse(v);
          } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] out[k] = JSON.parse(v);", e);
            out[k] = v;
          }
        }
        else out[k] = v;
      }
      return out;
    }
    const mcpArgs = coerceMcpArgs(args);

    // Parse "mcp_{serverName}_{toolName}" — server name may contain underscores
    const afterPrefix = name.slice(4); // remove "mcp_"
    const { useSkillsMcp } = await import("../store/useAppStore");
    const mcpServers = useSkillsMcp.getState().mcpServers;
    let serverName = "";
    let toolName = "";
    let foundServer = false;
    for (const srv of mcpServers) {
      const prefix = srv.name + "_";
      if (afterPrefix.startsWith(prefix)) {
        serverName = srv.name;
        toolName = afterPrefix.slice(prefix.length);
        foundServer = true;
        break;
      }
    }
    if (!foundServer) {
      // Fallback: use first underscore split
      const firstUnderscore = afterPrefix.indexOf("_");
      if (firstUnderscore === -1) throw new Error(`Invalid MCP tool name format: ${name}`);
      serverName = afterPrefix.slice(0, firstUnderscore);
      toolName = afterPrefix.slice(firstUnderscore + 1);
    }

    const server = mcpServers.find((m) => m.name === serverName);
    if (!server) {
      throw new Error(`MCP Server "${serverName}" not found or configured.`);
    }
    if (!server.enabled) {
      throw new Error(`MCP Server "${serverName}" is disabled.`);
    }

    if (server.transport === "http") {
      const url = server.url;
      if (!url) throw new Error("HTTP Endpoint URL is required");
      // SSRF protection: validate URL before execution
      const { validateMcpUrl } = await import("./security");
      validateMcpUrl(url);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const mcpFetch = (body: string, signal?: AbortSignal) =>
        corsFetch(url, { method: "POST", headers, body, signal });
      const MCP_FETCH_TIMEOUT = 15_000;
      const mcpFetchWithTimeout = async (body: string): Promise<Response> => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), MCP_FETCH_TIMEOUT);
        try {
          return await mcpFetch(body, ac.signal);
        } finally {
          clearTimeout(timer);
        }
      };
      let existingSessionId = mcpHttpSessions.get(serverName);
      if (!existingSessionId) {
        // Mutex: if another call is already initializing, wait for it
        const existingMutex = _mcpSessionMutexes.get(serverName);
        if (existingMutex) {
          existingSessionId = (await existingMutex) ?? undefined;
        } else {
          const initPromise = (async (): Promise<string | null> => {
            try {
              const initResp = await mcpFetchWithTimeout(
                JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Dalam", version: "1.0.0" } }, id: 1 })
              );
              if (!initResp.ok) throw new Error(`HTTP ${initResp.status} during MCP initialize`);
              const initJson = await initResp.json();
              if (initJson.error) throw new Error(initJson.error.message || JSON.stringify(initJson.error));
              const sid = initResp.headers.get("mcp-session-id");
              if (sid) mcpHttpSessions.set(serverName, sid);
              const notifHeaders: Record<string, string> = { "Content-Type": "application/json" };
              if (sid) notifHeaders["Mcp-Session-Id"] = sid;
              await corsFetch(url, {
                method: "POST",
                headers: notifHeaders,
                body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
              });
              return sid;
            } finally {
              _mcpSessionMutexes.delete(serverName);
            }
          })();
          _mcpSessionMutexes.set(serverName, initPromise);
          existingSessionId = (await initPromise) ?? undefined;
        }
      }
      if (existingSessionId) {
        headers["Mcp-Session-Id"] = existingSessionId;
      }
      // tools/call
      const resp = await corsFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: toolName,
            arguments: mcpArgs,
          },
          id: 2,
        }),
      });
      if (!resp.ok) {
        // Invalidate stale session on client/server errors and retry with fresh init
        if (resp.status >= 400 && resp.status < 500) {
          mcpHttpSessions.delete(serverName);
          // Re-initialize session
          const freshHeaders: Record<string, string> = { "Content-Type": "application/json" };
          try {
            const initResp2 = await mcpFetchWithTimeout(
              JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Dalam", version: "1.0.0" } }, id: Date.now() })
            );
            if (initResp2.ok) {
              const initJson2 = await initResp2.json();
              const newSessionId = initResp2.headers.get("mcp-session-id");
              if (newSessionId) {
                freshHeaders["Mcp-Session-Id"] = newSessionId;
                mcpHttpSessions.set(serverName, newSessionId);
              }
              if (!initJson2.error) {
                await corsFetch(url, { method: "POST", headers: freshHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });
              }
            }
          } catch (e) {
            if (import.meta.env.DEV) console.warn("[DALAM] corsFetch(url, {:", e);
          }
          // Retry tool call with fresh session
          const retryAc = new AbortController();
          const retryTimer = setTimeout(() => retryAc.abort(), 15_000);
          let retryResp: Response;
          try {
          retryResp = await corsFetch(url, {
            method: "POST",
            headers: freshHeaders,
            body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: toolName, arguments: mcpArgs }, id: Date.now() }),
            signal: retryAc.signal,
          });
          } finally { clearTimeout(retryTimer); }
          if (!retryResp.ok) throw new Error(`HTTP ${retryResp.status} calling MCP tool (after session reset)`);
          const retryJson = await retryResp.json();
          if (retryJson.error) throw new Error(retryJson.error.message || JSON.stringify(retryJson.error));
          const retryContent = retryJson.result?.content || [];
          return retryContent.map((c: AnthropicContentBlock) => c.text || JSON.stringify(c)).join("\n");
        }
        throw new Error(`HTTP ${resp.status} calling MCP tool`);
      }
      const json = await resp.json();
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      if (!json || typeof json !== "object" || !("result" in json)) {
        return `[MCP Error: Invalid response format from server "${serverName}"]`;
      }
      const content = json.result?.content || [];
      return content.map((c: AnthropicContentBlock) => c.text || JSON.stringify(c)).join("\n");
    } else {
      const command = server.command;
      if (!command) throw new Error("Stdio command is required");

      // ── Connection Pool: reuse existing stdio connection if available ──
      const existing = _mcpStdioConnections.get(serverName);
      if (existing && existing.initialized) {
        // Reuse existing connection
        const conn = existing;
        conn.lastUsed = Date.now();
        const reqId = ++conn.requestIdCounter;
        const reqIdStr = String(reqId);
        const resultPromise = new Promise<string>((resolve, reject) => {
          conn.pendingRequests.set(reqIdStr, { resolve: resolve as (value: unknown) => void, reject });
          const req = JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: toolName, arguments: mcpArgs },
            id: reqId,
          }) + "\n";
          conn.child.write(req).catch((err) => {
            _mcpStdioConnections.delete(serverName);
            conn.pendingRequests.delete(reqIdStr);
            reject(err);
          });
          // Timeout after 30s — clear on resolution to prevent stale timer
          const timeoutId = setTimeout(() => {
            if (conn.pendingRequests.has(reqIdStr)) {
              conn.pendingRequests.delete(reqIdStr);
              reject(new Error("Timeout waiting for tools/call response (30s)"));
            }
          }, 30000);
          // Wrap resolve/reject to clear timeout on settlement
          const originalPending = conn.pendingRequests.get(reqIdStr);
          if (originalPending) {
            conn.pendingRequests.set(reqIdStr, {
              resolve: (v) => { clearTimeout(timeoutId); originalPending.resolve(v); },
              reject: (e) => { clearTimeout(timeoutId); originalPending.reject(e); },
            });
          }
        });
        return await resultPromise;
      }

      // ── No existing connection — create a new one (with mutex) ──
      // Check if another call is already creating a connection for this server
      const existingMutex = _mcpStdioMutexes.get(serverName);
      if (existingMutex) {
        const conn = await existingMutex;
        if (conn) {
          // Another call created the connection — use it
          conn.lastUsed = Date.now();
          const reqId = ++conn.requestIdCounter;
          const reqIdStr = String(reqId);
          const resultPromise = new Promise<string>((resolve, reject) => {
            conn.pendingRequests.set(reqIdStr, { resolve: resolve as (value: unknown) => void, reject });
            const req = JSON.stringify({
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: toolName, arguments: mcpArgs },
              id: reqId,
            }) + "\n";
            conn.child.write(req).catch((err) => {
              conn.pendingRequests.delete(reqIdStr);
              reject(err);
            });
            const timeoutId = setTimeout(() => {
              if (conn.pendingRequests.has(reqIdStr)) {
                conn.pendingRequests.delete(reqIdStr);
                reject(new Error("Timeout waiting for tools/call response (30s)"));
              }
            }, 30000);
            // Clear timeout on resolution to prevent timer leak
            const origResolve = conn.pendingRequests.get(reqIdStr)?.resolve;
            const origReject = conn.pendingRequests.get(reqIdStr)?.reject;
            if (origResolve) {
              conn.pendingRequests.set(reqIdStr, {
                resolve: (v) => { clearTimeout(timeoutId); origResolve(v); },
                reject: (e) => { clearTimeout(timeoutId); if (origReject) origReject(e); else reject(e); },
              });
            }
          });
          return await resultPromise;
        }
      }

      // No mutex — we are the creator
      const connectionPromise = (async (): Promise<McpStdioConnection | null> => {
        try {
        const { Command } = await import("@tauri-apps/plugin-shell");
        const cmd = Command.create(command, server.args ?? [], { env: server.env });

        const connRecord = await new Promise<McpStdioConnection>((resolve, reject) => {
          let outputBuffer = "";
          let resolved = false;
          let childProc: Awaited<ReturnType<typeof cmd.spawn>> | null = null;
          let jsonBuffer = "";
          let bracesDepth = 0;
          const connRecord: McpStdioConnection = {
            cmd,
            child: null as unknown as McpStdioConnection["child"],
            stdoutBuffer: "",
            initialized: false,
            lastUsed: Date.now(),
            pendingRequests: new Map(),
            requestIdCounter: 2,
          };

          cmd.stdout.on("data", (data: string) => {
            outputBuffer += data;
            connRecord.stdoutBuffer += data;
            const lines = outputBuffer.split("\n");
            outputBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              jsonBuffer += (jsonBuffer ? "\n" : "") + trimmed;
              if (jsonBuffer.startsWith("{")) {
                for (const ch of trimmed) {
                  if (ch === "{") bracesDepth++;
                  else if (ch === "}") bracesDepth--;
                }
                if (bracesDepth > 0) continue;

                try {
                  const parsed = JSON.parse(jsonBuffer);
                  jsonBuffer = "";
                  bracesDepth = 0;

                  if (parsed.id !== undefined && connRecord.pendingRequests.size > 0) {
                    const pendingId = String(parsed.id);
                    const pending = connRecord.pendingRequests.get(pendingId);
                    if (pending) {
                      connRecord.pendingRequests.delete(pendingId);
                      if (parsed.error) {
                        pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                      } else {
                        const content = parsed.result?.content || parsed.content || [];
                        const text = content.map((c: AnthropicContentBlock) => c.text || JSON.stringify(c)).join("\n");
                        pending.resolve(text);
                      }
                    }
                    continue;
                  }

                  if (parsed.result?.content || parsed.content || parsed.error) {
                    resolved = true;
                    if (parsed.error) {
                      reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                    } else if (!parsed || typeof parsed !== "object" || (!("result" in parsed) && !("content" in parsed))) {
                      resolve(connRecord); // Still resolve so cleanup happens
                    } else {
                      resolve(connRecord);
                    }
                    return;
                  }
                } catch (e) {
                  if (import.meta.env.DEV) console.warn("[DALAM] operation:", e);
                  // Incomplete or malformed — keep buffering
                }
              } else {
                jsonBuffer = "";
                bracesDepth = 0;
              }
            }
          });

          cmd.stderr.on("data", (data: string) => {
            console.warn("MCP Stderr:", data);
          });

          const doSpawn = async () => {
            try {
              childProc = await cmd.spawn();
              connRecord.child = {
                write: (input: string) => childProc!.write(input),
                kill: () => childProc!.kill(),
              };
              _mcpStdioConnections.set(serverName, connRecord);

              const initReq = JSON.stringify({
                jsonrpc: "2.0",
                method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Dalam", version: "1.0.0" } },
                id: 1,
              }) + "\n";
              await childProc.write(initReq);
              const initNotif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n";
              await childProc.write(initNotif);
              connRecord.initialized = true;
              resolve(connRecord);
            } catch (spawnErr) {
              _mcpStdioConnections.delete(serverName);
              if (!resolved) {
                resolved = true;
                reject(spawnErr instanceof Error ? spawnErr : new Error(String(spawnErr)));
              }
            }
          };

          void doSpawn();

          let connTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const origResolve = resolve;
          const origReject = reject;
          resolve = ((value: McpStdioConnection | PromiseLike<McpStdioConnection>) => {
            clearTimeout(connTimeoutId);
            resolved = true;
            origResolve(value);
          }) as typeof resolve;
          reject = ((reason: unknown) => {
            clearTimeout(connTimeoutId);
            resolved = true;
            origReject(reason);
          }) as typeof reject;

          connTimeoutId = setTimeout(() => {
            if (!resolved) {
              childProc?.kill().catch(() => {});
              _mcpStdioConnections.delete(serverName);
              origReject(new Error("Timeout waiting for tools/call response (30s)"));
            }
          }, 30000);
        });

        return connRecord;
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DALAM] operation:", e);
        _mcpStdioConnections.delete(serverName);
        return null;
      } finally {
        _mcpStdioMutexes.delete(serverName);
      }
      })(); // end connectionPromise
      _mcpStdioMutexes.set(serverName, connectionPromise);
      const conn = await connectionPromise;
      if (!conn) throw new Error(`Failed to connect to MCP server "${serverName}"`);
      // Send tool call on the newly created connection
      conn.lastUsed = Date.now();
      const reqId = ++conn.requestIdCounter;
      const reqIdStr = String(reqId);
      const resultPromise = new Promise<string>((resolve, reject) => {
        conn.pendingRequests.set(reqIdStr, { resolve: resolve as (value: unknown) => void, reject });
        const req = JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: toolName, arguments: mcpArgs },
          id: reqId,
        }) + "\n";
        conn.child.write(req).catch((err) => {
          conn.pendingRequests.delete(reqIdStr);
          reject(err);
        });
        let reqTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const origPending = conn.pendingRequests.get(reqIdStr);
        if (origPending) {
          conn.pendingRequests.set(reqIdStr, {
            resolve: (v) => { clearTimeout(reqTimeoutId); origPending.resolve(v); },
            reject: (e) => { clearTimeout(reqTimeoutId); origPending.reject(e); },
          });
        }
        reqTimeoutId = setTimeout(() => {
          if (conn.pendingRequests.has(reqIdStr)) {
            conn.pendingRequests.delete(reqIdStr);
            reject(new Error("Timeout waiting for tools/call response (30s)"));
          }
        }, 30000);
      });
      return await resultPromise;
    }
  }

  // ─── Agentic UI Control Tools ─────────────────────────────────

  if (name === "set_theme") {
    const theme = args.theme as string;
    if (!["light", "dark", "system"].includes(theme)) {
      return `Error: Invalid theme "${theme}". Must be "light", "dark", or "system".`;
    }
    const { useSettings } = await import("../store/useAppStore");
    void useSettings.getState().update("theme", theme as "light" | "dark" | "system");
    return `Theme changed to "${theme}".`;
  }

  if (name === "toggle_theme") {
    const { useSettings } = await import("../store/useAppStore");
    const current = useSettings.getState().settings.theme;
    const next = current === "dark" ? "light" : current === "light" ? "system" : "dark";
    void useSettings.getState().update("theme", next);
    return `Theme toggled to "${next}" (was "${current}").`;
  }

  if (name === "set_view_mode") {
    const mode = args.mode as string;
    if (!["editor", "chat"].includes(mode)) {
      return `Error: Invalid view mode "${mode}". Must be "editor" or "chat".`;
    }
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().setViewMode(mode as "editor" | "chat");
    return `View mode changed to "${mode}".`;
  }

  if (name === "toggle_view_mode") {
    const { useUI } = await import("../store/useAppStore");
    const current = useUI.getState().viewMode;
    const next = current === "editor" ? "chat" : "editor";
    useUI.getState().setViewMode(next);
    return `View mode toggled to "${next}" (was "${current}").`;
  }

  if (name === "toggle_right_panel") {
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().toggleRightPanel();
    const isOpen = useUI.getState().rightPanelOpen;
    return `Right panel ${isOpen ? "opened" : "closed"}.`;
  }

  if (name === "toggle_bottom_panel") {
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().toggleBottomPanel();
    const isOpen = useUI.getState().bottomPanelOpen;
    return `Bottom panel ${isOpen ? "opened" : "closed"}.`;
  }

  if (name === "set_right_panel_tab") {
    const tab = args.tab as string;
    const validTabs = ["git", "diff", "review", "browser", "progress"] as const;
    if (!validTabs.includes(tab as typeof validTabs[number])) {
      return `Error: Invalid panel tab "${tab}". Valid tabs: ${validTabs.join(", ")}.`;
    }
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().setRightPanelTab(tab as typeof validTabs[number]);
    useUI.getState().setRightPanelOpen(true);
    return `Right panel switched to "${tab}" tab.`;
  }

  if (name === "set_bottom_panel_tab") {
    const tab = args.tab as string;
    const validTabs = ["terminal", "output", "problems"] as const;
    if (!validTabs.includes(tab as typeof validTabs[number])) {
      return `Error: Invalid bottom panel tab "${tab}". Valid tabs: ${validTabs.join(", ")}.`;
    }
    const { useUI } = await import("../store/useAppStore");
    useUI.getState().setBottomPanelTab(tab as typeof validTabs[number]);
    useUI.getState().setBottomPanelOpen(true);
    return `Bottom panel switched to "${tab}" tab.`;
  }

  if (name === "new_terminal") {
    const { useTerminal, useChat, useWorkspace } = await import("../store/useAppStore");
    const cwd = args.cwd || useChat.getState().session?.workspacePath || useWorkspace.getState().workspaces.find(w => w.id === useWorkspace.getState().activeWorkspaceId)?.path || ".";
    const validShells = ["bash", "zsh", "fish", "powershell", "cmd"] as const;
    const rawShell = (args.shell as string) || "bash";
    const shell = validShells.includes(rawShell as typeof validShells[number]) ? rawShell as typeof validShells[number] : "bash";
    useTerminal.getState().addTab(cwd, shell);
    return `Opened new ${shell} terminal in ${cwd}.`;
  }

  if (name === "terminal_write") {
    const { useTerminal } = await import("../store/useAppStore");
    const terminalId = args.terminal_id || useTerminal.getState().activeTabId;
    if (!terminalId) return "Error: No active terminal. Use new_terminal first.";
    const command = args.command as string;
    if (!command) return "Error: 'command' argument is required.";
    useTerminal.getState().writeToTerminal(terminalId, command);
    return `Command sent to terminal: ${command}`;
  }

  if (name === "webfetch") {
    const url = args.url as string;
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const response = await tauriFetch(url);
      const text = await response.text();
      return text.slice(0, 100000);
    } catch (err) {
      return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}. The URL may require authentication or the HTTP plugin may not be available.`;
    }
  }

  if (name === "websearch") {
    return `[websearch] Web search is not directly available. Use webfetch with a search engine URL like "https://www.google.com/search?q=QUERY".`;
  }

  if (name === "create_file") {
    return executeToolInner("write_file", args, workspacePath, emit, autoApprove);
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Execute a sub-agent task (OpenCode pattern).
 * Spawns a child conversation loop with a derived system prompt and returns the result.
 * The sub-agent runs with its own iteration budget and shares the same workspace.
 */
async function executeSubAgentTask(
  args: Record<string, unknown>,
  parentSessionId: string,
  workspacePath: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<string> {
  const prompt = String(args.prompt ?? "");
  const subagentType = String(args.subagent_type ?? "general");
  const description = String(args.description ?? "Sub-agent task");

  if (!prompt) return "[Error: task prompt is required]";

  const subAgentId = "sub-" + crypto.randomUUID();

  // Emit sub-agent lifecycle events for UI visibility (accordion tracking)
  emit({ type: "sub-agent-start", subAgentId, prompt, description, subagentType });

  // Build sub-agent system prompt based on type
  const subToolsDoc = `
TOOLS: Use XML tags to invoke tools. Output the tag directly in your response.
<read_file path="absolute_path"/>
<write_file path="absolute_path">content</write_file>
<edit_file path="absolute_path"><search>text</search><replace>new text</replace></edit_file>
<list_dir path="absolute_path"/>
<grep_file path="absolute_path" pattern="text"/>
<search_files path="workspace_path" pattern="text" glob="*.ts"/>
<run_command command="shell command"/>
Workspace: ${workspacePath || "."}`;

  let subSystemPrompt: string;
  switch (subagentType) {
    case "explore":
      subSystemPrompt = `You are a Dalam explore sub-agent. Search and analyze the codebase to answer questions. Be concise. Output XML tool tags directly.
<read_file path="absolute_path"/>
<list_dir path="absolute_path"/>
<grep_file path="absolute_path" pattern="text"/>
<search_files path="workspace_path" pattern="text" glob="*.ts"/>
Do NOT edit files. Workspace: ${workspacePath || "."}`;
      break;
    case "general":
    default:
      subSystemPrompt = `You are a Dalam general sub-agent. Complete the assigned task autonomously using tools. Output XML tags directly — NEVER output tool names in backticks.${subToolsDoc}`;
      break;
  }

  // Run a mini conversation loop for the sub-agent (max 10 iterations, 2 min timeout)
  const subHistory: Array<{ role: string; content: string }> = [
    { role: "system", content: subSystemPrompt },
    { role: "user", content: prompt },
  ];
  const MAX_SUB_ITERATIONS = 10;
  const SUB_TIMEOUT_MS = 2 * 60 * 1000;
  const SUB_ITERATION_TIMEOUT_MS = 30_000;
  const subStartTime = Date.now();
  let subResult = "";
  let subFailed = false;
  let consecutiveErrors = 0;
  let subError: string | undefined;
  const subToolCalls: ToolCall[] = [];

  let providerConfig: { settings: AppSettings; modelId: string; config: { baseUrl: string; apiKey: string; apiFormat: string } };
  try {
    providerConfig = getActiveProvider();
  } catch (err) {
    const errMsg = `Provider not configured: ${(err as Error)?.message ?? String(err)}`;
    emit({ type: "sub-agent-end", subAgentId, status: "failed", error: errMsg });
    return `[Error: ${errMsg}]`;
  }
  const { modelId, config } = providerConfig;

  for (let subLoop = 0; subLoop < MAX_SUB_ITERATIONS; subLoop++) {
    // Check abort AFTER listener is registered to avoid race (listener is set up below)
    if (signal.aborted) break;
    if (Date.now() - subStartTime > SUB_TIMEOUT_MS) break;

    const apiMessages: ApiMessage[] = subHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // Per-iteration timeout: race the stream against a timer to detect hung API calls
      const iterController = new AbortController();
      const iterTimer = setTimeout(() => iterController.abort(), SUB_ITERATION_TIMEOUT_MS);
      // Manual signal composition for broader browser compat (AbortSignal.any needs Chrome 120+)
      const onParentAbort = () => iterController.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });

      let stream: AsyncIterable<StreamEvent>;
      try {
        stream = streamChat(config.baseUrl, config.apiKey, config.apiFormat || "openai", modelId, apiMessages, iterController.signal, 4096);
      } catch (streamErr) {
        clearTimeout(iterTimer);
        signal.removeEventListener("abort", onParentAbort);
        if ((streamErr as Error)?.name === "AbortError") break;
        throw streamErr;
      }

      let fullContent = "";
      let iterTimedOut = false;
      try {
        for await (const event of stream) {
          if (signal.aborted) break;
          if (iterController.signal.aborted) { iterTimedOut = true; break; }
          if (event.type === "message-delta") fullContent += event.content;
        }
      } finally {
        clearTimeout(iterTimer);
        signal.removeEventListener("abort", onParentAbort);
      }
      if (iterTimedOut && !fullContent) break; // Clean exit, don't add timeout to sub-history

      subResult += fullContent;
      consecutiveErrors = 0; // Reset on successful stream

      // Check if sub-agent is calling tools — merge inline and code-block sources
      const subToolsInline = await parseToolCalls(fullContent);
      const subToolsCodeBlock = extractToolCallsFromCodeBlocks(fullContent);
      // Merge: code block tools take priority, then inline-parsed ones (deduplicated)
      const sortedStringify = (obj: Record<string, unknown>) => JSON.stringify(obj, Object.keys(obj).sort());
      const subTools = [...subToolsCodeBlock];
      const codeBlockKeys = new Set(subToolsCodeBlock.map((t) => `${t.name}:${sortedStringify(t.args)}`));
      for (const tc of subToolsInline) {
        const key = `${tc.name}:${sortedStringify(tc.args)}`;
        if (!codeBlockKeys.has(key)) {
          subTools.push(tc);
          codeBlockKeys.add(key);
        }
      }
      if (subTools.length === 0) {
        // No tools — sub-agent is done
        break;
      }

      // Execute sub-agent tools — emit sub-agent-update events for UI visibility
      // (NOT raw tool-call events, which would leak into parent's pendingToolCalls)
      subHistory.push({ role: "assistant", content: fullContent });
      // Enforce tool restrictions based on sub-agent type
      const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "grep_file", "search_files", "git_status", "git_log"]);
      for (const st of subTools) {
        if (signal.aborted) break;
        // Explore sub-agents are read-only — reject write tools
        if (subagentType === "explore" && !READ_ONLY_TOOLS.has(st.name)) {
          const rejectResult = `Error: Explore sub-agents cannot use ${st.name}. Read-only tools only.`;
          subHistory.push({ role: "user", content: `[Tool error for ${st.name}]\n${rejectResult}` });
          continue;
        }
        const subToolId = "stc-" + crypto.randomUUID();
        const tc: ToolCall = { id: subToolId, name: st.name, args: st.args, status: "running" };
        subToolCalls.push(tc);
        emit({ type: "sub-agent-update", subAgentId, toolCalls: [...subToolCalls] });
        try {
          // Execute silently — sub-agents don't need parent permission dialogs
          // Filter emit: suppress parent-facing events from sub-agent tool execution
          // Sub-agent tool execution is self-contained - suppress ALL events.
          // Only sub-agent-update events (emitted explicitly above) reach the parent.
          const subAgentEmit = (_event: StreamEvent) => { return; };
          const toolResult = await executeTool(st.name, st.args as Record<string, string>, workspacePath, subAgentEmit, true);
          // Update the tool call status
          const idx = subToolCalls.findIndex((t) => t.id === subToolId);
          if (idx !== -1) subToolCalls[idx] = { ...subToolCalls[idx], status: "completed", result: toolResult };
          emit({ type: "sub-agent-update", subAgentId, toolCalls: [...subToolCalls] });
          // Truncate large sub-agent tool results to prevent context overflow
          const truncatedResult = truncateToolResult(toolResult, "sub_agent");
          subHistory.push({ role: "user", content: `[Tool result for ${st.name}]\n${truncatedResult || "(no output)"}` });
        } catch (err) {
          const errMsg = (err as Error)?.message ?? String(err);
          const idx = subToolCalls.findIndex((t) => t.id === subToolId);
          if (idx !== -1) subToolCalls[idx] = { ...subToolCalls[idx], status: "failed", result: `Error: ${errMsg}` };
          emit({ type: "sub-agent-update", subAgentId, toolCalls: [...subToolCalls] });
          subHistory.push({ role: "user", content: `[Tool error for ${st.name}]\n${errMsg}` });
        }
      }
      // Emit content update after each iteration
      emit({ type: "sub-agent-update", subAgentId, content: subResult });
    } catch (err) {
      const errMsg = (err as Error)?.message ?? String(err);
      const isAbort = (err as Error)?.name === "AbortError";
      const isIterAbort = isAbort && !signal.aborted;
      if (isAbort && !isIterAbort) {
        subFailed = true;
        subError = "Sub-agent aborted by user";
        break;
      }
      if (isIterAbort) {
        subHistory.push({ role: "user", content: `[System: Sub-agent iteration timed out — continuing with partial output]` });
        continue;
      }
      // Transient errors: add to history and let LLM retry
      subHistory.push({ role: "user", content: `[System error on iteration ${subLoop + 1}: ${errMsg}]
Please try a different approach or summarize your progress so far.` });
      // Fail if no output after 3 errors, or if the same error repeats 3 times
      consecutiveErrors++;
      if ((!subResult && consecutiveErrors >= 3) || consecutiveErrors >= MAX_SUB_ITERATIONS) {
        subFailed = true;
        subError = `Sub-agent failed after ${subLoop + 1} attempts (${consecutiveErrors} consecutive errors): ${errMsg}`;
        break;
      }
      continue;
    }
  }

  // Check for abort or timeout (not mutually exclusive — abort takes precedence)
  if (!subFailed && signal.aborted) {
    subFailed = true;
    subError = "Sub-agent aborted by user";
  }
  if (!subFailed && Date.now() - subStartTime > SUB_TIMEOUT_MS) {
    subFailed = true;
    subError = "Sub-agent timed out after 2 minutes";
  }

  // Emit sub-agent completion
  const finalStatus: "completed" | "failed" = subFailed || (signal.aborted && !subResult) ? "failed" : "completed";
  emit({
    type: "sub-agent-end",
    subAgentId,
    status: finalStatus,
    ...(subError ? { error: subError } : {}),
  });

  return subResult || "(Sub-agent completed with no output)";
}