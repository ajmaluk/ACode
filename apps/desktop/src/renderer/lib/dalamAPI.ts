import type { DalamAPI, AgentSessionMode, AppSettings, ChatMessage, DiffProposal, FileNode, StreamEvent } from "@dalam/shared-types";
import { DEFAULT_SETTINGS } from "@dalam/shared-types";
import { matchSkillInvocation, renderSkillForPrompt, loadSkillContent } from "./skills";
import { loadInstructions, formatInstructionsForPrompt } from "./instructions";
import { hookBus } from "./hookBus";

// ---------------------------------------------------------------------------
// Debug logging — set window.__DALAM_DEBUG = true in console to enable
// ---------------------------------------------------------------------------
const _debugLog = (...args: unknown[]) => {
  try {
    if (typeof window !== "undefined" && (window as any).__DALAM_DEBUG) {
      console.log("[DALAM]", ...args);
    }
  } catch { /* ignore */ }
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
const emittedSessionEnds = new Set<string>();

const SETTINGS_CACHE = new Map<string, string>();

// ─── Internal Types ─────────────────────────────────────────
/** Shape of a provider entry from localStorage */
interface StoredProvider {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: string;
}

/** API message format for LLM providers (content can be string or multimodal parts) */
interface ApiMessage {
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

/** Minimal Zustand store ref for waitForToolApproval */
interface ChatStoreRef {
  getState(): {
    pendingToolCalls: import("@dalam/shared-types").ToolCall[];
    resolveToolApproval: (id: string, decision: "approved" | "denied") => void;
  };
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
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
    return raw ? JSON.parse(raw) : [];
  } catch (_e) { return []; }
}

function addRecentFile(path: string) {
  const recent = getRecentFiles().filter((f) => f !== path);
  recent.unshift(path);
  localStorage.setItem("dalam.recentFiles.v1", JSON.stringify(recent.slice(0, 20)));
}

function getStoredSettings(): AppSettings {
  if (SETTINGS_CACHE.has("all")) return { ...DEFAULT_SETTINGS, ...JSON.parse(SETTINGS_CACHE.get("all")!) };
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) { SETTINGS_CACHE.set("all", raw); return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; }
  } catch (_e) { /* settings load failed, use defaults */ }
  const defaults = { ...DEFAULT_SETTINGS };
  SETTINGS_CACHE.set("all", JSON.stringify(defaults));
  return defaults;
}

function storeSettings(s: AppSettings) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(s));
  SETTINGS_CACHE.set("all", JSON.stringify(s));
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
  } catch (_e) { /* provider config parse failed */ }
  return null;
}

export class ProviderError extends Error {
  constructor(message: string, public code: "auth" | "credit" | "network" | "provider" | "timeout") {
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

function parseSSEEvents(buffer: string): { parsed: { data: string }[]; remaining: string } {
  // Normalize CRLF to LF (some proxies/CDNs send CRLF)
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const parsed: { data: string }[] = [];
  let currentData = "";
  let lastCompleteIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      // Empty line = event boundary
      if (currentData) {
        if (currentData !== "[DONE]") parsed.push({ data: currentData });
        currentData = "";
      }
      lastCompleteIdx = i + 1;
    } else if (line.startsWith(":")) {
      // SSE comment line — skip (e.g. heartbeat)
      lastCompleteIdx = i + 1;
    } else if (line.startsWith("data:")) {
      const dataContent = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      currentData += (currentData ? "\n" : "") + dataContent;
    }
    // Other fields (event:, id:, retry:) are silently ignored per SSE spec
  }
  const remaining = lines.slice(lastCompleteIdx).join("\n");
  return { parsed, remaining };
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof ProviderError && (err.code === "auth" || err.code === "credit")) {
        throw err; // Don't retry auth/credit errors
      }
      // Don't retry abort signals — user deliberately cancelled
      if (lastError.name === "AbortError") {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * CORS-free fetch using Tauri's HTTP plugin (bypasses browser CORS restrictions).
 * Falls back to browser fetch if the plugin is unavailable.
 */
export async function corsFetch(url: string, options: RequestInit): Promise<Response> {
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const resp = await tauriFetch(url, {
      method: options.method as string || "GET",
      headers: options.headers as Record<string, string> || {},
      body: options.body as string | undefined,
      signal: options.signal,
    });
    // Wrap Tauri response as a standard Response-like object
    const respHeaders = new Headers();
    for (const [k, v] of Object.entries(resp.headers)) respHeaders.set(k, v);
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: resp.body,
      text: async () => new TextDecoder().decode(await resp.arrayBuffer()),
      json: async () => JSON.parse(new TextDecoder().decode(await resp.arrayBuffer())),
      arrayBuffer: async () => resp.arrayBuffer(),
      clone: () => new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: respHeaders }),
    } as Response;
  } catch {
    // Fallback to browser fetch if plugin unavailable
    return fetch(url, options);
  }
}

/**
 * Wraps a fetch call with retry-with-backoff for transient network/5xx errors.
 * Classifies the response into a ProviderError and retries on transient failures.
 * Non-transient errors (auth 401, credit 402/429) are thrown immediately.
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
      if (resp.status === 402 || resp.status === 429) throw new ProviderError("Insufficient credits or rate limited.", "credit");
      if (resp.status >= 500) throw new ProviderError(`Provider error (${resp.status}): ${text.slice(0, 200)}`, "provider");
      throw new ProviderError(`HTTP ${resp.status}: ${text.slice(0, 200)}`, "provider");
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
): Promise<any> {
  return retryWithBackoff(async () => {
    const resp = await corsFetch(url, options);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) throw new ProviderError("Authentication failed. Check your API key.", "auth");
      if (resp.status === 403) throw new ProviderError("Access forbidden. Check your API key and permissions.", "auth");
      if (resp.status === 402 || resp.status === 429) throw new ProviderError("Insufficient credits or rate limited.", "credit");
      throw new ProviderError(`Failed to summarize: HTTP ${resp.status} - ${text.slice(0, 300)}`, "provider");
    }
    return resp.json();
  }, maxRetries, baseDelayMs);
}

async function* streamOpenAI(
  baseUrl: string, apiKey: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (maxTokens) body.max_tokens = maxTokens;
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, 2, 1000, signal);
  const reader = resp.body?.getReader();
  if (!reader) throw new ProviderError("No response body", "network");
  const decoder = new TextDecoder();
  let buffer = "";
  const STREAM_READ_TIMEOUT_MS = 60_000; // 60s per read — detect hung streams
  let lastTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearLastTimeout = () => { if (lastTimeout !== undefined) { clearTimeout(lastTimeout); lastTimeout = undefined; } };

  // Tool call argument accumulation: OpenAI-compatible providers stream
  // function.arguments incrementally across SSE chunks (e.g. "{\"path\": \"/" then "etc/file\"}").
  // We must accumulate partial JSON by tool_call index before parsing.
  const _tcArgBuffers = new Map<number, { name: string; args: string }>();

  /** Build an XML tag from a completed tool call name + parsed JSON args */
  function _emitToolCallXml(tcName: string, parsedArgs: Record<string, any>): string {
    const attrs = Object.entries(parsedArgs)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join(" ");
    const bodyTools = ["write_file", "edit_file", "clipboard_write", "memory_save"];
    if (bodyTools.includes(tcName) && parsedArgs.content) {
      const contentStr = typeof parsedArgs.content === "string" ? parsedArgs.content : "";
      const bodyAttrs = Object.entries(parsedArgs)
        .filter(([k, v]) => k !== "content" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
        .join(" ");
      return `<${tcName} ${bodyAttrs}>${contentStr}</${tcName}>`;
    }
    if (tcName === "edit_file" && parsedArgs.search && parsedArgs.replace !== undefined) {
      return `<${tcName} path="${parsedArgs.path || ''}">\n<search>${parsedArgs.search}</search>\n<replace>${parsedArgs.replace}</replace>\n</${tcName}>`;
    }
    return attrs ? `<${tcName} ${attrs}/>` : `<${tcName}/>`;
  }

  try {
    while (true) {
      clearLastTimeout();
      // Race reader.read() against a timeout to detect hung streams
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          lastTimeout = setTimeout(() => reject(new ProviderError("Stream read timed out (60s no data)", "network")), STREAM_READ_TIMEOUT_MS);
          // Attach signal to clean up timer if aborted
          signal?.addEventListener("abort", () => clearLastTimeout(), { once: true });
        }),
      ]);
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { parsed, remaining } = parseSSEEvents(buffer);
      buffer = remaining;
      for (const part of parsed) {
        try {
          const json = JSON.parse(part.data);
          if (json.error) {
            throw new ProviderError(json.error.message || JSON.stringify(json.error), "provider");
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
          if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
          // Native function calling: accumulate delta.tool_calls into XML tags.
          // Arguments arrive incrementally — we buffer partial JSON by index
          // and only emit once parsing succeeds.
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const tcIdx = tc.index ?? 0;
              const fn = tc.function;
              if (fn?.name) {
                // Record or update the buffer for this tool call index
                const existing = _tcArgBuffers.get(tcIdx);
                if (existing) {
                  // Accumulate: new arguments are appended
                  existing.args += fn.arguments || "";
                } else {
                  _tcArgBuffers.set(tcIdx, { name: fn.name, args: fn.arguments || "" });
                }
                // Try to parse the accumulated args
                const buf = _tcArgBuffers.get(tcIdx)!;
                try {
                  const parsedArgs = JSON.parse(buf.args);
                  // Success — emit XML and remove from buffer
                  _tcArgBuffers.delete(tcIdx);
                  const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
                  yield { type: "message-delta", messageId: json.id || "", content: "\n" + xmlTag + "\n" };
                } catch {
                  // Incomplete JSON — keep buffering, will try on next chunk
                }
              }
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          console.warn("SSE parse error (OpenAI):", e);
        }
      }
    }
    // Process any remaining buffered data
    if (buffer.trim()) {
      const { parsed } = parseSSEEvents(buffer + "\n\n");
      for (const part of parsed) {
        try {
          const json = JSON.parse(part.data);
          if (json.error) {
            throw new ProviderError(json.error.message || JSON.stringify(json.error), "provider");
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
          if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const tcIdx = tc.index ?? 0;
              const fn = tc.function;
              if (fn?.name) {
                const existing = _tcArgBuffers.get(tcIdx);
                if (existing) {
                  existing.args += fn.arguments || "";
                } else {
                  _tcArgBuffers.set(tcIdx, { name: fn.name, args: fn.arguments || "" });
                }
                const buf = _tcArgBuffers.get(tcIdx)!;
                try {
                  const parsedArgs = JSON.parse(buf.args);
                  _tcArgBuffers.delete(tcIdx);
                  const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
                  yield { type: "message-delta", messageId: json.id || "", content: "\n" + xmlTag + "\n" };
                } catch {
                  // Still incomplete
                }
              }
            }
          }
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          console.warn("SSE parse error (OpenAI):", e);
        }
      }
    }
    // Flush any remaining incomplete tool call buffers (emit with whatever args we have)
    for (const [idx, buf] of _tcArgBuffers) {
      try {
        const parsedArgs = JSON.parse(buf.args || "{}")
        const xmlTag = _emitToolCallXml(buf.name, parsedArgs);
        yield { type: "message-delta", messageId: "", content: "\n" + xmlTag + "\n" };
      } catch {
        // Emit as raw text fallback so the tool call isn't silently dropped
        yield { type: "message-delta", messageId: "", content: "\n<" + buf.name + ">" + buf.args + "</" + buf.name + ">\n" };
      }
    }
    _tcArgBuffers.clear();
  } finally {
    reader.releaseLock();
  }
}

