# Phase 4: Memory System

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 3 (context management)
> **Primary Files:** `memoryStore.ts` (1,095 lines), `memoryTypes.ts` (90 lines), `database.ts`

## Current State Analysis

### Architecture: Git-first Markdown / SQLite-Cache Hybrid

```
Source of Truth:  .dalam/memories/*.md  (human-readable, git-friendly)
Search Cache:     SQLite FTS5           (fast keyword search, rebuilt from markdown if lost)
Index:            .dalam/MEMORY.md      (pointer file, capped at 200 lines)
```

### SQLite Schema

```sql
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,          -- user|feedback|project|reference|task|decision
  tier          TEXT NOT NULL DEFAULT 'medium',  -- critical|high|medium|low
  content       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  source_session TEXT,
  source_file   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  access_count  INTEGER DEFAULT 0,
  last_accessed INTEGER DEFAULT 0,
  verified      INTEGER DEFAULT 0,
  stale         INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  id UNINDEXED, content, summary, tags, category UNINDEXED,
  content='memories', content_rowid='rowid'
);
```

### Memory Lifecycle

```
Save: search similar → Jaccard > 0.90: NOOP
                   → Jaccard > 0.65 + same category: UPDATE
                   → Otherwise: INSERT
                   → writeMemoryMarkdown (source of truth)

Search: FTS5 BM25 → fallback to LIKE

Maintenance: detectStale → enforceBudget → purgeStale
```

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | FTS5 query escaping is incomplete | Medium | memoryStore.ts:194-204 |
| 2 | No dedup against recently extracted memories in session | Medium | — |
| 3 | Memory extraction after compaction operates on summaries | High | useAppStore.ts:2627-2651 |
| 4 | SQLite and markdown can drift on write failure | High | memoryStore.ts:366 |
| 5 | `getAllMemories` called 3 times in dream cycle | Medium | dreamAgent.ts:128,191,252 |
| 6 | Jaccard similarity doesn't handle semantic similarity | Low | memoryStore.ts:827 |
| 7 | No memory export/import UI | Low | — |
| 8 | `scoreMemory` formula doesn't account for tier changes | Low | memoryStore.ts:906 |

---

## Improvement 4.1: Harden FTS5 Query Escaping

**File:** `memoryStore.ts:194-204`

### Current State

```typescript
// Lines 194-204: Basic escaping
const escapeFts = (t: string) => t.replace(/['"*+\-()^~\\:|]/g, ' ').replace(/"/g, ' ');
const tokens = safeQuery.split(/\s+/).filter(Boolean);
const ftsQuery = tokens.map(t => `"${escapeFts(t)}"`).join(" OR ");
```

### Fix: Comprehensive Escaping

```typescript
function escapeFts5Token(token: string): string {
  // FTS5 special characters: ' " * + - ( ) ^ ~ \ : | /
  // Also handle braces {} and brackets [] which some FTS5 builds support
  return token
    .replace(/['"*+\-()^~\\:|/{}[\]]/g, ' ')  // Strip special chars
    .replace(/"/g, ' ')                          // Strip double quotes
    .trim();
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(escapeFts5Token)
    .filter(t => t.length > 0);  // Remove empty tokens after escaping
  
  if (tokens.length === 0) return '""';  // Empty query matches nothing
  
  // Use OR for broad matching, each token quoted for exact phrase
  return tokens.map(t => `"${t}"`).join(" OR ");
}

// Add test cases:
// - Query with quotes: '"test"' → 'test'
// - Query with operators: 'foo OR bar' → 'foo OR bar' (escaped)
// - Query with code: 'arr.filter(x => x > 0)' → 'arr filter x x 0'
// - Query with CJK: '日本語テスト' → '"日本語テスト"'
```

---

## Improvement 4.2: Dedup Against Session-Extracted Memories

**File:** `useAppStore.ts:2627-2651`

### Current State

Post-turn memory extraction runs without checking if similar memories were already extracted in the same session.

### Fix: Track Session Extraction Hashes

