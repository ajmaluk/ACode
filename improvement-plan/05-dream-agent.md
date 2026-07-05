# Phase 5: Dream Agent

> **Priority:** High
> **Estimated Effort:** 1 week
> **Dependencies:** Phase 4 (memory system)
> **Primary Files:** `dreamAgent.ts` (695 lines), `dreamProposalPipeline.ts` (278 lines), `skillCrystallizer.ts` (215 lines)

## Current State Analysis

### Dream Cycle Lifecycle

```
Phase 0: Guard checks (mutex, model availability)
Phase 1: Purge stale memories
Phase 2: Validate file references → mark-stale proposals
Phase 2.5: Re-score (promote/demote based on access)
Phase 3: LLM date adjustments (max 20 calls)
Phase 4: LLM dedup/merge (max 10 merges, 30 total LLM calls)
Phase 5: Post-dedup purge
Phase 6: Skill consolidation (Jaccard > 0.45)
Phase 7: Update MEMORY.md index
```

### LLM Call Budget

| Phase | Max Calls | Current Pattern |
|-------|-----------|-----------------|
| Date adjustments | 20 | 1 call per memory (individual) |
| Dedup merges | 10 | 1 call per pair (pairwise) |
| **Total** | **30** | — |
| Skill consolidation | Uncapped | O(n²) pairs |

### Issues Found

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Date adjustment: 1 LLM call per memory (up to 20) | High | dreamAgent.ts:279-298 |
| 2 | Dedup: O(n²) pairwise nested loops | High | dreamAgent.ts:348-361 |
| 3 | Skill consolidation Jaccard threshold too low (0.45) | Medium | dreamAgent.ts:627 |
| 4 | `processProposals` is dead code | Low | dreamProposalPipeline.ts:209 |
| 5 | Skill consolidation has no rollback on cancellation | Medium | dreamAgent.ts:654-658 |
| 6 | Dream timing stored in localStorage | Critical | dreamAgent.ts:548 (Phase 0) |
| 7 | In-place mutation during dedup | High | dreamAgent.ts:450-452 (Phase 0) |
| 8 | No embedding-based similarity (Jaccard is word-level) | Low | — |

---

## Improvement 5.1: Batch Date Adjustment LLM Calls

**File:** `dreamAgent.ts:279-298`

### Current State (20 individual calls)

```typescript
// Lines 279-298: One call per memory
for (const mem of dateCandidates.slice(0, MAX_LLM_DATE_ADJUSTMENTS)) {
  const response = await api.agent.summarizeMessages(model, [
    { role: "system", content: "You are a memory cleaning assistant..." },
    { role: "user", content: `Memory created: ${mem.createdAt}\nCurrent: ${Date.now()}\nContent: ${mem.content}` },
  ]);
  // ... parse and update one memory
}
```

### Fix: Batch into 1-2 Calls

```typescript
async function batchDateAdjustments(
  memories: MemoryEntry[],
  api: DalamAPI,
  model: string
): Promise<Map<string, string>> {
  const adjustments = new Map<string, string>();
  
  // Split into batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    
    const memoryList = batch.map((m, idx) => 
      `[${idx}] Created: ${new Date(m.createdAt).toISOString()}\nContent: ${m.content}`
    ).join('\n\n');
    
    const response = await api.agent.summarizeMessages(model, [
      {
        role: "system",
        content: `You are a memory cleaning assistant. Return a JSON array.
Each item: { "id": index, "content": "updated content" }
Replace relative dates (recently, yesterday, last week, etc.) with absolute dates.
Keep the index matching the input order.`
      },
      {
        role: "user",
        content: `Current date: ${new Date().toISOString()}\n\nMemories:\n${memoryList}`
      }
    ]);
    
    const parsed = parseLLMJson<Array<{ id: number; content: string }>>(response);
    if (parsed) {
      for (const item of parsed) {
        if (item.id >= 0 && item.id < batch.length) {
          adjustments.set(batch[item.id].id, item.content);
        }
      }
    }
  }
  
  return adjustments;
}
```

