# Phase 9: Self-Improving Systems

> **Priority:** Medium
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 4 (memory), Phase 5 (dream agent)
> **Primary Files:** `genes.ts` (653 lines), `hookBus.ts` (227 lines), `hookListeners.ts` (551 lines), `skillCrystallizer.ts` (215 lines), `verificationEngine.ts` (304 lines)

## Current State Analysis

### Self-Improving Architecture

```
Genes:      Observe → Candidate → Validate → Solidify → Express
Skills:     Detect complex session → LLM generalize → Create SKILL.md
Dream:      Purge → Validate → Rescore → Dedup → Consolidate
Hooks:      SessionStart → PostToolUse → Stop → SessionEnd → ContextPressure
```

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Gene debounced save loses activation counts | Medium | genes.ts:302-309 |
| 2 | Gene triggers compiled without sandboxing | Medium | genes.ts:283-286 |
| 3 | No gene versioning/rollback | Low | — |
| 4 | No gene conflict resolution | Low | — |
| 5 | Missing `PreToolUse` hook | High | hookBus.ts |
| 6 | Missing `ContextCompaction` hook | Medium | hookBus.ts |
| 7 | Missing `MemorySaved` hook | Low | hookBus.ts |
| 8 | `onSessionEnd` runs 7 sequential steps | Medium | hookListeners.ts:335-356 |
| 9 | `autoExtractMemories` duplicates API logic | Medium | hookListeners.ts:174-251 |
| 10 | Verification engine only reads package.json | Medium | verificationEngine.ts:265-286 |
| 11 | `runShellCommand` double-wraps output | Low | verificationEngine.ts:56-67 |
| 12 | `buildDefaultCriteria` always includes "tests pass" | Low | verificationEngine.ts:301 |

---

## Improvement 9.1: Fix Gene Debounced Save

**File:** `genes.ts:302-309`

### Current State

```typescript
// Lines 302-309: Race condition — only last pool state survives
_pendingGeneSave = setTimeout(async () => {
  if (_pendingGenePool) {
    await saveGenePool(_pendingGenePool);
    _pendingGenePool = null;
  }
}, 50);
```

### Fix: Queue-Based Save

```typescript
interface GeneSaveQueue {
  pool: GenePool;
  activationCounts: Map<string, number>;
  timestamp: number;
}

const _saveQueue: GeneSaveQueue[] = [];
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function queueGeneSave(pool: GenePool, activationCounts: Map<string, number>): void {
  _saveQueue.push({
    pool: JSON.parse(JSON.stringify(pool)),  // Deep copy
    activationCounts: new Map(activationCounts),
    timestamp: Date.now(),
  });
  
  if (!_saveTimer) {
    _saveTimer = setTimeout(processGeneSaveQueue, 50);
  }
}

async function processGeneSaveQueue(): Promise<void> {
  if (_saveQueue.length === 0) {
    _saveTimer = null;
    return;
  }
  
  // Merge all queued states
  const merged = _saveQueue.reduce((acc, entry) => {
    // Merge activation counts
    for (const [geneId, count] of entry.activationCounts) {
      acc.activationCounts.set(geneId, (acc.activationCounts.get(geneId) || 0) + count);
    }
    // Use latest pool state
    acc.pool = entry.pool;
    return acc;
  }, { pool: _saveQueue[_saveQueue.length - 1].pool, activationCounts: new Map<string, number>() });
  
  _saveQueue.length = 0;
  
  // Apply merged activation counts
  for (const gene of merged.pool.genes) {
    const count = merged.activationCounts.get(gene.id) || 0;
    gene.activationCount += count;
  }
  
  await saveGenePool(merged.pool);
  _saveTimer = null;
}
```

---

## Improvement 9.2: Add Gene Trigger Validation

**File:** `genes.ts:283-286`

### Current State

```typescript
// Lines 283-286: Regex compiled without validation
const regex = new RegExp(gene.trigger, "i");
if (regex.test(lowerPrompt)) { ... }
```

### Fix: Validate Before Compile