```typescript
// Add to useChat state
interface UseChatState {
  sessionExtractedHashes: Set<string>;  // Content hashes extracted this session
  // ...
}

// In post-turn extraction
case "message-end":
  // ... existing code ...
  
  // Track extracted content hashes
  const extractedHashes = new Set<string>();
  
  for (const entry of extractionResult.entries) {
    const hash = simpleHash(entry.content);
    extractedHashes.add(hash);
  }
  
  set(s => ({
    sessionExtractedHashes: new Set([...s.sessionExtractedHashes, ...extractedHashes]),
  }));

// In extractMemoriesWithLLM, add dedup check
async function extractMemoriesWithLLM(
  userInput: string,
  assistantResponse: string,
  fetchLLM: (prompt: string) => Promise<string>,
  opts: { sessionId?: string; maxEntries?: number; workspacePath?: string; existingHashes?: Set<string> } = {}
) {
  // ... existing extraction logic ...
  
  // Filter out already-extracted memories
  const newEntries = entries.filter(e => {
    const hash = simpleHash(e.content);
    return !opts.existingHashes?.has(hash);
  });
  
  // ... save newEntries ...
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
```

---

## Improvement 4.3: Extract Memories BEFORE Compaction

**File:** `useAppStore.ts:2627-2651`

### Current State

```typescript
// Lines 2627-2651: Extraction runs AFTER compaction
// Compaction may have already summarized away important details
```

### Fix: Reorder Extraction and Compaction

```typescript
// In message-end handler, reorder:

// 1. Extract memories FIRST (while full context is available)
if (sessionId && finalContent) {
  const extractionResult = await extractMemoriesWithLLM(
    lastUserMessage,
    finalContent,
    fetchLLM,
    { sessionId, workspacePath, maxEntries: 3, existingHashes: sessionExtractedHashes }
  );
  // ... handle extraction result
}

// 2. THEN compact (after extraction has captured important details)
if (stats.shouldPrune || stats.shouldCompact) {
  await compactSessionHistory(sessionId);
}
```

---

## Improvement 4.4: Write Transaction with Retry Queue

**File:** `memoryStore.ts:366`

### Current State

```typescript
// writeMemoryMarkdown can fail, leaving SQLite updated but markdown out of sync
export async function writeMemoryMarkdown(workspacePath: string, entry: MemoryEntry): Promise<void> {
  try {
    await api.fs.writeFile(filePath, content);
  } catch (err) {
    console.debug("[MemoryStore] Failed to write markdown:", err);
    // Silent failure — SQLite and markdown now out of sync
  }
}
```

### Fix: Write Transaction with Retry

```typescript
interface PendingWrite {
  entry: MemoryEntry;
  workspacePath: string;
  retries: number;
  timestamp: number;
}

const _pendingWrites: PendingWrite[] = [];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function writeMemoryWithRetry(
  workspacePath: string,
  entry: MemoryEntry
): Promise<void> {
  try {
    await writeMemoryMarkdown(workspacePath, entry);
  } catch (err) {
    console.warn("[MemoryStore] Markdown write failed, queuing retry:", err);
    _pendingWrites.push({
      entry,
      workspacePath,
      retries: 0,
      timestamp: Date.now(),
    });
  }
}

// Process retry queue (call periodically, e.g., every 30 seconds)
async function processPendingWrites(): Promise<void> {
  const now = Date.now();
  const stillPending: PendingWrite[] = [];
  
  for (const write of _pendingWrites) {
    if (write.retries >= MAX_RETRIES) {
      console.error(`[MemoryStore] Giving up on write for ${write.entry.id} after ${MAX_RETRIES} retries`);
      continue;
    }
    
    if (now - write.timestamp < RETRY_DELAY_MS * (write.retries + 1)) {
      stillPending.push(write);
      continue;
    }
    
    try {
      await writeMemoryMarkdown(write.workspacePath, write.entry);
    } catch (err) {
      stillPending.push({
        ...write,
        retries: write.retries + 1,
        timestamp: now,
      });
    }
  }
  
  _pendingWrites.length = 0;
  _pendingWrites.push(...stillPending);
}

// Start periodic processing
setInterval(processPendingWrites, 30_000);
```

---

## Improvement 4.5: Cache getAllMemories in Dream Cycle

**File:** `dreamAgent.ts`

### Current State

```typescript
// Lines 128, 191, 252: getAllMemories called 3 times
const allMemories = await getAllMemories({ excludeStale: false }); // Line 128
// ... Phase 2 ...
const allActiveMemories = await getAllMemories(); // Line 191
// ... Phase 2.5 ...
const activeMemories = await getAllMemories(); // Line 252
```