### Request Reduction

- **Before:** Up to 20 LLM calls (1 per memory)
- **After:** Up to 2 LLM calls (10 memories per batch)
- **Savings:** ~90% fewer API calls

---

## Improvement 5.2: Cluster-Based Dedup Instead of Pairwise

**File:** `dreamAgent.ts:348-361`

### Current State (O(n²) pairwise)

```typescript
// Lines 348-361: Nested loop comparing every pair
for (let i = 0; i < catMemories.length; i++) {
  for (let j = i + 1; j < catMemories.length; j++) {
    const similarity = jaccardSimilarity(catMemories[i].content, catMemories[j].content);
    if (similarity > 0.55) {
      candidatePairs.push([catMemories[i], catMemories[j], similarity]);
    }
  }
}
```

### Fix: Two-Phase Clustering

```typescript
interface MemoryCluster {
  id: string;
  members: MemoryEntry[];
  centroid: string;  // Representative content
}

function clusterMemories(memories: MemoryEntry[]): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];
  const assigned = new Set<string>();
  
  // Phase 1: Quick clustering by tag overlap + category
  for (const mem of memories) {
    if (assigned.has(mem.id)) continue;
    
    const cluster: MemoryCluster = {
      id: `cluster-${clusters.length}`,
      members: [mem],
      centroid: mem.content,
    };
    
    for (const other of memories) {
      if (assigned.has(other.id) || mem.id === other.id) continue;
      
      // Quick pre-filter: same category + tag overlap
      if (mem.category === other.category) {
        const tagOverlap = mem.tags.filter(t => other.tags.includes(t)).length;
        if (tagOverlap > 0 || jaccardSimilarity(mem.content, other.content) > 0.55) {
          cluster.members.push(other);
          assigned.add(other.id);
        }
      }
    }
    
    if (cluster.members.length > 1) {
      clusters.push(cluster);
      assigned.add(mem.id);
    }
  }
  
  return clusters;
}

// Phase 2: LLM merge only for top clusters (by total access count)
async function mergeClusters(
  clusters: MemoryCluster[],
  api: DalamAPI,
  model: string,
  maxMerges: number
): Promise<number> {
  // Sort by member count * avg access count (prioritize important clusters)
  const sorted = clusters
    .filter(c => c.members.length > 1)
    .sort((a, b) => {
      const scoreA = a.members.reduce((s, m) => s + m.accessCount, 0);
      const scoreB = b.members.reduce((s, m) => s + m.accessCount, 0);
      return scoreB - scoreA;
    });
  
  let mergeCount = 0;
  
  for (const cluster of sorted.slice(0, maxMerges)) {
    // Single LLM call to merge entire cluster
    const memberList = cluster.members.map((m, idx) =>
      `[${idx}] Tier: ${m.tier}, Content: ${m.content}`
    ).join('\n\n');
    
    const response = await api.agent.summarizeMessages(model, [
      {
        role: "system",
        content: `You are a memory consolidation assistant. Merge these related memories into one.
Return JSON: { "content": "merged content", "summary": "short summary", "tags": ["tag1"], "tier": "high" }
Prefer newer information on contradictions. Combine unique facts.`
      },
      {
        role: "user",
        content: `Memories to merge:\n\n${memberList}`
      }
    ]);
    
    const parsed = parseLLMJson<{ content: string; summary: string; tags: string[]; tier: string }>(response);
    if (parsed) {
      // Save merged memory
      await saveMemory({
        category: cluster.members[0].category,
        tier: (parsed.tier as MemoryTier) || "medium",
        content: parsed.content,
        summary: parsed.summary,
        tags: parsed.tags || [],
      }, workspacePath);
      
      // Mark originals stale
      for (const member of cluster.members) {
        await markStale(member.id);
      }
      
      mergeCount++;
    }
  }
  
  return mergeCount;
}
```