```typescript
const MAX_TRIGGER_LENGTH = 200;
const DANGEROUS_REGEX_PATTERNS = [
  /(.*a.*){100,}/,  // Catastrophic backtracking
  /\(\?/,           // Lookahead/lookbehind (expensive)
];

function safeCompileTrigger(trigger: string): RegExp | null {
  // Length check
  if (trigger.length > MAX_TRIGGER_LENGTH) {
    console.warn(`[Genes] Trigger too long (${trigger.length} chars), skipping: ${trigger.slice(0, 50)}...`);
    return null;
  }
  
  // Dangerous pattern check
  for (const pattern of DANGEROUS_REGEX_PATTERNS) {
    if (pattern.test(trigger)) {
      console.warn(`[Genes] Dangerous regex pattern detected, skipping: ${trigger.slice(0, 50)}...`);
      return null;
    }
  }
  
  try {
    return new RegExp(trigger, "i");
  } catch {
    // Invalid regex — treat as literal string
    return null;
  }
}

// In expressGenes:
const regex = safeCompileTrigger(gene.trigger);
if (regex && regex.test(lowerPrompt)) {
  // ... activate gene
}
```

---

## Improvement 9.3: Add PreToolUse Hook

**File:** `hookBus.ts`

### New Hook Type

```typescript
// Add to HookEventMap
interface HookEventMap {
  // ... existing events
  PreToolUse: {
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
  };
}

// Add to HookEvent type
type HookEvent = 
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"      // NEW
  | "PostToolUse"
  | "Stop"
  | "SessionEnd"
  | "ContextPressure";
```

### Implementation

```typescript
// In hookBus.ts
export async function emitPreToolUse(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ allow: boolean; reason?: string }> {
  const results = await emit("PreToolUse", { toolCallId, name, args });
  
  // If any handler returns deny, block the tool
  for (const result of results) {
    if (result.allow === false) {
      return { allow: false, reason: result.reason };
    }
  }
  
  return { allow: true };
}
```

### Usage in Tool Execution

```typescript
// In executeTool, before execution
const preToolResult = await emitPreToolUse(tc.id, tc.name, tc.args);
if (!preToolResult.allow) {
  return {
    toolCallId: tc.id,
    name: tc.name,
    result: `Error: Blocked by permission policy: ${preToolResult.reason}`,
    success: false,
  };
}
```

---

## Improvement 9.4: Add ContextCompaction Hook

**File:** `hookBus.ts`

```typescript
// Add to HookEventMap
interface HookEventMap {
  // ... existing events
  ContextCompaction: {
    sessionId: string;
    messagesBefore: number;
    messagesAfter: number;
    tokensReclaimed: number;
    tier: 1 | 2;
  };
}
```

### Usage

```typescript
// In compactSessionHistory, after compaction
await emit("ContextCompaction", {
  sessionId,
  messagesBefore: messages.length,
  messagesAfter: compacted.length,
  tokensReclaimed: stats.totalTokens - compactedStats.totalTokens,
  tier: compactionTier,
});
```

### Hook Listener

```typescript
// In hookListeners.ts
hookBus.on("ContextCompaction", async (event) => {
  // Save critical facts before they're lost to compaction
  if (event.tier === 2) {
    const messages = useChat.getState().messages;
    const criticalFacts = extractCriticalFacts(messages);
    
    for (const fact of criticalFacts) {
      await saveMemory(fact, workspacePath);
    }
  }
  
  // Log compaction event
  trajectoryRecorder.recordEvent({
    type: "compaction",
    ...event,
  });
});
```

---

## Improvement 9.5: Parallelize SessionEnd Steps

**File:** `hookListeners.ts:335-356`

### Current State

```typescript
// Lines 335-356: Sequential execution
async function onSessionEnd(sessionId: string) {
  await cleanupSessionData(sessionId);      // Step 1
  await cleanupTerminalState(sessionId);     // Step 2
  await generateSessionTitle(sessionId);     // Step 3 (LLM call)
  await extractSessionMemories(sessionId);   // Step 4 (LLM call)
  await updateSessionStats(sessionId);       // Step 5
  await recordTrajectory(sessionId);         // Step 6
  await processDreamCycle(sessionId);        // Step 7
}
```

### Fix: Parallelize Independent Steps