async function* streamAnthropic(
  baseUrl: string, apiKey: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const systemMsg = messages.find((m) => m.role === "system")?.content || "";
  const chatMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, system: systemMsg, messages: chatMessages, stream: true };
  if (maxTokens) body.max_tokens = maxTokens;
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
  const STREAM_READ_TIMEOUT_MS = 60_000; // 60s per read — detect hung streams
  _debugLog("[streamAnthropic] Starting stream, url:", url);
  try {
    while (true) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new ProviderError("Stream read timed out (60s no data)", "network")), STREAM_READ_TIMEOUT_MS);
          signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
        }),
      ]);
      const { done, value } = readResult;
      if (done) break;
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
          if (json.type === "content_block_delta" && json.delta?.text) {
            yield { type: "message-delta", messageId: msgId, content: json.delta.text };
          }
          if (json.type === "content_block_delta" && json.delta?.thinking) {
            yield { type: "activity-think", content: json.delta.thinking };
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
        } catch (e) {
          if (e instanceof ProviderError) throw e;
          console.warn("SSE parse error (Anthropic):", e);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamChat(
  baseUrl: string, apiKey: string, apiFormat: string, model: string,
  messages: ApiMessage[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  if (apiFormat === "anthropic") {
    yield* streamAnthropic(baseUrl, apiKey, model, messages, signal, maxTokens);
  } else {
    yield* streamOpenAI(baseUrl, apiKey, model, messages, signal, maxTokens);
  }
}

const JUNK_DIRS = new Set([".git", "node_modules", "__pycache__", ".next", ".nuxt", "dist", "build", ".turbo", ".cache", ".vscode", ".idea", "coverage", ".output"]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".gitkeep"]);

async function readDirRecursive(dirPath: string, maxDepth: number = 20, maxFiles: number = 10000, _count: {n: number} = {n: 0}, _visited: Set<string> = new Set()): Promise<FileNode[]> {
  if (_visited.has(dirPath)) return [];
  _visited.add(dirPath);
  if (_count.n >= maxFiles) return [];
  const { readDir } = await import("@tauri-apps/plugin-fs");
  let entries;
  try {
    entries = await readDir(dirPath);
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (_count.n >= maxFiles) break;
    if (!entry.name) continue;
    if (JUNK_FILES.has(entry.name)) continue;
    if (entry.isDirectory && JUNK_DIRS.has(entry.name)) continue;
    const fullPath = joinPath(dirPath, entry.name!);
    if (entry.isDirectory) {
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
      const fullPath = joinPath(parentPath, name);
      if (!(await exists(fullPath))) await writeFile(fullPath, new Uint8Array());
      return { name, path: fullPath, type: "file" };
    },
    async createDirectory(parentPath, name) {
      const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
      const fullPath = joinPath(parentPath, name);
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
      } catch { /* store not available */ }
    },
    async renamePath(path, newName) {
      const { rename, readFile, writeFile: fsWriteFile, remove: fsRemove } = await import("@tauri-apps/plugin-fs");
      const parentDir = dirname(path);
      const newPath = joinPath(parentDir, newName);
      try {
        await rename(path, newPath);
      } catch {
        const bytes = await readFile(path);
        await fsWriteFile(newPath, bytes);
        await fsRemove(path);
      }
      // Update open tabs to reflect the new path
      try {
        const { useWorkspace } = await import("../store/useAppStore");
        const { openTabs, closeTab, setActiveFile } = useWorkspace.getState();
        const wasActive = useWorkspace.getState().activeFilePath === path;
        closeTab(path);
        if (wasActive) setActiveFile(newPath);
      } catch { /* store not available */ }
    },
    async watchPath(path: string) {
      const { watchImmediate } = await import("@tauri-apps/plugin-fs");
      try {
        const unwatch = await watchImmediate(path, (_event) => {
        });
        // Store the unwatch function so it can be called later
        fileWatchers.set(path, unwatch);
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
      async create(cwd?: string, title?: string) {
        const id = "t-" + Math.random().toString(36).slice(2, 9);
        try {
          const { Command } = await import("@tauri-apps/plugin-shell");
          const isWindows = typeof window !== "undefined" && window.navigator.userAgent.includes("Windows");
          // title may be a display name like "Terminal - zsh" — extract the shell
          const extractShell = (t: string): string => {
            const afterDash = t.includes(" - ") ? t.split(" - ").pop()!.trim() : t.trim();
            const known = ["zsh", "bash", "fish", "powershell", "cmd", "pwsh"];
            const lower = afterDash.toLowerCase();
            return known.includes(lower) ? lower : (isWindows ? "powershell" : "bash");
          };
          const shellCmd = title ? extractShell(title) : (isWindows ? "powershell" : "bash");

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
      const sessionId = "ses-" + Math.random().toString(36).slice(2, 14);
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
          mcpToolsDocumentation = "\n\n=== CONNECTED MCP TOOLS ===\nYou have access to external tools provided by connected MCP servers. To call an MCP tool, output an XML tag of the form:\n<mcp_<server_name>_<tool_name> [args] />\nOr if the arguments are complex or contain newlines/nested tags:\n<mcp_<server_name>_<tool_name>>\n  <argName1>value1</argName1>\n  <argName2>value2</argName2>\n</mcp_<server_name>_<tool_name>>\n\nAvailable MCP Tools:\n";
          mcpServers.forEach((server) => {
            if (server.tools && server.tools.length > 0) {
              mcpToolsDocumentation += `\nFrom MCP Server "${server.name}":\n`;
              server.tools.forEach((tool) => {
                const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "{}";
                mcpToolsDocumentation += `- <mcp_${server.name}_${tool.name}/>: ${tool.description}\n  Arguments: ${schema}\n`;
              });
            }
          });
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
            const { exists } = await import("@tauri-apps/plugin-fs");
            const memoryPath = joinPath(workspacePath, ".dalam/memory.json");
            if (await exists(memoryPath)) {
              const memoryContent = await dalamAPI.fs.readFile(memoryPath);
              const memoryObj = JSON.parse(memoryContent);
              workspaceMemoryBlock = `\n\n=== PERSISTENT WORKSPACE MEMORY ===\nDalam maintains a persistent memory file for this workspace at \`.dalam/memory.json\`. You can modify this file using your edit/write file tools to remember key rules, paths, build commands, or context for future turns.\n\nCurrent Contents:\n- Project Overview: ${memoryObj.projectOverview || "Not specified."}\n- Key Files/Directories: ${JSON.stringify(memoryObj.keyFiles || [])}\n- Build/Test Commands: ${JSON.stringify(memoryObj.buildCommands || [])}\n- Learned Rules:\n${(memoryObj.learnedRules || []).map((r: string) => `  * ${r}`).join("\n")}\n===================================`;
            }
          } catch (e) { console.warn("Failed to load workspace memory:", e); }
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
                sqliteMemoriesBlock = `\n\n=== RETRIEVED WORKSPACE MEMORIES ===\nThese are relevant memories retrieved from the persistent workspace memory store. Keep them in mind during the session:\n`;
                for (const mem of allInjected) {
                  const tierIcon = { critical: "🔴", high: "🟡", medium: "🔵", low: "⚪" }[mem.tier];
                  sqliteMemoriesBlock += `\n- ${tierIcon} [${mem.category}] ${mem.summary} (tags: ${mem.tags.join(", ")})\n  ${mem.content.split("\n").join("\n  ")}\n`;
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
            const { exists } = await import("@tauri-apps/plugin-fs");
            const contextPath = joinPath(workspacePath, ".dalam/context.json");
            if (await exists(contextPath)) {
              const contextContent = await dalamAPI.fs.readFile(contextPath);
              const contextObj = JSON.parse(contextContent);
              if (contextObj.pinnedFiles && contextObj.pinnedFiles.length > 0) {
                let pinnedBlock = "\n\n=== PINNED FILES ===\nThe following files are pinned in your context. You should keep their contents in mind:\n";
                for (const filePath of contextObj.pinnedFiles) {
                  try {
                    const fullPath = joinPath(workspacePath, filePath);
                    if (await exists(fullPath)) {
                      const fileContent = await dalamAPI.fs.readFile(fullPath);
                      pinnedBlock += `\n--- Pinned File: ${filePath} ---\n${fileContent}\n`;
                    }
                  } catch (e) { console.warn(`Failed to read pinned file ${filePath}:`, e); }
                }
                pinnedBlock += "=====================";
                workspacePinnedBlock = pinnedBlock;
              }
            }
          } catch (e) { console.warn("Failed to load workspace context:", e); }
        }

        // 4-layer instructions hierarchy
        let workspaceRulesBlock = "";
        if (workspacePath) {
          try {
            const { exists } = await import("@tauri-apps/plugin-fs");
            const instructions = await loadInstructions(workspacePath, {
              readFile: dalamAPI.fs.readFile,
              exists: async (p: string) => exists(p),
              getHomeDir: async () => {
                const { homeDir } = await import("@tauri-apps/api/path");
                return homeDir();
              },
            });
            workspaceRulesBlock = formatInstructionsForPrompt(instructions, activeFile ?? undefined);
          } catch (e) { console.warn("Failed to load workspace instructions:", e); }
        }

        const toolsDocumentation = `
=== AGENTIC TOOLS HARNESS ===
You are equipped with tools to interact with the workspace and operating system. To invoke a tool, output the corresponding XML tag in your response. The system will pause, execute the tool, and provide the result in your next turn. You can invoke multiple tools in a single turn.

--- File & Workspace Tools ---
1. Read File:
   <read_file path="absolute_path"/>
   Reads the entire contents of a file.

2. Write File:
   <write_file path="absolute_path">file content</write_file>
   Overwrites or creates a file with the specified content.

3. Edit File:
   <edit_file path="absolute_path">
   <search>exact code to find</search>
   <replace>new code to replace it with</replace>
   </edit_file>
   Performs a search-and-replace edit. The search block must match the file contents exactly.

4. List Directory:
   <list_dir path="absolute_path"/>
   Lists files and folders inside the directory.

5. Grep File:
   <grep_file path="absolute_path" pattern="search text" regex="false" max_results="50"/>
   Searches for a pattern within a single file. Returns matching lines with line numbers.
   Set regex="true" to use regular expressions.

6. Search Files:
   <search_files path="workspace_path" pattern="search text" glob="*.ts" regex="false" max_results="100"/>
   Searches for a pattern across multiple files in a directory tree. Returns matching lines with file paths.
   Use glob to filter file types (e.g. "*.tsx", "*.py").

7. Run Command:
   <run_command command="shell command"/>
   Executes a shell command in the workspace directory and returns its output.

--- Git Tools ---
6. Git Status:
   <git_status/>
   Gets the git status of the project.

7. Git Commit:
   <git_commit message="message"/>
   Commits all changes.

8. Git Log:
   <git_log/>
   Gets the git commit history.

--- Desktop / System Tools ---
9. Clipboard Read:
    <clipboard_read/>
    Reads text from the system clipboard.

10. Clipboard Write:
    <clipboard_write>text to copy</clipboard_write>
    Writes text to the system clipboard.

11. Send Notification:
    <notify title="Title" body="Notification body"/>
    Sends a desktop notification.

12. System Info:
    <system_info/>
    Gets OS, architecture, hostname, shell, and locale information.

13. Open URL:
    <open_url url="https://example.com"/>
    Opens a URL in the system default browser.

14. Launch Application:
    <launch_app name="app_name" args="optional_args" cwd="optional_working_dir"/>
    Launches a desktop application by name (e.g. "code", "firefox").
    Supports optional arguments and working directory.

15. Reveal in Finder:
    <reveal_in_finder path="absolute_path"/>
    Opens the file manager and reveals the file or directory.

--- Memory Tools ---
16. Save Memory:
    <memory_save category="user" tier="high" summary="short summary" tags="tag1,tag2">detailed content</memory_save>
    Saves a memory entry for this workspace. Categories: user, feedback, project, reference, task, decision.
    Tiers: critical, high, medium, low. Use this to remember rules, preferences, key facts, or decisions.

17. Search Memory:
    <memory_search query="search terms" category="project" limit="5"/>
    Searches the workspace memory store using full-text search. Returns matching memories.
    Optional filters: category (user|feedback|project|reference|task|decision), limit (default 10).

18. Delete Memory:
    <memory_delete id="memory-id"/>
    Soft-deletes a memory entry by marking it stale. Stale entries are excluded from search
    results and purged during maintenance. Use memory_search first to find the id to delete.

19. Memory Stats:
    <memory_stats/>
    Shows memory store statistics: total count, breakdown by category and tier, and stale count.

20. Memory Maintenance:
    <memory_maintain/>
    Runs self-improving maintenance: detects stale memories, enforces budget (500 max),
    and purges old stale entries. Returns a summary of actions taken.

21. Extract Memories (LLM):
    <memory_extract/>
    Uses LLM to analyze the current conversation and extract high-quality memories.
    More sophisticated than heuristic extraction. Saves results automatically.

22. Export Memories:
    <memory_export/>
    Exports all memories to markdown files in .dalam/memories/ for git sharing.
    Teammates can import these files when they clone the repo.

23. Import Memories:
    <memory_import/>
    Imports memories from markdown files in .dalam/memories/ into the SQLite cache.
    Use after cloning a repo to restore shared memories.

Always use absolute paths for file operations. The workspace path is: ${workspacePath || "."}.
`;

        // Genes
        const genePool = loadGenePool();
        const rawHistory = conversationHistory ? [...conversationHistory] : [];
        const recentMsgs = rawHistory.filter((msg) => msg.role !== "system").slice(-5);
        const activeGenes = expressGenes(genePool, cleanPrompt, recentMsgs);
        const genesPrompt = formatGenesForPrompt(activeGenes);

        const systemPrompt = (agentName === "plan"
          ? "You are Dalam in Plan mode. You are a read-only analysis agent. Explore the codebase, understand the task, and produce a clear, actionable plan. Do NOT edit, write, or delete any files. Do NOT run shell commands that modify files. You may read files and search the codebase. When your plan is complete, write it to .dalam/plans/ directory as a markdown file, then end your response with exactly: [PLAN_COMPLETE] — this signals the user to review and approve."
          : agentName === "yolo"
            ? "You are Dalam in YOLO mode. You have FULL unrestricted access — read, write, execute anything without asking. Be efficient and direct. Execute tasks without seeking permission."
            : "You are Dalam, an AI coding assistant. Help users write, debug, and understand code. Be concise and practical. When showing code, use markdown code blocks with the appropriate language. Always ask the user before executing shell commands or making file changes.")
          + workspaceMemoryBlock
          + sqliteMemoriesBlock
          + workspaceRulesBlock
          + toolsDocumentation
          + activeSkillPrompt
          + mcpToolsDocumentation
          + activeFileContext
          + workspacePinnedBlock
          + genesPrompt;

        return systemPrompt;
      }

      const prev = activeControllers.get(sessionId);
      if (prev) prev.abort();
      const ac = new AbortController();
      activeControllers.set(sessionId, ac);
      const emit = (event: StreamEvent) => { streamCallbacks.get(sessionId)?.(event); };

      const sessionStartTime = Date.now();

      // Hook: UserPromptSubmit
      await hookBus.emit("UserPromptSubmit", {
        sessionId,
        prompt,
        conversationHistory: conversationHistory ?? [],
        agentName: agentName ?? "build",
        attachments: (attachments ?? []).map((a) => ({ name: a.name, mimeType: a.mimeType })),
        timestamp: Date.now(),
      });

      let consecutiveRateLimitErrors = 0;

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

        // Loop state
        const currentHistory: ChatMessage[] = conversationHistory ? [...conversationHistory] : [];
        let totalFullContent = "";
        let totalToolCalls = 0;
        let loopCount = 0;
        const MAX_LOOP_HARD = 30;
        const loopStartTime = Date.now();
        const MAX_LOOP_DURATION_MS = 5 * 60 * 1000;

        const summaries = useChat.getState().compactionSummaries || {};
        const compactionSummary = summaries[sessionId];
        const liveSession = useChat.getState().chatSessions.find((s) => s.id === sessionId) || useChat.getState().session;
        const workspacePath = liveSession?.workspacePath ?? "";

        // Build messages from LIVE currentHistory (not pre-loop snapshot)
        // Token-budget-aware: uses estimateTokens for accurate counting
        async function buildMessages(): Promise<ApiMessage[]> {
          const { estimateTokens: estTokens } = await import("./contextManager");
          const MAX_TOKENS = 80000;
          // Reserve tokens for system prompt, compaction summary, and output
          const systemTokenEst = estTokens(systemPrompt);
          const OUTPUT_RESERVE = 8000;
          const allMsgs = currentHistory.filter((m) => m.role !== "system");
          const COMPACT_RESERVE = compactionSummary && allMsgs.length > 10 ? estTokens(compactionSummary) + 100 : 0;
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
            const contentTokens = estTokens(content);
            if (tokenCount + contentTokens > availableForHistory && msgs.length >= 2) break;
            tokenCount += contentTokens;
            msgs.unshift(m);
          }

          const result: ApiMessage[] = [{ role: "system", content: systemPrompt }];
          if (compactionSummary && allMsgs.length > 10) {
            result.push({ role: "system", content: `[COMPACTED HISTORY]\n${compactionSummary}\n` });
          }
          for (const m of msgs) {
            result.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
          }
          return result;
        }

        function rateLimitDelay(): Promise<void> {
          if (consecutiveRateLimitErrors > 0) {
            // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
            const delay = Math.min(1000 * Math.pow(2, consecutiveRateLimitErrors), 30000);
            return new Promise((r) => setTimeout(r, delay));
          }
          // Base delay between turns to avoid rate limits and give UI time to render
          return new Promise((r) => setTimeout(r, 500));
        }

        while (loopCount < MAX_LOOP_HARD) {
          loopCount++;

          if (Date.now() - loopStartTime > MAX_LOOP_DURATION_MS) {
            emit({ type: "error", error: `Agent loop timed out after ${MAX_LOOP_DURATION_MS / 1000}s.` });
            emit({ type: "message-end", messageId: sessionId });
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
          useChat.setState({ isStreaming: true });

          await rateLimitDelay();

          const maxTokens = settings.maxTokens ?? 4096;
          _debugLog(`[sendPrompt] Turn ${loopCount}: starting stream, model=${modelId}, messages=${messages.length}`);
          const stream = streamChat(config.baseUrl, config.apiKey, config.apiFormat || "openai", modelId, messages, ac.signal, maxTokens);
          let fullContent = "";
          let lastMessageId = "";
          let eventCount = 0;

          for await (const event of stream) {
            eventCount++;
            if (event.type === "message-delta") {
              fullContent += event.content;
              lastMessageId = event.messageId;
            }
            emit(event);
          }
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
          const sortedStringify = (obj: Record<string, any>) => JSON.stringify(obj, Object.keys(obj).sort());
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

          // FIX: Single parse pass for display content — strip all tool tags
          const TOOL_TAG_RE = /<(?:read_file|write_file|edit_file|list_dir|grep_file|search_files|run_command|git_status|git_commit|git_log|clipboard_read|clipboard_write|notify|system_info|open_url|launch_app|reveal_in_finder|get_env|get_screen_info|list_processes|kill_process|get_disk_space|memory_save|memory_search|memory_delete|memory_stats|memory_maintain|memory_extract|memory_export|memory_import|mcp_[\w_]+)[\s\S]*?(?:\/>|<\/[\w_]+>)/g;
          const displayContent = safeTextForParsing.replace(TOOL_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();

          // Emit display content if non-empty
          if (displayContent) {
            const assistantTurnMsg = {
              id: lastMessageId || sessionId,
              role: "assistant" as const,
              content: displayContent,
              timestamp: Date.now(),
            };
            currentHistory.push(assistantTurnMsg);
          }

          if (parsedTools.length > 0) {
            // FIX 2: Parallel tool approval and execution
            const toolCallMetas = parsedTools.map((pt) => ({
              id: "tc-" + Math.random().toString(36).slice(2, 9),
              name: pt.name,
              args: pt.args,
              status: "pending" as const,
              raw: pt,
            }));

            // Show all tool calls to user at once
            for (const tc of toolCallMetas) {
              emit({ type: "tool-call", toolCall: { id: tc.id, name: tc.name, args: tc.args, status: tc.status } });
            }

            // Check which tools were auto-approved (permission already granted)
            // by reading their status from the store right after emit
            const autoApprovedTools = new Set<string>();
            try {
              const { useChat } = await import("../store/useAppStore");
              const pending = useChat.getState().pendingToolCalls;
              for (const tc of toolCallMetas) {
                const stored = pending.find((t) => t.id === tc.id);
                if (stored && stored.status === "completed") {
                  autoApprovedTools.add(tc.id);
                }
              }
            } catch { /* store not available */ }

            // Execute tools with approval
            const toolResults: string[] = [];
            for (const tc of toolCallMetas) {
              _debugLog(`[sendPrompt] Turn ${loopCount}: executing tool ${tc.id} (${tc.name})`);
              // Check abort signal before each tool execution
              if (ac.signal.aborted) {
                toolResults.push(`[TOOL RESULT: ${tc.name}]\nAborted by user.`);
                break;
              }
              const decision = await waitForToolApproval(tc.id, ac.signal);
              _debugLog(`[sendPrompt] Turn ${loopCount}: tool ${tc.id} approval decision: ${decision}`);
              if (ac.signal.aborted) {
                toolResults.push(`[TOOL RESULT: ${tc.name}]\nAborted by user.`);
                break;
              }
              if (decision === "approved") {
                const isAutoApproved = autoApprovedTools.has(tc.id);
                const toolStartTime = Date.now();
                try {
                  const result = await executeTool(tc.name, tc.args, workspacePath || ".", emit, isAutoApproved);
                  const durationMs = Date.now() - toolStartTime;
                  emit({ type: "tool-result", toolCallId: tc.id, result });

                  // Emit activity events
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
                  toolResults.push(`[Tool result for ${tc.name}]\n${result || "(no output)"}`);
                } catch (err) {
                  const errMsg = (err as Error)?.message ?? String(err);
                  emit({ type: "tool-result", toolCallId: tc.id, result: `Error: ${errMsg}` });
                  await hookBus.emit("PostToolUse", { sessionId, toolName: tc.name, toolArgs: tc.args, result: `Error: ${errMsg}`, error: errMsg, durationMs: Date.now() - toolStartTime, timestamp: Date.now() });
                  toolResults.push(`[Tool error for ${tc.name}]\nError: ${errMsg}`);
                }
              } else {
                toolResults.push(`[Tool result for ${tc.name}]\nPermission Denied by user.`);
              }
            }

            // Push combined tool results as single user message
            if (toolResults.length > 0) {
              currentHistory.push({ id: "tr-" + Math.random().toString(36).slice(2, 9), role: "user" as const, content: toolResults.join("\n\n"), timestamp: Date.now() });
              totalToolCalls += toolResults.length;
            }

            // Reset streaming state
            emit({ type: "message-end", messageId: lastMessageId || sessionId });
            useChat.setState({ streamingContent: "", thinkingContent: "" });

            consecutiveRateLimitErrors = 0;
            continue;
          }

          // No tools parsed — turn is complete
          emit({ type: "message-end", messageId: lastMessageId || sessionId });
          break;
        }

        // If loop exhausted all iterations without break, emit message-end
        if (loopCount >= MAX_LOOP_HARD) {
          emit({ type: "message-end", messageId: sessionId });
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
        } catch (_e) { /* failed to read session message count */ }

        if (err instanceof ProviderError) {
          if (err.code === "credit") consecutiveRateLimitErrors++;
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
          emit({ type: "error", error: `Network error: ${(err as Error)?.message ?? "Unknown"}` });
          emit({ type: "message-end", messageId: sessionId });
          await hookBus.emit("SessionEnd", {
            sessionId,
            reason: "error",
            messageCount,
            durationMs: Date.now() - startTime,
            timestamp: Date.now(),
          });
        }
      } finally {
        activeControllers.delete(sessionId);
        sessionStartTimes.delete(sessionId);
        // Clean up file watchers — watchers are keyed by path, clean all active ones
        for (const [watchPath, unwatch] of fileWatchers) {
          try { unwatch(); } catch { /* ignore */ }
        }
        fileWatchers.clear();
        // Clean up MCP HTTP sessions (keyed by server name, remove all for this session)
        for (const [serverName, sesId] of mcpHttpSessions) {
          if (sesId === sessionId) mcpHttpSessions.delete(serverName);
        }
        // Clean up all pending diff proposals (they're session-scoped)
        pendingDiffProposals.clear();
        // Clean up stream listener cleanup functions
        streamCleanups.delete(sessionId);
        // Clean up SessionEnd dedup tracking
        emittedSessionEnds.delete(sessionId);
        // Safety: ensure isStreaming is always cleared, even if message-end/error failed to fire
        try {
          const { useChat } = await import("../store/useAppStore");
          const state = useChat.getState();
          if (state.isStreaming && state.activeSessionId === sessionId) {
            _debugLog(`[sendPrompt] finally: isStreaming still true for ${sessionId}, force-clearing`);
            // Emit message-end before clearing so the UI gets the final message
            emit({ type: "message-end", messageId: sessionId });
            useChat.setState({ isStreaming: false, streamingContent: "", thinkingContent: "" });
          }
        } catch { /* store not available */ }
        // Delete callback AFTER emitting the safety message-end
        streamCallbacks.delete(sessionId);
      }

    },
    async abort(sessionId) {
      const startTime = sessionStartTimes.get(sessionId) ?? Date.now();
      let messageCount = 0;
      try {
        const { useChat } = await import("../store/useAppStore");
        const sessionMessages = useChat.getState().sessionMessages[sessionId];
        messageCount = sessionMessages?.length ?? 0;
      } catch { /* store not available */ }
      // Only emit SessionEnd if we're the ones cleaning up (not sendPrompt's finally)
      if (activeControllers.has(sessionId) && !emittedSessionEnds.has(sessionId)) {
        emittedSessionEnds.add(sessionId);
        hookBus.emit("SessionEnd", {
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
      const { settings, config } = getActiveProvider(false);

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
      }, 2, 1000);
      if (isAnthropic) {
        return json.content?.[0]?.text || "";
      } else {
        return json.choices?.[0]?.message?.content || "";
      }
    },
    async approveDiff(sessionId: string, diffId: string) {
      const pending = pendingDiffProposals.get(diffId);
      if (pending) {
        pendingDiffProposals.delete(diffId);
        // Write the file now that the user approved the diff
        await dalamAPI.fs.writeFile(pending.filePath, pending.newContent);
        const cb = streamCallbacks.get(sessionId);
        if (cb) {
          cb({
            type: "file-changed",
            change: {
              path: pending.filePath,
              action: "modified",
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
              id: "diff-approval-" + Math.random().toString(36).slice(2, 9),
              role: "system",
              content: `User approved the file write. ${pending.filePath} has been updated (${pending.hunks.reduce((n, h) => n + h.newLines, 0)} lines added, ${pending.hunks.reduce((n, h) => n + h.oldLines, 0)} removed). Continue with your task.`,
              timestamp: Date.now(),
            };
            const newMsgs = [...msgs, approvalMsg];
            useChat.setState({
              sessionMessages: { ...chatState.sessionMessages, [sessionId]: newMsgs },
              messages: [...chatState.messages, approvalMsg],
            });
          }
        } catch { /* store not available */ }
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
      storeSettings(s as never);
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
      } catch {
        try {
          const { Command } = await import("@tauri-apps/plugin-shell");
          const isWindows = typeof window !== "undefined" && window.navigator.userAgent.includes("Windows");
          const cmd = isWindows ? "explorer" : "open";
          const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path.includes("\\") ? path.split("\\").slice(0, -1).join("\\") : path;
          await Command.create(cmd, [dir]).execute();
        } catch { /* silent */ }
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
  },
};

interface ParsedToolCall {
  name: string;
  args: Record<string, any>;
  raw: string;
}

function parseAttributes(tagStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match key="value" or key='value', ensuring matching opening and closing quotes
  const regex = /([a-zA-Z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let match;
  while ((match = regex.exec(tagStr)) !== null) {
    const val = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : "");
    // Unescape: remove backslash before quotes
    attrs[match[1]] = val.replace(/\\(["'])/g, "$1");
  }
  return attrs;
}

/**
 * Extract tool calls from markdown code blocks.
 * LLMs like Llama 3.3 70B often wrap tool calls in ```xml or ``` tags.
 * Previously, code block stripping replaced these with "[code block]"
 * before they could be parsed, causing the agent to get stuck.
 */
const KNOWN_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "list_dir", "grep_file", "search_files",
  "run_command", "git_status", "git_commit", "git_log",
  "clipboard_read", "clipboard_write", "notify", "system_info", "open_url",
  "launch_app", "reveal_in_finder",
  "get_env", "get_screen_info", "list_processes", "kill_process", "get_disk_space",
  "memory_save", "memory_search", "memory_delete", "memory_stats",
  "memory_maintain", "memory_extract", "memory_export", "memory_import",
]);

function extractToolCallsFromCodeBlocks(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  const codeBlockRegex = /```(?:xml|html|tool|[\w-]*)?\s*\n([\s\S]*?)```/gi;
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
          if (innerContent) args["content"] = innerContent;
        }
      }
      toolCalls.push({ name: tagName, args, raw: fullTag });
    }
  }
  return toolCalls;
}

async function parseToolCalls(text: string): Promise<ParsedToolCall[]> {
  const toolCalls: ParsedToolCall[] = [];

  // 1. read_file — handle both self-closing <read_file path="..."/> and <read_file path="..."></read_file>
  const readFileRegex = /<read_file\s+path=["']([^"']+)["']\s*\/?>/gi;
  let match;
  while ((match = readFileRegex.exec(text)) !== null) {
    toolCalls.push({ name: "read_file", args: { path: match[1] }, raw: match[0] });
  }

  // 2. write_file
  const writeFileRegex = /<write_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/write_file>/gi;
  while ((match = writeFileRegex.exec(text)) !== null) {
    toolCalls.push({ name: "write_file", args: { path: match[1], content: match[2] }, raw: match[0] });
  }

  // 3. edit_file
  const editFileRegex = /<edit_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/edit_file>/gi;
  while ((match = editFileRegex.exec(text)) !== null) {
    const innerText = match[2];
    const searchMatch = /<search>([\s\S]*?)<\/search>/i.exec(innerText);
    const replaceMatch = /<replace>([\s\S]*?)<\/replace>/i.exec(innerText);
    if (searchMatch && replaceMatch) {
      toolCalls.push({
        name: "edit_file",
        args: { path: match[1], search: searchMatch[1], replace: replaceMatch[1] },
        raw: match[0]
      });
    }
  }

  // 4. list_dir — handle both self-closing and closing tags
  const listDirRegex = /<list_dir\s+path=["']([^"']+)["']\s*\/?>/gi;
  while ((match = listDirRegex.exec(text)) !== null) {
    toolCalls.push({ name: "list_dir", args: { path: match[1] }, raw: match[0] });
  }

  // 5. grep_file — use [^>]* instead of [\s\S]*? to prevent catastrophic backtracking
  const grepFileRegex = /<grep_file\s+([^>]*)\/?>/gi;
  while ((match = grepFileRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.path && attrs.pattern) {
      toolCalls.push({ name: "grep_file", args: { path: attrs.path, pattern: attrs.pattern, regex: attrs.regex, max_results: attrs.max_results }, raw: match[0] });
    }
  }

  // 6. search_files — use [^>]* instead of [\s\S]*? to prevent catastrophic backtracking
  const searchFilesRegex = /<search_files\s+([^>]*)\/?>/gi;
  while ((match = searchFilesRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.pattern) {
      toolCalls.push({ name: "search_files", args: { path: attrs.path, pattern: attrs.pattern, glob: attrs.glob, regex: attrs.regex, max_results: attrs.max_results }, raw: match[0] });
    }
  }

  // 7. run_command — handle both self-closing and closing tags
  const runCommandRegex = /<run_command\s+command="([^"]*)"\s*\/?>/gi;
  const runCommandRegex2 = /<run_command\s+command='([^']*)'\s*\/?>/gi;
  while ((match = runCommandRegex.exec(text)) !== null) {
    toolCalls.push({ name: "run_command", args: { command: match[1] }, raw: match[0] });
  }
  while ((match = runCommandRegex2.exec(text)) !== null) {
    toolCalls.push({ name: "run_command", args: { command: match[1] }, raw: match[0] });
  }

  // 6. git_status — handle both self-closing and closing tags
  const gitStatusRegex = /<git_status\s*\/?>/gi;
  while ((match = gitStatusRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_status", args: {}, raw: match[0] });
  }

  // 7. git_commit — handle both self-closing and closing tags
  const gitCommitRegex = /<git_commit\s+message=["']([^"']+)["']\s*\/?>/gi;
  while ((match = gitCommitRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_commit", args: { message: match[1] }, raw: match[0] });
  }

  // 8. git_log — handle both self-closing and closing tags
  const gitLogRegex = /<git_log\s*\/?>/gi;
  while ((match = gitLogRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_log", args: {}, raw: match[0] });
  }

  // 9. clipboard_read — handle both self-closing and closing tags
  const clipboardReadRegex = /<clipboard_read\s*\/?>/gi;
  while ((match = clipboardReadRegex.exec(text)) !== null) {
    toolCalls.push({ name: "clipboard_read", args: {}, raw: match[0] });
  }

  // 10. clipboard_write
  const clipboardWriteRegex = /<clipboard_write>([\s\S]*?)<\/clipboard_write>/gi;
  while ((match = clipboardWriteRegex.exec(text)) !== null) {
    toolCalls.push({ name: "clipboard_write", args: { text: match[1] }, raw: match[0] });
  }

  // 11. notify — use [^>]* to prevent catastrophic backtracking
  const notifyRegex = /<notify\s+([^>]*)\/?>/gi;
  while ((match = notifyRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.title) {
      toolCalls.push({ name: "notify", args: { title: attrs.title, body: attrs.body ?? "" }, raw: match[0] });
    }
  }

  // 12. system_info
  const systemInfoRegex = /<system_info\s*\/>/gi;
  while ((match = systemInfoRegex.exec(text)) !== null) {
    toolCalls.push({ name: "system_info", args: {}, raw: match[0] });
  }

  // 13. open_url — use [^>]* to prevent catastrophic backtracking
  const openUrlRegex = /<open_url\s+([^>]*)\/?>/gi;
  while ((match = openUrlRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.url) {
      toolCalls.push({ name: "open_url", args: { url: attrs.url }, raw: match[0] });
    }
  }

  // 14. launch_app — use [^>]* to prevent catastrophic backtracking
  const launchAppRegex = /<launch_app\s+([^>]*)\/?>/gi;
  while ((match = launchAppRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.name) {
      toolCalls.push({ name: "launch_app", args: { name: attrs.name, args: attrs.args, cwd: attrs.cwd }, raw: match[0] });
    }
  }

  // 15. reveal_in_finder — use [^>]* to prevent catastrophic backtracking
  const revealRegex = /<reveal_in_finder\s+([^>]*)\/?>/gi;
  while ((match = revealRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.path) {
      toolCalls.push({ name: "reveal_in_finder", args: { path: attrs.path }, raw: match[0] });
    }
  }

  // 16. memory_save
  const memorySaveRegex = /<memory_save\s+([\s\S]*?)>([\s\S]*?)<\/memory_save>/gi;
  while ((match = memorySaveRegex.exec(text)) !== null) {
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

  // 17. memory_search — use [^>]* to prevent catastrophic backtracking
  const memorySearchRegex = /<memory_search\s+([^>]*)\/?>/gi;
  while ((match = memorySearchRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.query) {
      toolCalls.push({
        name: "memory_search",
        args: { query: attrs.query, category: attrs.category, limit: attrs.limit },
        raw: match[0],
      });
    }
  }

  // 18. memory_delete
  const memoryDeleteRegex = /<memory_delete\s+([\s\S]*?)\/?>/gi;
  while ((match = memoryDeleteRegex.exec(text)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (attrs.id) {
      toolCalls.push({
        name: "memory_delete",
        args: { id: attrs.id },
        raw: match[0],
      });
    }
  }

  // 19. memory_stats — handle both self-closing and closing tags
  const memoryStatsRegex = /<memory_stats\s*\/?>/gi;
  while ((match = memoryStatsRegex.exec(text)) !== null) {
    toolCalls.push({ name: "memory_stats", args: {}, raw: match[0] });
  }

  // 20. memory_maintain — handle both self-closing and closing tags
  const memoryMaintainRegex = /<memory_maintain\s*\/?>/gi;
  while ((match = memoryMaintainRegex.exec(text)) !== null) {
    toolCalls.push({ name: "memory_maintain", args: {}, raw: match[0] });
  }

  // 21. memory_extract — handle both self-closing and closing tags
  const memoryExtractRegex = /<memory_extract\s*\/?>/gi;
  while ((match = memoryExtractRegex.exec(text)) !== null) {
    toolCalls.push({ name: "memory_extract", args: {}, raw: match[0] });
  }

  // 22. memory_export — handle both self-closing and closing tags
  const memoryExportRegex = /<memory_export\s*\/?>/gi;
  while ((match = memoryExportRegex.exec(text)) !== null) {
    toolCalls.push({ name: "memory_export", args: {}, raw: match[0] });
  }

  // 23. memory_import — handle both self-closing and closing tags
  const memoryImportRegex = /<memory_import\s*\/?>/gi;
  while ((match = memoryImportRegex.exec(text)) !== null) {
    toolCalls.push({ name: "memory_import", args: {}, raw: match[0] });
  }

  // 24. Generic MCP Tool calls
  // Server names may contain underscores, so we match the full mcp_ prefix + greedy body
  // and later split against known MCP server names
  const mcpTagRegex = /<mcp_([\w-]+(?:_[\w-]+)*)\s*([\s\S]*?)\s*(\/?)>/gi;
  // Hoisted dynamic import to avoid repeating per match
  let mcpServers: { name: string; enabled: boolean; transport?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }[] = [];
  try {
    const { useSkillsMcp } = await import("../store/useAppStore");
    mcpServers = useSkillsMcp.getState().mcpServers;
  } catch { /* MCP store not available, skip server lookup */ }
  let mcpMatch;
  while ((mcpMatch = mcpTagRegex.exec(text)) !== null) {
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
        mcpTagRegex.lastIndex = mcpMatch.index + fullBlock.length;
      }
    }
  }

  return toolCalls;
}

function waitForToolApproval(toolCallId: string, abortSignal?: AbortSignal): Promise<"approved" | "denied"> {
  const TIMEOUT_MS = 120_000; // 2 minutes — give users time to review tool proposals
  _debugLog(`waitForToolApproval: waiting for tool ${toolCallId}`);
  return new Promise((resolve) => {
    let resolved = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;
    let useChatRef: ChatStoreRef | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      unsubscribe?.();
      if (abortHandler && abortSignal) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    };

    const check = () => {
      if (resolved || !useChatRef) return;
      try {
        const { pendingToolCalls } = useChatRef.getState();
        const tc = pendingToolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        _debugLog(`waitForToolApproval: check tool ${toolCallId}, status=${tc.status}`);
        if (tc.status === "completed") {
          resolved = true;
          cleanup();
          resolve("approved");
          return;
        }
        if (tc.status === "failed") {
          resolved = true;
          cleanup();
          resolve("denied");
          return;
        }
      } catch (err) {
        console.error("Error checking tool approval:", err);
      }
    };

    // Listen for abort signal to resolve immediately
    if (abortSignal) {
      abortHandler = () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve("denied");
        }
      };
      if (abortSignal.aborted) {
        resolved = true;
        cleanup();
        resolve("denied");
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        // Update the tool call status in the store so the UI doesn't stay stuck
        if (useChatRef) {
          try { useChatRef.getState().resolveToolApproval(toolCallId, "denied"); } catch (_e) { /* ignore */ }
        }
        _debugLog(`waitForToolApproval: timed out after ${TIMEOUT_MS}ms for tool ${toolCallId}`);
        resolve("denied");
      }
    }, TIMEOUT_MS);

    import("../store/useAppStore").then(({ useChat }) => {
      useChatRef = useChat;
      // Initial check
      check();
      if (resolved) return;
      // Subscribe to store changes — only re-check when pendingToolCalls actually changes
      let lastToolCalls = useChatRef!.getState().pendingToolCalls;
      unsubscribe = useChat.subscribe(() => {
        if (resolved) return;
        const current = useChatRef!.getState().pendingToolCalls;
        if (current !== lastToolCalls) {
          lastToolCalls = current;
          check();
        }
      });
    }).catch((err) => {
      console.error("Failed to import useAppStore for tool approval:", err);
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve("denied");
      }
    });
  });
}