### Fix: Cache and Reuse

```typescript
export async function runDreamCycle(workspacePath: string, ...) {
  // Fetch all memories ONCE at the start
  const allMemories = await getAllMemories({ excludeStale: false });
  const activeMemories = allMemories.filter(m => !m.stale);
  
  // Phase 1: Purge stale
  const staleCount = allMemories.filter(m => m.stale).length;
  // ... use pre-fetched data
  
  // Phase 2: Validate file references
  for (const mem of allMemories) { // Use cached data
    // ... validation logic
  }
  
  // Phase 2.5: Re-score
  for (const mem of activeMemories) { // Use cached data
    // ... scoring logic
  }
  
  // Phase 3: Date adjustment
  const dateCandidates = activeMemories.filter(m => 
    RELATIVE_DATE_REGEX.test(m.content)
  ); // Filter from cached data
  
  // Phase 4: Dedup
  // ... use cached data
  
  // Note: After any writes, invalidate cache if re-reading
}
```

---

## Improvement 4.6: Improve Memory Scoring Formula

**File:** `memoryStore.ts:906`

### Current State

```typescript
export function scoreMemory(m: MemoryEntry): number {
  let score = tierWeight(m.tier) * 10;  // critical=40, high=30, medium=20, low=10
  
  if (m.accessCount > 0) {
    score += Math.log2(m.accessCount + 1) * 5;
  }
  
  if (m.lastAccessedAt > 0) {
    const daysSinceAccess = (Date.now() - m.lastAccessedAt) / DAY;
    score += Math.max(0, 10 * Math.pow(0.5, daysSinceAccess / 14));
  }
  
  if (m.accessCount === 0) {
    const daysSinceCreation = (Date.now() - m.createdAt) / DAY;
    if (daysSinceCreation > 7) {
      score -= Math.min(10, daysSinceCreation * 0.5);
    }
  }
  
  if (m.verified) score += 5;
  
  return Math.max(0, score);
}
```

### Fix: Account for Tier Changes and Source Quality

```typescript
export function scoreMemory(m: MemoryEntry): number {
  let score = tierWeight(m.tier) * 10;
  
  // Access frequency (log-scaled)
  if (m.accessCount > 0) {
    score += Math.log2(m.accessCount + 1) * 5;
  }
  
  // Recency (exponential decay, 14-day half-life)
  if (m.lastAccessedAt > 0) {
    const daysSinceAccess = (Date.now() - m.lastAccessedAt) / DAY;
    score += Math.max(0, 10 * Math.pow(0.5, daysSinceAccess / 14));
  }
  
  // Age penalty for unaccessed memories
  if (m.accessCount === 0) {
    const daysSinceCreation = (Date.now() - m.createdAt) / DAY;
    if (daysSinceCreation > 7) {
      score -= Math.min(10, daysSinceCreation * 0.5);
    }
  }
  
  // Verification bonus
  if (m.verified) score += 5;
  
  // NEW: Source quality bonus
  if (m.sourceSession) score += 2;  // Extracted from conversation
  if (m.sourceFile) score += 1;     // References a specific file
  
  // NEW: Tag richness bonus (more tags = more searchable)
  score += Math.min(3, m.tags.length);
  
  // NEW: Content quality heuristic
  if (m.content.length > 50 && m.content.length < 500) score += 2;
  if (m.summary.length > 20 && m.summary.length < 150) score += 1;
  
  return Math.max(0, score);
}
```

---

## Implementation Steps

1. Harden FTS5 query escaping with comprehensive test cases
2. Add session-level dedup tracking for memory extraction
3. Reorder extraction and compaction in message-end handler
4. Implement write transaction with retry queue
5. Cache `getAllMemories` in dream cycle
6. Improve memory scoring formula
7. Add memory export/import UI in settings
8. Add tests for FTS5 escaping edge cases
9. Add test: verify write retry queue processes correctly

---

## Success Criteria

- [ ] FTS5 queries handle all special characters correctly
- [ ] No duplicate memories extracted in same session
- [ ] Memories extracted before compaction preserves details
- [ ] SQLite and markdown stay in sync (retry queue)
- [ ] Dream cycle makes only 1 `getAllMemories` call
- [ ] Memory scoring accounts for source quality
- [ ] Export/import works via settings UI