```typescript
async function onSessionEnd(sessionId: string) {
  // Step 1-2: Cleanup (sequential, fast)
  await cleanupSessionData(sessionId);
  await cleanupTerminalState(sessionId);
  
  // Step 3-4: LLM calls (parallel, slow)
  const [title, memories] = await Promise.all([
    generateSessionTitle(sessionId).catch(() => null),
    extractSessionMemories(sessionId).catch(() => null),
  ]);
  
  // Step 5-7: Post-processing (parallel, independent)
  await Promise.allSettled([
    updateSessionStats(sessionId),
    recordTrajectory(sessionId),
    processDreamCycle(sessionId),
  ]);
}
```

---

## Improvement 9.6: Expand Verification Engine Language Support

**File:** `verificationEngine.ts:265-286`

### Current State

```typescript
// Lines 265-286: Only reads package.json
async function detectCommandsFromWorkspace(workspacePath: string) {
  const packageJsonPath = joinPath(workspacePath, "package.json");
  const exists = await api.fs.exists(packageJsonPath);
  if (!exists) return [];
  
  const content = await api.fs.readFile(packageJsonPath);
  const pkg = JSON.parse(content);
  // ... extract scripts
}
```

### Fix: Multi-Language Support

```typescript
async function detectCommandsFromWorkspace(workspacePath: string): Promise<VerificationCommand[]> {
  const commands: VerificationCommand[] = [];
  
  // JavaScript/TypeScript
  const packageJsonPath = joinPath(workspacePath, "package.json");
  if (await api.fs.exists(packageJsonPath)) {
    const content = await api.fs.readFile(packageJsonPath);
    const pkg = JSON.parse(content);
    
    if (pkg.scripts?.typecheck) commands.push({ name: "typecheck", command: "npm run typecheck", required: false });
    if (pkg.scripts?.lint) commands.push({ name: "lint", command: "npm run lint", required: false });
    if (pkg.scripts?.test) commands.push({ name: "test", command: "npm test", required: false });
    if (pkg.scripts?.build) commands.push({ name: "build", command: "npm run build", required: true });
  }
  
  // Rust
  const cargoTomlPath = joinPath(workspacePath, "Cargo.toml");
  if (await api.fs.exists(cargoTomlPath)) {
    commands.push({ name: "check", command: "cargo check", required: true });
    commands.push({ name: "test", command: "cargo test", required: false });
    commands.push({ name: "clippy", command: "cargo clippy", required: false });
  }
  
  // Python
  const pyprojectPath = joinPath(workspacePath, "pyproject.toml");
  const setupPyPath = joinPath(workspacePath, "setup.py");
  if (await api.fs.exists(pyprojectPath) || await api.fs.exists(setupPyPath)) {
    commands.push({ name: "typecheck", command: "mypy .", required: false });
    commands.push({ name: "lint", command: "ruff check .", required: false });
    commands.push({ name: "test", command: "pytest", required: false });
  }
  
  // Go
  const goModPath = joinPath(workspacePath, "go.mod");
  if (await api.fs.exists(goModPath)) {
    commands.push({ name: "build", command: "go build ./...", required: true });
    commands.push({ name: "test", command: "go test ./...", required: false });
    commands.push({ name: "vet", command: "go vet ./...", required: false });
  }
  
  // Monorepo
  const turboJsonPath = joinPath(workspacePath, "turbo.json");
  if (await api.fs.exists(turboJsonPath)) {
    commands.push({ name: "build", command: "turbo build", required: true });
    commands.push({ name: "lint", command: "turbo lint", required: false });
    commands.push({ name: "test", command: "turbo test", required: false });
  }
  
  return commands;
}
```

---

## Implementation Steps

1. Fix gene debounced save with queue-based approach
2. Add gene trigger validation (length, dangerous patterns)
3. Add `PreToolUse` hook to hookBus
4. Add `ContextCompaction` hook to hookBus
5. Parallelize session end steps
6. Expand verification engine to support Rust, Python, Go
7. Add hook listener for context compaction (save facts before compaction)
8. Add tests for gene trigger validation
9. Add test: verify PreToolUse hook can block tools

---

## Success Criteria

- [ ] Gene activation counts never lost on rapid prompts
- [ ] Dangerous regex patterns rejected
- [ ] PreToolUse hook can auto-approve/block tools
- [ ] ContextCompaction hook saves facts before compaction
- [ ] Session end completes 30% faster (parallelized)
- [ ] Verification engine supports JS, TS, Rust, Python, Go