### Request Reduction

- **Before:** Up to 10 LLM calls (1 per pair) + O(n²) comparison
- **After:** Up to 5 LLM calls (1 per cluster) + O(n) clustering
- **Savings:** ~50% fewer API calls + eliminated O(n²) comparison

---

## Improvement 5.3: Increase Skill Consolidation Threshold

**File:** `dreamAgent.ts:627`

### Current State

```typescript
// Line 627: Threshold too low — merges skills that are merely similar
if (similarity > 0.45) {
```

### Fix

```typescript
// Increase to 0.65 — only merge truly overlapping skills
if (similarity > 0.65) {
```

---

## Improvement 5.4: Add Rollback for Skill Consolidation

**File:** `dreamAgent.ts:654-658`

### Current State

```typescript
// Lines 654-658: No rollback if dream is cancelled mid-consolidation
writeFile(skillA.fullPath, mergedContent);
remove(oldTargetDir, { recursive: true });
```

### Fix: Backup Before Modification

```typescript
// Before consolidation, backup both skills
const backupDir = joinPath(workspacePath, ".dalam/skills-backup", Date.now().toString());
await mkdir(backupDir, { recursive: true });

// Backup skill A
const backupA = joinPath(backupDir, `${skillA.name}.md`);
await writeFile(backupA, await readFile(skillA.fullPath));

// Backup skill B
const backupB = joinPath(backupDir, `${skillB.name}.md`);
await writeFile(backupB, await readFile(skillB.fullPath));

// Perform consolidation
try {
  await writeFile(skillA.fullPath, mergedContent);
  await remove(oldTargetDir, { recursive: true });
} catch (err) {
  // Rollback on failure
  await writeFile(skillA.fullPath, await readFile(backupA));
  throw err;
}

// Clean up backup after successful consolidation (keep for 7 days)
setTimeout(() => remove(backupDir, { recursive: true }).catch(() => {}), 7 * 24 * 60 * 60 * 1000);
```

---

## Improvement 5.5: Integrate processProposals

**File:** `dreamProposalPipeline.ts:209`

### Current State

`processProposals` is defined but never called from `dreamAgent.ts`. The dream agent implements proposal routing inline.

### Fix: Replace Inline Routing with Pipeline

```typescript
// In dreamAgent.ts, replace inline routing with:
import { processProposals } from "./dreamProposalPipeline";

// After collecting all proposals:
const result = await processProposals(
  allProposals,
  async (proposal) => {
    // Apply function based on proposal type
    switch (proposal.type) {
      case "purge-stale":
        await purgeStale(workspacePath);
        break;
      case "mark-stale":
        for (const id of proposal.details.staleIds as string[]) {
          await markStale(id);
        }
        break;
      case "date-adjust":
        // ... apply date adjustments
        break;
      // ... other types
    }
  },
  notifyFn
);

return { report, proposals: result };
```

---

## Implementation Steps

1. Batch date adjustment LLM calls (20 → 2 calls)
2. Replace pairwise dedup with clustering (O(n²) → O(n))
3. Increase skill consolidation threshold from 0.45 to 0.65
4. Add backup/rollback for skill consolidation
5. Integrate `processProposals` pipeline
6. Fix dream timing to use SQLite (from Phase 0)
7. Fix in-place mutation (from Phase 0)
8. Add tests for clustering algorithm
9. Add test: verify LLM call budget is respected

---

## Success Criteria

- [ ] Date adjustment uses ≤2 LLM calls (was up to 20)
- [ ] Dedup uses clustering (no O(n²) pairwise comparison)
- [ ] Skill consolidation threshold prevents over-merging
- [ ] Skill consolidation has rollback on failure
- [ ] Proposal pipeline is used consistently
- [ ] Total LLM calls per dream cycle ≤10 (was up to 30)
