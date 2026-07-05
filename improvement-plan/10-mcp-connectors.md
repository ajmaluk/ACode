# Phase 10: MCP & Connectors

> **Priority:** Medium-High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 8 (security)
> **Primary Files:** `mcpCache.ts` (143 lines), `dalamAPI.ts` (lines 3826-4003), `connectors.ts` (831 lines), `SettingsModal.tsx` (lines 865-1177)

## Current State Analysis

### MCP Architecture

```
LLM Response → parse XML <mcp_servername_toolname> → spawn process (stdio) or HTTP call → return result
```

### Current MCP Implementation Issues

| Issue | Impact |
|-------|--------|
| Stdio spawns NEW process per tool call | 5-15s latency per call |
| HTTP sessions re-initialize on expiry | 2-3 extra round trips |
| JSON parsing is fragile (no multi-line) | Dropped responses |
| Tool naming ambiguous with underscores | Wrong tool resolution |

### Connector System

| Connector | Status | Issues |
|-----------|--------|--------|
| Webhook | Stub (no HTTP server) | Non-functional |
| FileWatcher | Functional | Polls entire files (wasteful) |
| Cron | Functional | Scheduling bugs |
| Telegram | Functional | No reconnection logic |
| WhatsApp | Functional | No reconnection logic |
| WebSocket | Declared but unimplemented | Non-functional |

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | MCP stdio spawns NEW process per call | Critical | dalamAPI.ts:3914-4003 |
| 2 | MCP stdio JSON parsing fragile (no multi-line) | High | dalamAPI.ts:3928-3950 |
| 3 | MCP HTTP session race condition | Medium | dalamAPI.ts:3826-3852 |
| 4 | MCP tool naming ambiguous with underscores | Medium | dalamAPI.ts:2759-2782 |
| 5 | Connectors not auto-restarted on config change | Medium | connectors.ts:806-811 |
| 6 | WebhookConnector is a stub | Low | connectors.ts:138 |
| 7 | MCP form allows adding without command/URL | Medium | SettingsModal.tsx:918-933 |
| 8 | No MCP connection test button | Medium | — |
| 9 | FileWatcherConnector polls entire files | Low | connectors.ts:229-257 |
| 10 | No MCP tool argument type coercion | Medium | dalamAPI.ts:2793 |

---

## Improvement 10.1: Persistent MCP Stdio Connections

**File:** `dalamAPI.ts:3914-4003`

### Current State

```typescript
// Lines 3914-4003: Spawn new process for EVERY tool call
async function executeMcpStdioTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const process = Command.create(server.command, server.args || []);
  const output = await process.execute();
  // Process dies after this
}
```

### Fix: Connection Pool

```typescript
interface McpStdioConnection {
  process: ChildProcess;
  serverName: string;
  lastUsed: number;
  initialized: boolean;
  pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
}

const _mcpConnections: Map<string, McpStdioConnection> = new Map();
const MCP_CONNECTION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const MCP_REQUEST_TIMEOUT = 30_000; // 30 seconds

async function getMcpStdioConnection(server: McpServer): Promise<McpStdioConnection> {
  const existing = _mcpConnections.get(server.name);
  
  if (existing && !existing.process.killed) {
    existing.lastUsed = Date.now();
    return existing;
  }
  
  // Spawn new persistent process
  const child = spawn(server.command, server.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...server.env },
  });
  
  const connection: McpStdioConnection = {
    process: child,
    serverName: server.name,
    lastUsed: Date.now(),
    initialized: false,
    pendingRequests: new Map(),
  };
  
  // Set up JSON-RPC message handler
  let buffer = '';
  child.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    
    // Process complete messages
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const pending = connection.pendingRequests.get(message.id);
        if (pending) {
          connection.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  });
  
  // Initialize connection
  await sendMcpMessage(connection, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dalam", version: "0.1.0" },
    },
  });
  
  await sendMcpMessage(connection, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  
  connection.initialized = true;
  _mcpConnections.set(server.name, connection);
  
  return connection;
}

async function sendMcpMessage(
  connection: McpStdioConnection,
  message: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = message.id as string;
    
    const timeout = setTimeout(() => {
      connection.pendingRequests.delete(id);
      reject(new Error(`MCP request timed out after ${MCP_REQUEST_TIMEOUT}ms`));
    }, MCP_REQUEST_TIMEOUT);
    
    connection.pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    
    connection.process.stdin!.write(JSON.stringify(message) + '\n');
  });
}

// Cleanup idle connections
setInterval(() => {
  const now = Date.now();
  for (const [name, conn] of _mcpConnections) {
    if (now - conn.lastUsed > MCP_CONNECTION_TIMEOUT) {
      conn.process.kill();
      _mcpConnections.delete(name);
    }
  }
}, 60_000);
```

### Performance Impact

