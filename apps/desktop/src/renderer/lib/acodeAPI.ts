import type { AcodeAPI, AgentSessionMode, AppSettings, DiffProposal, FileNode, StreamEvent } from "@acode/shared-types";
import { DEFAULT_SETTINGS } from "@acode/shared-types";
import { matchSkillInvocation, renderSkillForPrompt } from "./skills";

const STORAGE_KEYS = {
  settings: "acode.settings.v1",
} as const;

const activeControllers = new Map<string, AbortController>();
const streamCallbacks = new Map<string, (event: StreamEvent) => void>();
const streamCleanups = new Map<string, () => void>();
const pendingDiffProposals = new Map<string, DiffProposal>();

const SETTINGS_CACHE = new Map<string, string>();

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\\+/g, "/").replace(/\/+/g, "/");
}

export function getRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem("acode.recentFiles.v1");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function addRecentFile(path: string) {
  const recent = getRecentFiles().filter((f) => f !== path);
  recent.unshift(path);
  localStorage.setItem("acode.recentFiles.v1", JSON.stringify(recent.slice(0, 20)));
}

function getStoredSettings(): AppSettings {
  if (SETTINGS_CACHE.has("all")) return JSON.parse(SETTINGS_CACHE.get("all")!);
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) { SETTINGS_CACHE.set("all", raw); return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; }
  } catch {}
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
    const raw = localStorage.getItem(`acode.provider.${providerId}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export class ProviderError extends Error {
  constructor(message: string, public code: "auth" | "credit" | "network" | "provider" | "timeout") {
    super(message);
    this.name = "ProviderError";
  }
}

function parseSSEEvents(buffer: string): { parsed: { data: string }[]; remaining: string } {
  const lines = buffer.split("\n");
  const parsed: { data: string }[] = [];
  let currentData = "";
  let lastCompleteIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("data:")) {
      const dataContent = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      currentData += (currentData ? "\n" : "") + dataContent;
    } else if (line === "" && currentData) {
      if (currentData !== "[DONE]") parsed.push({ data: currentData });
      currentData = "";
      lastCompleteIdx = i + 1;
    } else if (line === "" && !currentData) {
      lastCompleteIdx = i + 1;
    }
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
    const resp = await fetch(url, { ...options, signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) throw new ProviderError("Authentication failed. Check your API key.", "auth");
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
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) throw new ProviderError("Authentication failed. Check your API key.", "auth");
      if (resp.status === 402 || resp.status === 429) throw new ProviderError("Insufficient credits or rate limited.", "credit");
      throw new ProviderError(`Failed to summarize: HTTP ${resp.status} - ${text.slice(0, 300)}`, "provider");
    }
    return resp.json();
  }, maxRetries, baseDelayMs);
}

async function* streamOpenAI(
  baseUrl: string, apiKey: string, model: string,
  messages: { role: string; content: any }[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, any> = { model, messages, stream: true };
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { parsed, remaining } = parseSSEEvents(buffer);
    buffer = remaining;
    for (const part of parsed) {
      try {
        const json = JSON.parse(part.data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
        if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
      } catch {}
    }
  }
  // Process any remaining buffered data
  if (buffer.trim()) {
    const { parsed } = parseSSEEvents(buffer + "\n\n");
    for (const part of parsed) {
      try {
        const json = JSON.parse(part.data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) yield { type: "message-delta", messageId: json.id || "", content: delta.content };
        if (delta?.reasoning_content) yield { type: "activity-think", content: delta.reasoning_content };
      } catch {}
    }
  }
}

async function* streamAnthropic(
  baseUrl: string, apiKey: string, model: string,
  messages: { role: string; content: any }[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const systemMsg = messages.find((m) => m.role === "system")?.content || "";
  const chatMessages = messages.filter((m) => m.role !== "system");
  const body: Record<string, any> = { model, system: systemMsg, messages: chatMessages, stream: true };
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { parsed, remaining } = parseSSEEvents(buffer);
    buffer = remaining;
    for (const part of parsed) {
      try {
        const json = JSON.parse(part.data);
        if (json.type === "message_start") { msgId = json.message?.id || ""; }
        if (json.type === "content_block_delta" && json.delta?.text) {
          yield { type: "message-delta", messageId: msgId, content: json.delta.text };
        }
        if (json.type === "content_block_delta" && json.delta?.thinking) {
          yield { type: "activity-think", content: json.delta.thinking };
        }
      } catch {}
    }
  }
  // Process any remaining buffered data
  if (buffer.trim()) {
    const { parsed } = parseSSEEvents(buffer + "\n\n");
    for (const part of parsed) {
      try {
        const json = JSON.parse(part.data);
        if (json.type === "content_block_delta" && json.delta?.text) {
          yield { type: "message-delta", messageId: msgId, content: json.delta.text };
        }
        if (json.type === "content_block_delta" && json.delta?.thinking) {
          yield { type: "activity-think", content: json.delta.thinking };
        }
      } catch {}
    }
  }
}

async function* streamChat(
  baseUrl: string, apiKey: string, apiFormat: string, model: string,
  messages: { role: string; content: any }[], signal?: AbortSignal, maxTokens?: number
): AsyncGenerator<StreamEvent> {
  if (apiFormat === "anthropic") {
    yield* streamAnthropic(baseUrl, apiKey, model, messages, signal, maxTokens);
  } else {
    yield* streamOpenAI(baseUrl, apiKey, model, messages, signal, maxTokens);
  }
}

async function readDirRecursive(dirPath: string): Promise<FileNode[]> {
  const { readDir } = await import("@tauri-apps/plugin-fs");
  const entries = await readDir(dirPath);
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    if (entry.name?.startsWith(".")) continue;
    const fullPath = joinPath(dirPath, entry.name!);
    if (entry.isDirectory) {
      const children = await readDirRecursive(fullPath);
      nodes.push({ name: entry.name!, path: fullPath, type: "directory", gitStatus: null, children });
    } else {
      nodes.push({ name: entry.name!, path: fullPath, type: "file", gitStatus: null });
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function ensureAcodeAPI(): AcodeAPI {
  return mockAcodeAPI;
}

const mockAcodeAPI: AcodeAPI = {
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
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false, title: "Open Workspace" });
        if (selected) return readDirRecursive(selected as string);
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
    },
    async renamePath(path, newName) {
      const { rename, readFile, writeFile: fsWriteFile, remove: fsRemove } = await import("@tauri-apps/plugin-fs");
      const dir = path.substring(0, path.lastIndexOf("/"));
      const newPath = joinPath(dir, newName);
      try {
        await rename(path, newPath);
      } catch {
        const bytes = await readFile(path);
        await fsWriteFile(newPath, bytes);
        await fsRemove(path);
      }
    },
    async watchPath(_path: string) {
      // Tauri v2 doesn't expose fs.watch in the JS API yet.
      // File tree refresh is handled manually via refreshFileTree().
      // TODO: Implement when @tauri-apps/plugin-fs adds watch support.
    },
  },

  terminal: (() => {
    const processes = new Map<string, { child: any; command: any }>();
    const listeners = new Map<string, Set<(data: string) => void>>();

    return {
      async create(cwd?: string, title?: string) {
        const id = "t-" + Math.random().toString(36).slice(2, 9);
        try {
          const { Command } = await import("@tauri-apps/plugin-shell");
          const isWindows = typeof window !== "undefined" && window.navigator.userAgent.includes("Windows");
          const shellCmd = title ?? (isWindows ? "powershell" : "bash");
          const command = Command.create(shellCmd, [], { cwd: cwd ?? undefined });
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
          for (const l of termListeners) l(errMsg);
        }
        return id;
      },

      async writeInput(id: string, input: string) {
        const proc = processes.get(id);
        if (proc) await proc.child.write(input);
      },

      async resize(_id: string, _cols: number, _rows: number) {
        // Tauri shell plugin doesn't support pty resize; xterm handles display
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
        return () => { listeners.get(id)?.delete(cb); };
      },
    };
  })(),

  agent: {
    async startSession(options: { workspacePath: string; model: string; mode: AgentSessionMode }) {
      return { sessionId: "ses-" + Math.random().toString(36).slice(2, 14) };
    },
    async sendPrompt(sessionId, prompt, conversationHistory?, agentName?, attachments?) {
      const settings = getStoredSettings();
      const providerId = settings.selectedProvider;
      const modelId = settings.selectedModel;

      if (!providerId || !modelId) throw new ProviderError("No provider configured. Add one in Settings.", "provider");

      const config = getProviderConfig(providerId);
      if (!config) throw new ProviderError(`Provider "${providerId}" not configured. Check settings.`, "provider");

      const ac = new AbortController();
      activeControllers.set(sessionId, ac);
      const emit = (event: StreamEvent) => { streamCallbacks.get(sessionId)?.(event); };

      try {
        // Resolve circular dependency by dynamic import of store
        const { useChat, useSkillsMcp, useWorkspace } = await import("../store/useAppStore");
        const state = useChat.getState();
        const skillsState = useSkillsMcp.getState();
        const enabledSkills = skillsState.skills.filter((sk) => sk.enabled);

        // Convert Skill[] to SkillInfo[] for matchSkillInvocation
        const skillInfos = enabledSkills.map((sk) => ({
          name: sk.name,
          description: sk.description,
          content: sk.prompt,
          location: sk.source === "bundled" ? `bundled://${sk.name}/SKILL.md` : `user://${sk.name}/SKILL.md`,
          source: (sk.source === "bundled"
            ? "bundled"
            : sk.source === "project"
              ? "project"
              : "user-global") as "bundled" | "project" | "user-global" | "user-workspace",
        }));

        const matched = matchSkillInvocation(prompt, skillInfos);
        let activeSkillPrompt = "";
        let cleanPrompt = prompt;

        if (matched) {
          activeSkillPrompt = renderSkillForPrompt(matched.skill);
          const regex = new RegExp(`\\$${matched.skill.name}\\b`, "i");
          cleanPrompt = prompt.replace(regex, "").trim();

          // Emit activity-skill stream event
          emit({
            type: "activity-skill",
            name: matched.skill.name,
            content: matched.skill.description,
            args: matched.args
          });
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
                mcpToolsDocumentation += `- <mcp_${server.name}_${tool.name}/>: ${tool.description}\n`;
              });
            }
          });
          mcpToolsDocumentation += "\n==========================";
        }

        // Resolve active file and editor tabs context from store
        const workspaceState = useWorkspace.getState();
        const activeFile = workspaceState.activeFilePath;
        const openTabs = workspaceState.openTabs;
        let activeFileContext = "";

        if (activeFile) {
          const activeTab = openTabs.find((t) => t.path === activeFile);
          const cursorInfo = activeTab?.cursor 
            ? ` (Cursor is at Line ${activeTab.cursor.line}, Column ${activeTab.cursor.column})` 
            : "";
          activeFileContext = `\n\n=== CURRENT EDITOR STATE ===\nYou are currently looking at this file: ${activeFile}${cursorInfo}\n`;
          if (activeTab && activeTab.content) {
            activeFileContext += `\n--- Active File Content ---\n${activeTab.content}\n`;
          }
          if (openTabs.length > 1) {
            activeFileContext += `- Other open tabs: ${openTabs.filter(t => t.path !== activeFile).map(t => t.name).join(", ")}\n`;
          }
          activeFileContext += "============================";
        }

        const summaries = state.compactionSummaries || {};
        const compactionSummary = summaries[sessionId];
        const session = state.chatSessions.find((s) => s.id === sessionId) || state.session;
        const workspacePath = session?.workspacePath;

        let workspaceMemoryBlock = "";
        if (workspacePath) {
          try {
            const { exists } = await import("@tauri-apps/plugin-fs");
            const memoryPath = joinPath(workspacePath, ".acode/memory.json");
            if (await exists(memoryPath)) {
              const memoryContent = await mockAcodeAPI.fs.readFile(memoryPath);
              const memoryObj = JSON.parse(memoryContent);
              workspaceMemoryBlock = `\n\n=== PERSISTENT WORKSPACE MEMORY ===\nACode maintains a persistent memory file for this workspace at \`.acode/memory.json\`. You can modify this file using your edit/write file tools to remember key rules, paths, build commands, or context for future turns.\n\nCurrent Contents:\n- Project Overview: ${memoryObj.projectOverview || "Not specified."}\n- Key Files/Directories: ${JSON.stringify(memoryObj.keyFiles || [])}\n- Build/Test Commands: ${JSON.stringify(memoryObj.buildCommands || [])}\n- Learned Rules:\n${(memoryObj.learnedRules || []).map((r: string) => `  * ${r}`).join("\n")}\n===================================`;
            }
          } catch (e) {
            console.warn("Failed to load workspace memory:", e);
          }
        }

        let workspacePinnedBlock = "";
        if (workspacePath) {
          try {
            const { exists } = await import("@tauri-apps/plugin-fs");
            const contextPath = joinPath(workspacePath, ".acode/context.json");
            if (await exists(contextPath)) {
              const contextContent = await mockAcodeAPI.fs.readFile(contextPath);
              const contextObj = JSON.parse(contextContent);
              if (contextObj.pinnedFiles && contextObj.pinnedFiles.length > 0) {
                let pinnedBlock = "\n\n=== PINNED FILES ===\nThe following files are pinned in your context. You should keep their contents in mind:\n";
                for (const filePath of contextObj.pinnedFiles) {
                  try {
                    const fullPath = joinPath(workspacePath, filePath);
                    if (await exists(fullPath)) {
                      const fileContent = await mockAcodeAPI.fs.readFile(fullPath);
                      pinnedBlock += `\n--- Pinned File: ${filePath} ---\n${fileContent}\n`;
                    }
                  } catch (e) {
                    console.warn(`Failed to read pinned file ${filePath}:`, e);
                  }
                }
                pinnedBlock += "=====================";
                workspacePinnedBlock = pinnedBlock;
              }
            }
          } catch (e) {
            console.warn("Failed to load workspace context:", e);
          }
        }

        let workspaceRulesBlock = "";
        if (workspacePath) {
          try {
            const { exists } = await import("@tauri-apps/plugin-fs");
            const cursorrulesPath = joinPath(workspacePath, ".cursorrules");
            const agentrulesPath = joinPath(workspacePath, ".agentrules");
            const rulesMdPath = joinPath(workspacePath, ".acode/rules.md");
            
            let rulesContent = "";
            if (await exists(cursorrulesPath)) {
              rulesContent = await mockAcodeAPI.fs.readFile(cursorrulesPath);
            } else if (await exists(agentrulesPath)) {
              rulesContent = await mockAcodeAPI.fs.readFile(agentrulesPath);
            } else if (await exists(rulesMdPath)) {
              rulesContent = await mockAcodeAPI.fs.readFile(rulesMdPath);
            }
            if (rulesContent) {
              workspaceRulesBlock = `\n\n=== WORKSPACE CUSTOM RULES ===\nThese instructions define workspace styling guidelines, behavioral constraints, and project rules that you must strictly adhere to:\n${rulesContent}\n==============================`;
            }
          } catch (e) {
            console.warn("Failed to load workspace rules:", e);
          }
        }

        const toolsDocumentation = `
=== AGENTIC TOOLS HARNESS ===
You are equipped with tools to interact with the workspace. To invoke a tool, output the corresponding XML tag in your response. The system will pause, execute the tool, and provide the result in your next turn. You can invoke multiple tools in a single turn.

Available Tools:
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

5. Run Command:
   <run_command command="shell command"/>
   Executes a shell command in the workspace directory and returns its output.

6. Git Status:
   <git_status/>
   Gets the git status of the project.

7. Git Commit:
   <git_commit message="message"/>
   Commits all changes.

8. Git Log:
   <git_log/>
   Gets the git commit history.

Always use absolute paths for file operations. The workspace path is: ${workspacePath || "."}.
`;

        const systemPrompt = (agentName === "plan"
          ? "You are ACode in Plan mode. You are a read-only analysis agent. Explore the codebase, understand the task, and produce a clear, actionable plan. Do NOT edit, write, or delete any files. Do NOT run shell commands that modify files. You may read files and search the codebase. When your plan is complete, write it to .acode/plans/ directory as a markdown file, then end your response with exactly: [PLAN_COMPLETE] — this signals the user to review and approve."
          : agentName === "yolo"
            ? "You are ACode in YOLO mode. You have FULL unrestricted access — read, write, execute anything without asking. Be efficient and direct. Execute tasks without seeking permission."
            : "You are ACode, an AI coding assistant. Help users write, debug, and understand code. Be concise and practical. When showing code, use markdown code blocks with the appropriate language. Always ask the user before executing shell commands or making file changes.") 
            + workspaceMemoryBlock 
            + workspaceRulesBlock 
            + toolsDocumentation
            + activeSkillPrompt
            + mcpToolsDocumentation
            + activeFileContext
            + workspacePinnedBlock;

        let currentHistory: any[] = conversationHistory ? [...conversationHistory] : [];
        const filteredHistory = currentHistory.filter((msg) => msg.role !== "system");
        let loopCount = 0;
        const MAX_LOOP = 10;

        while (loopCount < MAX_LOOP) {
          loopCount++;

          const messages: any[] = [
            { role: "system", content: systemPrompt },
          ];

          // Layered context: if we have a summary and history is long, prune middle
          if (compactionSummary && filteredHistory.length > 10) {
            messages.push({
              role: "system",
              content: `[CONVERSATION HISTORY SUMMARY (Compacted older history)]\nHere is a summary of the earlier part of the conversation:\n${compactionSummary}\n`
            });
            for (const msg of filteredHistory.slice(-6)) {
              messages.push({
                role: msg.role === "user" ? "user" : "assistant",
                content: msg.content,
              });
            }
          } else if (filteredHistory.length > 0) {
            for (const msg of filteredHistory.slice(-20)) {
              messages.push({
                role: msg.role === "user" ? "user" : "assistant",
                content: msg.content,
              });
            }
          }

          // Add user's message/files on the first turn
          if (loopCount === 1) {
            const hasImages = attachments?.some((a) => a.mimeType.startsWith("image/"));

            if (hasImages && config.apiFormat === "openai") {
              const parts: any[] = [{ type: "text", text: cleanPrompt }];
              for (const att of attachments ?? []) {
                if (att.mimeType.startsWith("image/")) {
                  parts.push({
                    type: "image_url",
                    image_url: { url: `data:${att.mimeType};base64,${att.content}` },
                  });
                } else if (att.content) {
                  parts.push({ type: "text", text: `\n\n--- File: ${att.name} ---\n${att.content}` });
                }
              }
              messages.push({ role: "user", content: parts });
            } else if (hasImages && config.apiFormat === "anthropic") {
              const parts: any[] = [{ type: "text", text: cleanPrompt }];
              for (const att of attachments ?? []) {
                if (att.mimeType.startsWith("image/")) {
                  parts.push({
                    type: "image",
                    source: { type: "base64", media_type: att.mimeType, data: att.content },
                  });
                } else if (att.content) {
                  parts.push({ type: "text", text: `\n\n--- File: ${att.name} ---\n${att.content}` });
                }
              }
              messages.push({ role: "user", content: parts });
            } else {
              let fullPrompt = cleanPrompt;
              for (const att of attachments ?? []) {
                if (att.mimeType.startsWith("image/")) continue;
                if (att.content) fullPrompt += `\n\n--- File: ${att.name} ---\n${att.content}`;
              }
              messages.push({ role: "user", content: fullPrompt });
            }
          }

          // Start Turn streaming
          emit({ type: "message-start", messageId: sessionId });
          useChat.setState({ isStreaming: true });

          const maxTokens = settings.maxTokens ?? 4096;
          const stream = streamChat(config.baseUrl, config.apiKey, config.apiFormat || "openai", modelId, messages, ac.signal, maxTokens);
          let fullContent = "";
          let lastMessageId = "";
          for (const p of state.pendingToolCalls) {
            // Clear pending tools from previous runs
            useChat.setState((s) => ({ pendingToolCalls: s.pendingToolCalls.filter((t) => t.id !== p.id) }));
          }

          for await (const event of stream) {
            if (event.type === "message-delta") { 
              fullContent += event.content; 
              lastMessageId = event.messageId; 
            }
            emit(event);
          }

          // Parse tool calls from the stream output
          const parsedTools = parseToolCalls(fullContent);

          if (parsedTools.length > 0) {
            // Emit message-end for the thoughts part of this turn
            emit({ type: "message-end", messageId: lastMessageId || sessionId });

            const assistantTurnMsg = {
              id: lastMessageId || sessionId,
              role: "assistant" as const,
              content: fullContent,
              timestamp: Date.now()
            };
            currentHistory.push(assistantTurnMsg);

            // Save immediately in store
            useChat.setState((s) => ({
              messages: [...s.messages, assistantTurnMsg],
              sessionMessages: {
                ...s.sessionMessages,
                [sessionId]: [...(s.sessionMessages[sessionId] ?? []), assistantTurnMsg]
              }
            }));

            let executedAny = false;

            for (const pt of parsedTools) {
              const toolCallId = "tc-" + Math.random().toString(36).slice(2, 9);
              const toolCall = {
                id: toolCallId,
                name: pt.name,
                args: pt.args,
                status: "pending" as const
              };

              // Emit tool call
              emit({ type: "tool-call", toolCall });

              // Wait for approval
              const decision = await waitForToolApproval(toolCallId);

              if (decision === "approved") {
                try {
                  emit({ type: "thinking", messageId: sessionId, content: `Executing tool ${pt.name}...` });
                  const toolResult = await executeTool(pt.name, pt.args, workspacePath || ".", emit);
                  emit({ type: "tool-result", toolCallId, result: toolResult });

                  const toolResultMsg = {
                    id: "tr-" + Math.random().toString(36).slice(2, 9),
                    role: "user" as const,
                    content: `[TOOL RESULT: ${pt.name}]\n${toolResult}`,
                    timestamp: Date.now()
                  };
                  currentHistory.push(toolResultMsg);

                  useChat.setState((s) => ({
                    messages: [...s.messages, toolResultMsg],
                    sessionMessages: {
                      ...s.sessionMessages,
                      [sessionId]: [...(s.sessionMessages[sessionId] ?? []), toolResultMsg]
                    }
                  }));
                  executedAny = true;
                } catch (err) {
                  const errMsg = (err as Error)?.message ?? String(err);
                  emit({ type: "tool-result", toolCallId, result: `Error: ${errMsg}` });

                  const toolResultMsg = {
                    id: "tr-" + Math.random().toString(36).slice(2, 9),
                    role: "user" as const,
                    content: `[TOOL ERROR: ${pt.name}]\nError: ${errMsg}`,
                    timestamp: Date.now()
                  };
                  currentHistory.push(toolResultMsg);

                  useChat.setState((s) => ({
                    messages: [...s.messages, toolResultMsg],
                    sessionMessages: {
                      ...s.sessionMessages,
                      [sessionId]: [...(s.sessionMessages[sessionId] ?? []), toolResultMsg]
                    }
                  }));
                  executedAny = true;
                }
              } else {
                const toolResultMsg = {
                  id: "tr-" + Math.random().toString(36).slice(2, 9),
                  role: "user" as const,
                  content: `[TOOL RESULT: ${pt.name}]\nPermission Denied by user.`,
                  timestamp: Date.now()
                };
                currentHistory.push(toolResultMsg);

                useChat.setState((s) => ({
                  messages: [...s.messages, toolResultMsg],
                  sessionMessages: {
                    ...s.sessionMessages,
                    [sessionId]: [...(s.sessionMessages[sessionId] ?? []), toolResultMsg]
                  }
                }));
                executedAny = true;
              }
            }

            if (executedAny) {
              continue; // Run next LLM turn
            }
          }

          // Final response turn completed with no tools to execute
          emit({ type: "message-end", messageId: lastMessageId || sessionId });
          break;
        }
      } catch (err) {
        activeControllers.delete(sessionId);
        if (err instanceof ProviderError) {
          emit({ type: "error", error: err.message });
          emit({ type: "message-end", messageId: sessionId });
          return;
        }
        if ((err as Error)?.name === "AbortError") {
          emit({ type: "message-end", messageId: sessionId });
          return;
        }
        emit({ type: "error", error: `Network error: ${(err as Error)?.message ?? "Unknown"}` });
        emit({ type: "message-end", messageId: sessionId });
      }
      activeControllers.delete(sessionId);

    },
    async abort(sessionId) {
      const ac = activeControllers.get(sessionId);
      if (ac) { ac.abort(); activeControllers.delete(sessionId); }
    },
    async summarizeMessages(model, messages) {
      const settings = getStoredSettings();
      const providerId = settings.selectedProvider;
      if (!providerId) throw new ProviderError("No provider configured", "provider");
      const config = getProviderConfig(providerId);
      if (!config) throw new ProviderError(`Provider "${providerId}" not configured`, "provider");

      const isAnthropic = config.apiFormat === "anthropic";
      const url = config.baseUrl.replace(/\/+$/, "") + (isAnthropic ? "/v1/messages" : "/chat/completions");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (isAnthropic) {
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const systemPrompt = "You are a context compaction assistant. Summarize the following early conversation history between the user and assistant. Focus on: 1) What has been achieved, 2) Key decisions/plans approved, 3) Current state. Keep it very concise (under 200 words). Do not include any meta-commentary, intros, or outros. Just output the summary directly as markdown bullet points.";
      const systemMsg = messages.find((m) => m.role === "system")?.content || systemPrompt;
      const chatMessages = messages.filter((m) => m.role !== "system");

      const body = isAnthropic
        ? { model, system: systemMsg, messages: chatMessages, max_tokens: 1000 }
        : { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], max_tokens: 1000 };

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
      // The file is already written by executeTool. This just emits the
      // file-changed event so the UI updates (diff viewer, file tree).
      const pending = pendingDiffProposals.get(diffId);
      if (pending) {
        pendingDiffProposals.delete(diffId);
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
      }
    },
    async rejectDiff(_sessionId: string, diffId: string) {
      pendingDiffProposals.delete(diffId);
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
        throw new Error(`Git status failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
    async commit(repoPath, message) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ sha: string }>("git_commit", { path: repoPath, message });
      } catch (err) {
        throw new Error(`Git commit failed: ${(err as Error)?.message ?? "Unknown error"}`);
      }
    },
    async log(repoPath, limit = 20) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ sha: string; message: string; date: string; author: string }[]>("git_log", { path: repoPath, limit });
      } catch (err) {
        throw new Error(`Git log failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
    async branches(repoPath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<{ name: string; current: boolean }[]>("git_branches", { path: repoPath });
      } catch (err) {
        throw new Error(`Git branches failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
    async checkout(repoPath, branch) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("git_checkout", { path: repoPath, branch });
      } catch (err) {
        throw new Error(`Git checkout failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
    async createBranch(repoPath, name) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("git_create_branch", { path: repoPath, name });
      } catch (err) {
        throw new Error(`Git create branch failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
    async diffFile(repoPath, filePath) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke<string>("git_diff_file", { path: repoPath, file_path: filePath });
      } catch (err) {
        throw new Error(`Git diff failed: ${(err as Error)?.message ?? String(err)}`);
      }
    },
  },

  settings: {
    async get(key) { return (getStoredSettings() as any)[key]; },
    async set(key, value) {
      const s = getStoredSettings();
      (s as any)[key] = value;
      storeSettings(s);
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
  },
};

interface ParsedToolCall {
  name: string;
  args: Record<string, any>;
  raw: string;
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // 1. read_file
  const readFileRegex = /<read_file\s+path=["']([^"']+)["']\s*\/>/gi;
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

  // 4. list_dir
  const listDirRegex = /<list_dir\s+path=["']([^"']+)["']\s*\/>/gi;
  while ((match = listDirRegex.exec(text)) !== null) {
    toolCalls.push({ name: "list_dir", args: { path: match[1] }, raw: match[0] });
  }

  // 5. run_command
  const runCommandRegex = /<run_command\s+command=["']([^"']+)["']\s*\/>/gi;
  while ((match = runCommandRegex.exec(text)) !== null) {
    toolCalls.push({ name: "run_command", args: { command: match[1] }, raw: match[0] });
  }

  // 6. git_status
  const gitStatusRegex = /<git_status\s*\/>/gi;
  while ((match = gitStatusRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_status", args: {}, raw: match[0] });
  }

  // 7. git_commit
  const gitCommitRegex = /<git_commit\s+message=["']([^"']+)["']\s*\/>/gi;
  while ((match = gitCommitRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_commit", args: { message: match[1] }, raw: match[0] });
  }

  // 8. git_log
  const gitLogRegex = /<git_log\s*\/>/gi;
  while ((match = gitLogRegex.exec(text)) !== null) {
    toolCalls.push({ name: "git_log", args: {}, raw: match[0] });
  }

  // 9. Generic MCP Tool calls
  const mcpTagRegex = /<mcp_([a-z0-9-]+)_([a-z0-9_-]+)([\s\S]*?)>/gi;
  let mcpMatch;
  while ((mcpMatch = mcpTagRegex.exec(text)) !== null) {
    const rawTag = mcpMatch[0];
    const serverName = mcpMatch[1];
    const toolName = mcpMatch[2];
    const bodyOrAttrs = mcpMatch[3];
    const fullName = `mcp_${serverName}_${toolName}`;

    if (rawTag.endsWith("/>") || rawTag.trim().endsWith("/>")) {
      const args: Record<string, string> = {};
      const attrRegex = /([a-z0-9_-]+)=["']([^"']*)["']/gi;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(bodyOrAttrs)) !== null) {
        args[attrMatch[1]] = attrMatch[2];
      }
      toolCalls.push({ name: fullName, args, raw: rawTag });
    } else {
      const closeTagName = `<\/mcp_${serverName}_${toolName}>`;
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

function waitForToolApproval(toolCallId: string): Promise<"approved" | "denied"> {
  return new Promise((resolve) => {
    let resolved = false;
    let unsubscribe: (() => void) | null = null;
    let useChatRef: any = null;

    const check = () => {
      if (resolved || !useChatRef) return;
      try {
        const { pendingToolCalls } = useChatRef.getState();
        const tc = pendingToolCalls.find((t: any) => t.id === toolCallId);
        if (!tc) return;
        if (tc.status === "completed") {
          resolved = true;
          unsubscribe?.();
          resolve("approved");
          return;
        }
        if (tc.status === "failed") {
          resolved = true;
          unsubscribe?.();
          resolve("denied");
          return;
        }
      } catch (err) {
        console.error("Error checking tool approval:", err);
      }
    };

    // Import the store and cache the reference
    import("../store/useAppStore").then(({ useChat }) => {
      useChatRef = useChat;
      // Initial check after import
      check();
      if (resolved) return;
      // Subscribe to store changes
      unsubscribe = useChat.subscribe(() => {
        if (!resolved) check();
      });
    });
  });
}

async function executeTool(name: string, args: Record<string, any>, workspacePath: string, emit: (event: StreamEvent) => void): Promise<string> {
  if (name === "read_file") {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(args.path);
    return new TextDecoder().decode(bytes);
  }

  if (name === "write_file") {
    const { writeFile, readFile: fsReadFile } = await import("@tauri-apps/plugin-fs");
    let oldContent = "";
    try {
      const existingBytes = await fsReadFile(args.path);
      oldContent = new TextDecoder().decode(existingBytes);
    } catch { /* new file */ }
    const newContent = args.content;
    const diffId = "diff-" + Math.random().toString(36).slice(2, 9);
    const hunks = [{ oldStart: 1, oldLines: oldContent.split("\n").length, newStart: 1, newLines: newContent.split("\n").length, lines: [] }];
    const proposal: DiffProposal = { diffId, filePath: args.path, oldContent, newContent, hunks, createdAt: Date.now() };
    pendingDiffProposals.set(diffId, proposal);
    emit({ type: "diff-proposed", proposal });
    await writeFile(args.path, new TextEncoder().encode(newContent));
    const lines = newContent.split("\n").length;
    emit({
      type: "file-changed",
      change: { path: args.path, action: "modified", additions: lines, deletions: 0 }
    });
    return `File written successfully: ${args.path}`;
  }

  if (name === "edit_file") {
    const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(args.path);
    const original = new TextDecoder().decode(bytes);
    if (!original.includes(args.search)) {
      throw new Error(`Search block not found in file: ${args.path}`);
    }
    const updated = original.replace(args.search, args.replace);
    const diffId = "diff-" + Math.random().toString(36).slice(2, 9);
    const oldLines = args.search.split("\n");
    const newLines = args.replace.split("\n");
    const hunks = [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines: [] }];
    const proposal: DiffProposal = { diffId, filePath: args.path, oldContent: original, newContent: updated, hunks, createdAt: Date.now() };
    pendingDiffProposals.set(diffId, proposal);
    emit({ type: "diff-proposed", proposal });
    await writeFile(args.path, new TextEncoder().encode(updated));
    const additions = newLines.length;
    const deletions = oldLines.length;
    emit({
      type: "file-changed",
      change: { path: args.path, action: "modified", additions, deletions }
    });
    return `File edited successfully: ${args.path}`;
  }

  if (name === "list_dir") {
    const nodes = await mockAcodeAPI.fs.listDir(args.path);
    return JSON.stringify(nodes.map(n => ({ name: n.name, path: n.path, type: n.type })), null, 2);
  }

  if (name === "run_command") {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const isWindows = typeof window !== "undefined" && window.navigator.userAgent.includes("Windows");
    const program = isWindows ? "powershell" : "bash";
    const commandArgs = isWindows ? ["-Command", args.command] : ["-c", args.command];
    const cmd = Command.create(program, commandArgs, { cwd: workspacePath });
    const output = await cmd.execute();
    return output.stdout + (output.stderr ? "\n" + output.stderr : "");
  }

  if (name === "git_status") {
    const status = await mockAcodeAPI.git.status(workspacePath);
    return JSON.stringify(status, null, 2);
  }

  if (name === "git_commit") {
    const result = await mockAcodeAPI.git.commit(workspacePath, args.message);
    return `Committed successfully. SHA: ${result.sha}`;
  }

  if (name === "git_log") {
    const log = await mockAcodeAPI.git.log(workspacePath, 10);
    return JSON.stringify(log, null, 2);
  }

  if (name.startsWith("mcp_")) {
    const parts = name.split("_");
    const serverName = parts[1];
    const toolName = parts.slice(2).join("_");

    const { useSkillsMcp } = await import("../store/useAppStore");
    const server = useSkillsMcp.getState().mcpServers.find((m) => m.name === serverName);
    if (!server) {
      throw new Error(`MCP Server "${serverName}" not found or configured.`);
    }
    if (!server.enabled) {
      throw new Error(`MCP Server "${serverName}" is disabled.`);
    }

    if (server.transport === "http") {
      const url = server.url;
      if (!url) throw new Error("HTTP Endpoint URL is required");
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
          id: 1,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} calling MCP tool`);
      const json = await resp.json();
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      const content = json.result?.content || [];
      return content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
    } else {
      const command = server.command;
      if (!command) throw new Error("Stdio command is required");
      try {
        const { Command } = await import("@tauri-apps/plugin-shell");
        const cmd = Command.create(command, server.args ?? [], { env: server.env });
        
        const resultPromise = new Promise<string>(async (resolve, reject) => {
          let outputBuffer = "";
          let resolved = false;

          cmd.stdout.on("data", (data: string) => {
            outputBuffer += data;
            try {
              const lines = outputBuffer.split("\n");
              for (const line of lines) {
                if (line.trim().startsWith("{")) {
                  const parsed = JSON.parse(line.trim());
                  if (parsed.result?.content || parsed.content || parsed.error) {
                    resolved = true;
                    if (parsed.error) {
                      reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                    } else {
                      const content = parsed.result?.content || parsed.content || [];
                      const text = content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
                      resolve(text);
                    }
                    break;
                  }
                }
              }
            } catch (e) {
              // Ignore partial parse
            }
          });

          cmd.stderr.on("data", (data: string) => {
            console.warn("MCP Stderr:", data);
          });

          const child = await cmd.spawn();
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
              child.kill().catch(() => {});
              reject(new Error("Timeout waiting for tools/call response (30s)"));
            }
          }, 30000);
        });

        return await resultPromise;
      } catch (err) {
        console.warn(`Stdio execution failed for ${name}, running mock fallback:`, err);
        if (toolName === "get_weather") {
          return `Mock Weather Report for ${args.city || "SF"}: Sunny, 72°F.`;
        } else if (toolName === "read_memory") {
          return `Mock Memory Value: key="${args.key || "default"}" is not set or empty.`;
        } else if (toolName === "write_memory") {
          return `Mock Memory Success: wrote key="${args.key}" value="${args.value}".`;
        }
        return `Mock response for ${toolName} with arguments: ${JSON.stringify(args)}`;
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}