async function executeTool(name: string, args: Record<string, any>, workspacePath: string, emit: (event: StreamEvent) => void, autoApprove = false): Promise<string> {
  // Validate args against Zod schema
  const { validateToolArgs } = await import("./toolSchemas");
  const validation = validateToolArgs(name, args);
  if (!validation.valid) {
    return `Error: ${validation.error}`;
  }

  if (name === "read_file") {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const MAX_READ_SIZE = 1024 * 1024; // 1MB limit for agent reads
    try {
      const fileInfo = await stat(args.path);
      const fileSize = (fileInfo as any).size ?? 0;
      if (fileSize > MAX_READ_SIZE) {
        return `[File too large to read: ${fileSize} bytes. Use list_dir or run_command with head/tail to inspect portions.]`;
      }
    } catch { /* stat may fail for some fs, proceed with read */ }
    const bytes = await readFile(args.path);
    const ext = args.path.split(".").pop()?.toLowerCase() ?? "";
    const textExts = new Set(["ts", "tsx", "js", "jsx", "json", "md", "mdx", "py", "rs", "css", "html", "yml", "yaml", "toml", "txt", "csv", "xml", "svg", "sh", "bash", "zsh", "fish", "sql", "graphql", "prisma", "env", "gitignore", "dockerignore", "editorconfig", "prettierrc", "eslintrc", "lock", "log", "cfg", "ini", "conf"]);
    if (textExts.has(ext) || ext === "") {
      return new TextDecoder().decode(bytes);
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (decoded.includes("\0") || (decoded.match(/\uFFFD/g)?.length ?? 0) > bytes.length * 0.01) {
      return `[Binary file: ${args.path.split("/").pop()} — ${bytes.length} bytes]`;
    }
    return decoded;
  }

  if (name === "write_file") {
    if (typeof args.content !== "string") {
      return "Error: write_file requires a 'content' argument (string)";
    }
    const { writeFile, readFile: fsReadFile } = await import("@tauri-apps/plugin-fs");
    let oldContent = "";
    try {
      const existingBytes = await fsReadFile(args.path);
      oldContent = new TextDecoder().decode(existingBytes);
    } catch { /* new file */ }
    const newContent = args.content;

    // When auto-approved (permission already granted), write directly without diff proposal
    if (autoApprove) {
      await writeFile(args.path, new TextEncoder().encode(newContent));
      const oldLines = oldContent.split("\n");
      const newLinesArr = newContent.split("\n");
      const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
      for (const line of oldLines) { diffLines.push({ type: "remove", content: line }); }
      for (const line of newLinesArr) { diffLines.push({ type: "add", content: line }); }
      const hunks = [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLinesArr.length, lines: diffLines }];
      emit({ type: "diff-proposed", proposal: { diffId: "auto-" + Math.random().toString(36).slice(2, 9), filePath: args.path, oldContent, newContent, hunks, createdAt: Date.now() } });
      return `Wrote ${args.path} (${newContent.length} bytes)`;
    }

    // Otherwise create diff proposal for user approval
    const diffId = "diff-" + Math.random().toString(36).slice(2, 9);
    const oldLines = oldContent.split("\n");
    const newLinesArr = newContent.split("\n");
    const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
    for (const line of oldLines) {
      diffLines.push({ type: "remove", content: line });
    }
    for (const line of newLinesArr) {
      diffLines.push({ type: "add", content: line });
    }
    const hunks = [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLinesArr.length, lines: diffLines }];
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
    const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(args.path);
    const original = new TextDecoder().decode(bytes);
    if (!original.includes(args.search)) {
      throw new Error(`Search block not found in file: ${args.path}`);
    }
    const updated = args.search
      ? original.split(args.search).join(args.replace)
      : original;

    // When auto-approved (permission already granted), write directly without diff proposal
    if (autoApprove) {
      await writeFile(args.path, new TextEncoder().encode(updated));
      const oldLines = args.search.split("\n");
      const newLines = args.replace.split("\n");
      const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
      for (const line of oldLines) { diffLines.push({ type: "remove", content: line }); }
      for (const line of newLines) { diffLines.push({ type: "add", content: line }); }
      const searchIdx = original.indexOf(args.search);
      const searchLine = searchIdx >= 0 ? original.substring(0, searchIdx).split("\n").length : 1;
      const hunks = [{ oldStart: searchLine, oldLines: oldLines.length, newStart: searchLine, newLines: newLines.length, lines: diffLines }];
      emit({ type: "diff-proposed", proposal: { diffId: "auto-" + Math.random().toString(36).slice(2, 9), filePath: args.path, oldContent: original, newContent: updated, hunks, createdAt: Date.now() } });
      return `Edited ${args.path} (${oldLines.length} → ${newLines.length} lines)`;
    }

    // Otherwise create diff proposal for user approval
    const diffId = "diff-" + Math.random().toString(36).slice(2, 9);
    const oldLines = args.search.split("\n");
    const newLines = args.replace.split("\n");
    const diffLines: Array<{ type: "remove" | "add"; content: string }> = [];
    for (const line of oldLines) {
      diffLines.push({ type: "remove", content: line });
    }
    for (const line of newLines) {
      diffLines.push({ type: "add", content: line });
    }
    const searchIdx = original.indexOf(args.search);
    const searchLine = searchIdx >= 0 ? original.substring(0, searchIdx).split("\n").length : 1;
    const hunks = [{ oldStart: searchLine, oldLines: oldLines.length, newStart: searchLine, newLines: newLines.length, lines: diffLines }];
    const proposal: DiffProposal = { diffId, filePath: args.path, oldContent: original, newContent: updated, hunks, createdAt: Date.now() };
    pendingDiffProposals.set(diffId, proposal);
    emit({ type: "diff-proposed", proposal });
    // File is written only when the diff is approved via approveDiff()
    return `File edit proposed: ${args.path} (awaiting approval)`;
  }

  if (name === "list_dir") {
    const nodes = await dalamAPI.fs.listDir(args.path);
    return JSON.stringify(nodes.map(n => ({ name: n.name, path: n.path, type: n.type })), null, 2);
  }

  if (name === "grep_file") {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    try {
      const fileInfo = await stat(args.path);
      const fileSize = (fileInfo as any).size ?? 0;
      if (fileSize > 5 * 1024 * 1024) {
        return `[File too large to grep: ${(fileSize / 1024 / 1024).toFixed(1)}MB. Use run_command with grep instead.]`;
      }
    } catch { /* stat may fail, proceed with read */ }
    const bytes = await readFile(args.path);
    const content = new TextDecoder().decode(bytes);
    const lines = content.split("\n");
    const pattern = args.pattern;
    const isRegex = args.regex === "true";
    const maxResults = args.max_results ? parseInt(args.max_results, 10) : 50;
    const matches: { line: number; text: string }[] = [];
    try {
      const re = isRegex ? new RegExp(pattern, "i") : null;
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        const line = lines[i];
        if (re ? re.test(line) : line.includes(pattern)) {
          matches.push({ line: i + 1, text: line.trim() });
        }
      }
    } catch {
      return "Error: Invalid regex pattern";
    }
    if (matches.length === 0) return `No matches found for "${pattern}" in ${args.path}`;
    return matches.map(m => `${m.line}: ${m.text}`).join("\n");
  }

  if (name === "search_files") {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const searchPath = args.path || workspacePath;
    const pattern = args.pattern;
    const fileGlob = args.glob || "*";
    const maxResults = args.max_results ? parseInt(args.max_results, 10) : 100;
    const isRegex = args.regex === "true";
    const results: { file: string; line: number; text: string }[] = [];
    let re: RegExp | null = null;
    try {
      re = isRegex ? new RegExp(pattern, "i") : null;
    } catch {
      return "Error: Invalid regex pattern";
    }
    const globRegex = new RegExp(
      "^" + fileGlob
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
      try { entries = await rd(dir); } catch { return; }
      for (const entry of entries) {
        if (!entry.name || results.length >= maxResults) break;
        if (JUNK_DIRS.has(entry.name)) continue;
        const full = joinPath(dir, entry.name!);
        if (entry.isDirectory) {
          await searchDir(full, depth + 1, visited);
        } else {
          if (!globRegex.test(entry.name)) continue;
          const relPath = full.startsWith(searchPath) ? full.slice(searchPath.length + 1) : full;
          if (!globRegex.test(relPath) && !globRegex.test(entry.name)) continue;
          // Skip binary files
          const ext = entry.name?.split(".").pop()?.toLowerCase() ?? "";
          const binaryExts = new Set(["png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "mp3", "mp4", "avi", "mov", "pdf", "zip", "tar", "gz", "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite"]);
          if (binaryExts.has(ext)) continue;
          try {
            const bytes = await readFile(full);
            const content = new TextDecoder().decode(bytes);
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const match = re ? re.test(lines[i]) : lines[i].includes(pattern);
              if (match) {
                results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
              }
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }
    await searchDir(searchPath, 0);
    if (results.length === 0) return `No matches found for "${pattern}" in ${searchPath}`;
    return results.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n");
  }

  if (name === "run_command") {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const isWindows = typeof window !== "undefined" && window.navigator.userAgent.includes("Windows");
    const program = isWindows ? "powershell" : "bash";
    const commandArgs = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", args.command] : ["-c", args.command];
    const cmd = Command.create(program, commandArgs, { cwd: workspacePath });
    const child = await cmd.spawn();
    let killed = false;
    const timeoutMs = 60_000;
    const output = await Promise.race([
      new Promise<string>((resolve) => {
        let stdout = "";
        let stderr = "";
        cmd.stdout.on("data", (data: string) => { if (!killed) stdout += data; });
        cmd.stderr.on("data", (data: string) => { if (!killed) stderr += data; });
        cmd.on("close", () => { resolve(stdout + (stderr ? "\n" + stderr : "")); });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          killed = true;
          child.kill().catch(() => {});
          reject(new Error(`Command timed out after ${timeoutMs/1000}s`));
        }, timeoutMs)
      ),
    ]);

    const maxLen = 50000;
    if (output.length > maxLen) {
      return output.slice(0, maxLen) + `\n\n[Output truncated at ${Math.round(maxLen/1024)}KB — total was ${Math.round(output.length/1024)}KB. Use head/tail to inspect portions.]`;
    }
    return output;
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
    const appArgs = args.args ? args.args.split(/\s+/).filter(Boolean) : undefined;
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
    const result = await saveMemory(
      {
        category: args.category as any || "project",
        tier: args.tier as any || "medium",
        summary: args.summary || args.content.slice(0, 150),
        content: args.content,
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
      category: args.category as any || undefined,
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
    } catch {
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
      const resp = await fetchJsonWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, 2, 1000);
      return isAnthropic ? (resp.content?.[0]?.text || "") : (resp.choices?.[0]?.message?.content || "");
    };

    // Get last exchange from session messages
    const { useChat, useWorkspace } = await import("../store/useAppStore");
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
    throw new Error("get_env tool is not yet implemented");
  }
  if (name === "get_screen_info") {
    throw new Error("get_screen_info tool is not yet implemented");
  }
  if (name === "list_processes") {
    throw new Error("list_processes tool is not yet implemented");
  }
  if (name === "kill_process") {
    throw new Error("kill_process tool is not yet implemented");
  }
  if (name === "get_disk_space") {
    throw new Error("get_disk_space tool is not yet implemented");
  }

  if (name.startsWith("mcp_")) {
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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const existingSessionId = mcpHttpSessions.get(serverName);
      if (existingSessionId) {
        headers["Mcp-Session-Id"] = existingSessionId;
      } else {
        const initResp = await corsFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Dalam", version: "1.0.0" } }, id: 1 }),
        });
        if (!initResp.ok) throw new Error(`HTTP ${initResp.status} during MCP initialize`);
        const initJson = await initResp.json();
        if (initJson.error) throw new Error(initJson.error.message || JSON.stringify(initJson.error));
        const sessionId = initResp.headers.get("mcp-session-id");
        if (sessionId) {
          headers["Mcp-Session-Id"] = sessionId;
          mcpHttpSessions.set(serverName, sessionId);
        }
        await corsFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        });
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
            arguments: args,
          },
          id: 2,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} calling MCP tool`);
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
      try {
        const { Command } = await import("@tauri-apps/plugin-shell");
        const cmd = Command.create(command, server.args ?? [], { env: server.env });

        // eslint-disable-next-line no-async-promise-executor -- needed for sequential async operations in promise
        const resultPromise = new Promise<string>(async (resolve, reject) => {
          let outputBuffer = "";
          let resolved = false;

          cmd.stdout.on("data", (data: string) => {
            outputBuffer += data;
            // NDJSON: split on newlines, parse each complete line
            const lines = outputBuffer.split("\n");
            // Keep the last incomplete line in the buffer
            outputBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("{")) continue;
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.result?.content || parsed.content || parsed.error) {
                  resolved = true;
                  if (parsed.error) {
                    reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                  } else if (!parsed || typeof parsed !== "object" || (!("result" in parsed) && !("content" in parsed))) {
                    resolve(`[MCP Error: Invalid response format from server "${serverName}"]`);
                  } else {
                    const content = parsed.result?.content || parsed.content || [];
                    const text = content.map((c: AnthropicContentBlock) => c.text || JSON.stringify(c)).join("\n");
                    resolve(text);
                  }
                  return;
                }
              } catch {
                // Not valid JSON — skip this line
              }
            }
          });

          cmd.stderr.on("data", (data: string) => {
            console.warn("MCP Stderr:", data);
          });

          const child = await cmd.spawn();
          const initReq = JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Dalam", version: "1.0.0" } },
            id: 1,
          }) + "\n";
          await child.write(initReq);
          const initNotif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n";
          await child.write(initNotif);
          const req = JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              name: toolName,
              arguments: args,
            },
            id: 2,
          }) + "\n";
          await child.write(req);

          setTimeout(() => {
            if (!resolved) {
              child.kill().catch(() => { });
              reject(new Error("Timeout waiting for tools/call response (30s)"));
            }
          }, 30000);
        });

        return await resultPromise;
      } catch (err) {
        const errMsg = (err as Error)?.message ?? String(err);
        throw new Error(`MCP tool "${toolName}" on server "${serverName}" failed: ${errMsg}`, { cause: err });
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}