- **Before:** 5-15s per MCP tool call (new process spawn + initialization)
- **After:** <100ms per MCP tool call (persistent connection)
- **Improvement:** 50-150x faster

---

## Improvement 10.2: Fix MCP Stdio JSON Parsing

**File:** `dalamAPI.ts:3928-3950`

### Current State

```typescript
// Lines 3928-3950: Fragile line-based parsing
const lines = output.split('\n');
for (const line of lines) {
  if (line.startsWith('{')) {
    const message = JSON.parse(line);
    // ...
  }
}
```

### Fix: Proper JSON-RPC Buffer Parser

```typescript
class McpJsonRpcParser {
  private buffer = '';
  private messages: Array<{ type: 'request' | 'response' | 'notification'; message: unknown }> = [];
  
  feed(data: string): void {
    this.buffer += data;
    
    // Try to parse complete messages
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      
      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      
      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      
      if (this.buffer.length < bodyStart + contentLength) {
        // Incomplete message
        break;
      }
      
      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);
      
      try {
        const message = JSON.parse(body);
        if (message.id !== undefined && message.result !== undefined) {
          this.messages.push({ type: 'response', message });
        } else if (message.method) {
          this.messages.push({ type: 'request', message });
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
  
  nextMessage(): { type: string; message: unknown } | undefined {
    return this.messages.shift();
  }
}
```

---

## Improvement 10.3: Fix MCP HTTP Session Race Condition

**File:** `dalamAPI.ts:3826-3852`

### Current State

```typescript
// Lines 3826-3852: Race condition on concurrent calls
const session = mcpHttpSessions.get(serverName);
if (!session) {
  // Two concurrent calls can both see no session and both initialize
  const newSession = await initializeMcpHttpSession(server);
  mcpHttpSessions.set(serverName, newSession);
}
```

### Fix: Mutex Per Server

```typescript
const _mcpSessionMutexes: Map<string, Promise<McpHttpSession>> = new Map();

async function getMcpHttpSession(server: McpServer): Promise<McpHttpSession> {
  const existing = mcpHttpSessions.get(server.name);
  if (existing && !isExpired(existing)) {
    return existing;
  }
  
  // Use mutex to prevent concurrent initialization
  const mutex = _mcpSessionMutexes.get(server.name);
  if (mutex) {
    return mutex;
  }
  
  const initPromise = initializeMcpHttpSession(server).then(session => {
    mcpHttpSessions.set(server.name, session);
    _mcpSessionMutexes.delete(server.name);
    return session;
  }).catch(err => {
    _mcpSessionMutexes.delete(server.name);
    throw err;
  });
  
  _mcpSessionMutexes.set(server.name, initPromise);
  return initPromise;
}
```

---

## Improvement 10.4: Add MCP Connection Test Button

**File:** `SettingsModal.tsx`

```typescript
// In McpTab, add test button per server
function McpServerRow({ server }: { server: McpServer }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    
    try {
      const tools = await connectMcpServer(server);
      setTestResult("success");
      toast({
        title: "Connection successful",
        description: `Found ${tools.length} tools`,
        type: "success",
      });
    } catch (err) {
      setTestResult("error");
      toast({
        title: "Connection failed",
        description: err instanceof Error ? err.message : "Unknown error",
        type: "error",
      });
    } finally {
      setTesting(false);
    }
  };
  
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm">{server.name}</span>
      <span className={`text-xs ${getStatusColor(server.status)}`}>
        {server.status}
      </span>
      <button
        onClick={handleTest}
        disabled={testing}
        className="px-2 py-1 text-xs bg-white/10 rounded hover:bg-white/20 disabled:opacity-50"
      >
        {testing ? "Testing..." : "Test"}
      </button>
      {testResult === "success" && <Check className="w-4 h-4 text-green-400" />}
      {testResult === "error" && <X className="w-4 h-4 text-red-400" />}
    </div>
  );
}
```

---

## Implementation Steps

1. Implement persistent MCP stdio connection pool
2. Fix MCP stdio JSON-RPC parsing with proper buffer
3. Add mutex for MCP HTTP session initialization
4. Fix MCP tool name disambiguation (longest prefix match)
5. Auto-restart connectors on config change (from Phase 0)
6. Add MCP connection test button in settings
7. Add MCP tool list display in settings
8. Add MCP argument type coercion (parse JSON strings)
9. Add FileWatcherConnector mtime check before reading
10. Remove or implement WebhookConnector

---

## Success Criteria

- [ ] MCP stdio connections persist across tool calls (50-150x faster)
- [ ] JSON-RPC parsing handles multi-line responses
- [ ] No race condition on concurrent MCP HTTP calls
- [ ] MCP tool names resolve correctly with underscores
- [ ] Connectors restart on config change
- [ ] Settings UI shows test button per MCP server
- [ ] MCP arguments are type-coerced (numbers, booleans, arrays)
