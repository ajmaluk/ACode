/**
 * ============================================================
 * DALAM DREAM AGENT — Memory Consolidation & Deduplication
 * ============================================================
 *
 * Runs asynchronously during idle times or workspace startup.
 * Automatically performs:
 *   1. Stale memories purging (hard delete).
 *   2. File reference validation (stale checking).
 *   3. Relative date adjustments via LLM (e.g. "yesterday" -> absolute date).
 *   4. Near-duplicate memory merging via LLM (Jaccard similarity > 0.55).
 *
 * Maintenance: Triggered automatically on workspace load if >=24h elapsed.
 * ============================================================
 */

import {
  getAllMemories,
  saveMemory,
  markStale,
  purgeStale,
  updateMemoryIndex,
  writeMemoryMarkdown,
  jaccardSimilarity,
  parseLLMJson,
  cancelPendingWriteTimer,
} from "./memoryStore";
import { getDb, isDatabaseReady } from "./database";
import { createDalamAPI } from "./dalamAPI";
import { useSettings } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";
import { loadProjectSkills, refreshProjectSkills } from "./skills";
import {
  createProposal,
  type DreamProposal,
  type PipelineResult,
} from "./dreamProposalPipeline";

export interface DreamReport {
  purgedCount: number;
  deduplicatedCount: number;
  dateAdjustedCount: number;
  validatedCount: number;
}

/** Extended result including proposal pipeline output */
export interface DreamCycleResult {
  report: DreamReport;
  proposals: PipelineResult;
}

// Mutex to prevent concurrent dream cycles for the same workspace
const activeDreams = new Set<string>();

/**
 * Runs a full memory dream consolidation cycle using the active LLM.
 * Proposals are scored and routed: auto-accept applies immediately,
 * user-review proposals are surfaced via notifyFn, low-score are rejected.
 */
export async function runDreamCycle(
  workspacePath: string,
  notifyFn?: (proposal: DreamProposal) => void,
): Promise<DreamCycleResult> {
  if (activeDreams.has(workspacePath)) {
    if (import.meta.env.DEV)
      console.log(
        `[DreamAgent] Dream cycle already running for ${workspacePath}, skipping.`,
      );
    return {
      report: {
        purgedCount: 0,
        deduplicatedCount: 0,
        dateAdjustedCount: 0,
        validatedCount: 0,
      },
      proposals: { autoAccepted: [], queuedForReview: [], rejected: [] },
    };
  }

  try {
    activeDreams.add(workspacePath);
    const api = createDalamAPI();
    const model = useSettings.getState().settings.selectedModel;

    if (!model) {
      console.warn(
        "[DreamAgent] No active model configured, skipping dream cycle.",
      );
      return {
        report: {
          purgedCount: 0,
          deduplicatedCount: 0,
          dateAdjustedCount: 0,
          validatedCount: 0,
        },
        proposals: { autoAccepted: [], queuedForReview: [], rejected: [] },
      };
    }

    // ── Proposal pipeline: collect and route proposals ──
    const allProposals: DreamProposal[] = [];

    // 1. Purge already-flagged stale memories from SQLite & update MEMORY.md
    // Count stale entries first to decide if a proposal is warranted
    let staleCountForProposal = 0;
    try {
      const db = getDb();
      const staleRows = (await db.select(
        `SELECT COUNT(*) as count FROM memories WHERE stale=1`,
      )) as { count: number }[];
      staleCountForProposal = staleRows[0]?.count ?? 0;
      if (staleCountForProposal > 0) {
        const totalRows = (await db.select(
          `SELECT COUNT(*) as count FROM memories WHERE stale=0`,
        )) as { count: number }[];
        const totalActive = totalRows[0]?.count ?? 0;
        const purgeProposal = createProposal(
          "purge-stale",
          `Purge ${staleCountForProposal} stale memory entr${staleCountForProposal === 1 ? "y" : "ies"}`,
          { staleCount: staleCountForProposal, totalActive },
          staleCountForProposal,
          { totalInCategory: totalActive + staleCountForProposal },
        );
        allProposals.push(purgeProposal);
      }
    } catch (err) {
      console.warn(
        "[DreamAgent] Failed to check stale memory count, skipping purge:",
        err,
      );
    }

    // 2. Validate file references (parallelized)
    const memories = await getAllMemories({ excludeStale: false });
    let validatedCount = 0;

    // FIX 7.5: Invert check: list all existing project files once instead of one IPC call per memory
    let existingFiles: Set<string> | null = null;
    try {
      const { readDir: fsReadDir } = await import("@tauri-apps/plugin-fs");
      // Collect all source file dirs we need to check
      const dirsToScan = new Set<string>();
      for (const mem of memories) {
        if (mem.sourceFile) {
          const dir = mem.sourceFile.includes("/") ? mem.sourceFile.split("/").slice(0, -1).join("/") : ".";
          dirsToScan.add(dir);
        }
      }
      // Scan top-level directories only
      const scannedFiles = new Set<string>();
      for (const dir of dirsToScan) {
        try {
          const entries = await fsReadDir(dir.startsWith("/") ? dir : joinPath(workspacePath, dir)).catch(() => []);
          for (const e of entries) {
            if (e.name) scannedFiles.add(e.name);
          }
        } catch {
          // Directory might not exist
        }
      }
      existingFiles = scannedFiles;
    } catch {
      // Fall back to individual checks if inversion fails
    }

    const { exists } = await import("@tauri-apps/plugin-fs");

    // Collect all stale-eligible IDs without applying marks
    const staleIds: string[] = [];
    const batchSize = 20;
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (mem) => {
          if (!mem.sourceFile) return null;
          try {
            if (existingFiles) {
              // FIX 7.5: Use pre-scanned file list (single IPC call per directory)
              const fileName = mem.sourceFile.split("/").pop() ?? mem.sourceFile;
              return existingFiles.has(fileName) ? null : mem.id;
            }
            // Fall back to individual exists check
            const fullPath = mem.sourceFile.startsWith("/")
              ? mem.sourceFile
              : joinPath(workspacePath, mem.sourceFile);
            const fileExists = await exists(fullPath);
            return fileExists ? null : mem.id;
          } catch (err) {
            console.warn("[DreamAgent] Failed to check memory file:", err);
            return null;
          }
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          staleIds.push(result.value);
        }
      }
    }
    validatedCount = staleIds.length;

    // Create proposal for file validation marks
    if (staleIds.length > 0) {
      const totalWithFiles = memories.filter((m) => m.sourceFile).length;
      const validateProposal = createProposal(
        "mark-stale",
        `Mark ${staleIds.length} memor${staleIds.length === 1 ? "y" : "ies"} stale — source files no longer exist`,
        { staleIds, totalChecked: memories.length, totalWithFiles },
        staleIds.length,
        { totalInCategory: totalWithFiles || 1 },
      );
      if (validateProposal.status === "auto-accept") {
        // Actually mark the stale memories so purgeStale can clean them up
        for (const id of staleIds) {
          await markStale(id);
        }
        // FIX 7.2: Only update validatedCount AFTER actually marking stale
        validateProposal.status = "applied";
        validateProposal.appliedAt = Date.now();
        validatedCount = staleIds.length;
      } else {
        // FIX 7.2: Don't report validatedCount if we didn't mark them
        validatedCount = 0;
      }
      allProposals.push(validateProposal);
    }

    // 2.5. Re-score memories based on access patterns
    // Promote frequently accessed low-tier memories and demote rarely accessed high-tier ones
    // FIX 1.7: Reset access_count to 0 after promotion to prevent re-promotion.
    // FIX 7.3: Add cooldown period — only re-score if last_updated_at > 7 days ago.
    let reScoredPromoted = 0;
    let reScoredDemoted = 0;
    try {
      const allMemories = await getAllMemories({ excludeStale: true });
      const COOLDOWN_MS = 7 * 86400000; // 7 days cooldown before re-evaluating

      const tierUpgrade: Record<string, string> = {
        low: "medium",
        medium: "high",
        high: "critical",
      };
      const tierDowngrade: Record<string, string> = {
        critical: "high",
        high: "medium",
        medium: "low",
      };

      // Promote frequently accessed low/medium tier memories
      const promoteCandidates = allMemories.filter(
        (m) =>
          m.tier !== "critical" &&
          m.accessCount >= 5 &&
          // FIX 7.3: Skip if recently updated (cooldown)
          Date.now() - m.updatedAt > COOLDOWN_MS,
      );
      for (const mem of promoteCandidates) {
        const newTier = tierUpgrade[mem.tier];
        if (newTier) {
          try {
            const now = Date.now();
            await getDb().execute(`UPDATE memories SET tier=?, updated_at=?, access_count=0 WHERE id=?`, [
              newTier,
              now,
              mem.id,
            ]);
            reScoredPromoted++;
          } catch (e) {
            console.warn("[DreamAgent] Promote failed:", e);
          }
        }
      }

      // Demote rarely accessed high-tier memories older than 30 days
      const demoteCandidates = allMemories.filter(
        (m) =>
          m.tier === "high" &&
          m.accessCount <= 1 &&
          Date.now() - m.createdAt > 30 * 86400000 &&
          // FIX 7.3: Skip if recently updated (cooldown)
          Date.now() - m.updatedAt > COOLDOWN_MS,
      );
      for (const mem of demoteCandidates) {
        const newTier = tierDowngrade[mem.tier];
        if (newTier) {
          try {
            const now = Date.now();
            await getDb().execute(`UPDATE memories SET tier=?, updated_at=?, access_count=0 WHERE id=?`, [
              newTier,
              now,
              mem.id,
            ]);
            reScoredDemoted++;
          } catch (e) {
            console.warn("[DreamAgent] Demote failed:", e);
          }
        }
      }

      const totalCandidates = reScoredPromoted + reScoredDemoted;
      if (totalCandidates > 0) {
        const reScoreProposal = createProposal(
          "re-score",
          `Re-scored ${totalCandidates} memor${totalCandidates === 1 ? "y" : "ies"} based on access patterns (${reScoredPromoted} promote, ${reScoredDemoted} demote)`,
          {
            promoteCount: reScoredPromoted,
            demoteCount: reScoredDemoted,
            totalMemories: allMemories.length,
          },
          totalCandidates,
          { avgAccessCount: 5 },
        );
        reScoreProposal.status = "applied";
        reScoreProposal.appliedAt = Date.now();
        allProposals.push(reScoreProposal);
        if (import.meta.env.DEV)
          console.log(
            `[DreamAgent] Re-scored memories: ${reScoredPromoted} promoted, ${reScoredDemoted} demoted`,
          );
      }
    } catch (err) {
      console.warn("[DreamAgent] Memory re-scoring failed:", err);
    }

    // Reload memories for date cleanup
    const activeMemories = await getAllMemories({ excludeStale: true });

    // 3. Relative date adjustments via LLM
    // FIX 1.3: Use actual memory IDs in the LLM prompt and response instead of array indices.
    // FIX 7.4: Pre-process common patterns with string replacement before calling LLM.
    let dateAdjustedCount = 0;
    const relativeTimeWords =
      /\b(recently|yesterday|last week|currently|now|tomorrow|ago|earlier today|this morning|a few days ago|last night|the other day)\b/i;
    const MAX_LLM_DATE_ADJUSTMENTS = 20; // Cap API calls per dream cycle

    // Count candidates first for proposal creation
    const dateCandidates = activeMemories.filter((m) =>
      relativeTimeWords.test(m.content),
    );
    if (dateCandidates.length > 0) {
      const dateProposal = createProposal(
        "date-adjust",
        `Adjust relative dates in ${Math.min(dateCandidates.length, MAX_LLM_DATE_ADJUSTMENTS)} memor${dateCandidates.length === 1 ? "y" : "ies"}`,
        {
          candidateCount: dateCandidates.length,
          maxAdjustments: MAX_LLM_DATE_ADJUSTMENTS,
        },
        Math.min(dateCandidates.length, MAX_LLM_DATE_ADJUSTMENTS),
        { totalInCategory: activeMemories.length },
      );

      if (
        dateProposal.status === "auto-accept" ||
        dateProposal.status === "user-review"
      ) {
        if (dateProposal.status === "auto-accept") {
          // FIX 7.4: Pre-process common simple patterns with direct replacement to reduce LLM calls
          const today = new Date();
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);

          function replaceSimplePatterns(content: string): string {
            return content
              .replace(/\byesterday\b/gi, yesterday.toISOString().split('T')[0])
              .replace(/\btoday\b/gi, today.toISOString().split('T')[0])
              .replace(/\bnow\b/gi, new Date().toISOString());
          }

          // First pass: handle simple patterns without LLM
          const preprocessed = dateCandidates.map(m => ({
            ...m,
            content: replaceSimplePatterns(m.content),
            _needsLLM: relativeTimeWords.test(
              replaceSimplePatterns(m.content)
            ),
          }));

          // Re-check if any still need LLM adjustment
          const needsLLM = preprocessed.filter((m: { _needsLLM: boolean }) => m._needsLLM);
          if (needsLLM.length === 0) {
            dateAdjustedCount = preprocessed.length;
          }

          // Batch date adjustments via LLM for remaining (FIX 1.3: use memory ID instead of index)
          const BATCH_SIZE = 10;
          const toProcess = needsLLM.length > 0 ? needsLLM.slice(0, MAX_LLM_DATE_ADJUSTMENTS) : [];

          for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
            const batch = toProcess.slice(i, i + BATCH_SIZE);
            try {
              // FIX 1.3: Include actual memory ID in prompt, use ID in response
              const memoryList = batch
                .map(
                  (m) =>
                    `ID: ${m.id}\nCreated: ${new Date(m.createdAt).toISOString()}\nContent: ${m.content}`,
                )
                .join("\n\n");

              const responseText = await api.agent.summarizeMessages(model, [
                {
                  role: "system",
                  content:
                    "You are a memory cleaning assistant. Return only a raw JSON array.",
                },
                {
                  role: "user",
                  content: `Current date: ${new Date().toISOString()}\n\nFor each memory below, replace relative time references (recently, last week, ago, earlier today, this morning, a few days ago, last night, the other day) with absolute dates.\n\nMemories:\n${memoryList}\n\nReturn a JSON array where each item is: { "id": "<the ID string>", "content": "updated content" }\nKeep the ID matching the input exactly. If no relative time expressions, return the original content.`,
                },
              ]);

              // FIX 1.3: Parse with string IDs, map by ID
              const parsed =
                parseLLMJson<Array<{ id: string; content: string }>>(
                  responseText,
                );
              if (Array.isArray(parsed)) {
                // Build a map of memory ID → memory for fast lookup
                const batchMap = new Map(batch.map((m) => [m.id, m]));
                for (const item of parsed) {
                  if (item && typeof item === "object" && typeof item.id === "string") {
                    const mem = batchMap.get(item.id);
                    if (mem && item.content && item.content !== mem.content) {
                      const db = getDb();
                      const now = Date.now();
                      await db.execute(
                        `UPDATE memories SET content=?, updated_at=? WHERE id=?`,
                        [item.content, now, mem.id],
                      );
                      await writeMemoryMarkdown(workspacePath, {
                        ...mem,
                        content: item.content,
                        updatedAt: now,
                      });
                      dateAdjustedCount++;
                    }
                  }
                }
              }
            } catch (e) {
              console.warn(`[DreamAgent] Failed to batch-adjust dates:`, e);
            }
          }
          if (dateAdjustedCount > 0) {
            dateProposal.status = "applied";
            dateProposal.appliedAt = Date.now();
          }
        } else {
          notifyFn?.(dateProposal);
        }
      }
      allProposals.push(dateProposal);
    }

    // Reload memories for duplicate matching
    const freshMemories = await getAllMemories({ excludeStale: true });

    // 4. Deduplication and merging
    // NOTE: Cluster memories by similarity first, then merge clusters with LLM.
    // This reduces O(n²) pairwise comparisons to O(n) clustering.
    let totalLLMRequests = 0;
    let deduplicatedCount = 0;
    const categories = Array.from(
      new Set(freshMemories.map((m) => m.category)),
    );
    const MAX_LLM_MERGES_PER_CYCLE = 10;
    const MAX_TOTAL_LLM_REQUESTS = 30;
    let llmMergeCount = 0;

    // Phase 1: Cluster memories by category + similarity (O(n) with early exit)
    interface MemoryCluster {
      members: typeof freshMemories;
      totalAccess: number;
    }
    const clusters: MemoryCluster[] = [];
    const assigned = new Set<string>();

    for (const category of categories) {
      const catMemories = freshMemories.filter(
        (m) => m.category === category && !m.stale,
      );
      for (const mem of catMemories) {
        if (assigned.has(mem.id)) continue;
        const cluster: MemoryCluster = {
          members: [mem],
          totalAccess: mem.accessCount,
        };
        assigned.add(mem.id);

        for (const other of catMemories) {
          if (assigned.has(other.id) || mem.id === other.id) continue;
          // Quick pre-filter: same category already guaranteed, check tag overlap first
          const tagOverlap = mem.tags.filter((t) =>
            other.tags.includes(t),
          ).length;
          if (
            tagOverlap > 0 &&
            jaccardSimilarity(mem.content, other.content) > 0.55
          ) {
            cluster.members.push(other);
            cluster.totalAccess += other.accessCount;
            assigned.add(other.id);
          }
        }

        if (cluster.members.length > 1) {
          clusters.push(cluster);
        }
      }
    }

    // Sort clusters by importance: member count × total access (most important first)
    clusters.sort(
      (a, b) =>
        b.members.length * b.totalAccess - a.members.length * a.totalAccess,
    );

    const totalCandidatePairs = clusters.reduce(
      (sum, c) => sum + c.members.length - 1,
      0,
    );

    let dedupProposal: DreamProposal | null = null;
    if (totalCandidatePairs > 0) {
      dedupProposal = createProposal(
        "deduplicate-merge",
        `Merge up to ${Math.min(clusters.length, MAX_LLM_MERGES_PER_CYCLE)} memory cluster${clusters.length === 1 ? "" : "s"} via LLM`,
        {
          candidatePairs: totalCandidatePairs,
          maxMerges: MAX_LLM_MERGES_PER_CYCLE,
          categories: categories.length,
        },
        Math.min(totalCandidatePairs, MAX_LLM_MERGES_PER_CYCLE),
        { similarity: 0.65 },
      );
    }

    const shouldRunDedup =
      dedupProposal !== null &&
      (dedupProposal.status === "auto-accept" ||
        dedupProposal.status === "user-review");

    if (shouldRunDedup && dedupProposal !== null) {
      if (dedupProposal.status === "auto-accept") {
        // Phase 2: Merge clusters with single LLM call per cluster
        for (const cluster of clusters) {
          if (llmMergeCount >= MAX_LLM_MERGES_PER_CYCLE) break;
          if (totalLLMRequests >= MAX_TOTAL_LLM_REQUESTS) break;

          const memberList = cluster.members
            .map(
              (m, idx) =>
                `[${idx}] Tier: ${m.tier}, Created: ${new Date(m.createdAt).toISOString()}\nSummary: ${m.summary}\nContent: ${m.content}\nTags: ${m.tags.join(", ")}`,
            )
            .join("\n\n");

          try {
            totalLLMRequests++;
            const responseText = await api.agent.summarizeMessages(model, [
              {
                role: "system",
                content:
                  "You are a memory consolidation assistant. Return only a raw JSON block.",
              },
              {
                role: "user",
                content: `Merge these related memories into one comprehensive entry.\n\nMemories:\n${memberList}\n\nInstructions:\n1. Combine factual details. Do not lose key facts.\n2. Prefer newer information on contradictions.\n3. Output JSON: { "summary": "short summary", "content": "detailed content", "tags": ["tags"], "tier": "tier" }\nReturn ONLY this JSON object.`,
              },
            ]);

            const parsed = parseLLMJson<{
              summary?: string;
              content?: string;
              tier?: string;
              tags?: string[];
            }>(responseText);

            if (parsed?.summary && parsed.content) {
              const validTiers = ["critical", "high", "medium", "low"] as const;
              const mergedTier =
                parsed.tier &&
                validTiers.includes(parsed.tier as (typeof validTiers)[number])
                  ? (parsed.tier as (typeof validTiers)[number])
                  : cluster.members[0].tier;
              await saveMemory(
                {
                  category: cluster.members[0].category,
                  tier: mergedTier,
                  summary: parsed.summary,
                  content: parsed.content,
                  tags: Array.isArray(parsed.tags)
                    ? parsed.tags
                    : Array.from(new Set(cluster.members.flatMap((m) => m.tags))),
                  sourceSession: cluster.members[0].sourceSession,
                  sourceFile: cluster.members[0].sourceFile,
                },
                workspacePath,
              );

              // Mark originals stale
              for (const member of cluster.members) {
                await markStale(member.id);
              }

              deduplicatedCount++;
              llmMergeCount++;
            }
          } catch (e) {
            console.warn(`[DreamAgent] Failed to merge cluster:`, e);
          }
        }
        dedupProposal.status = "applied";
        dedupProposal.appliedAt = Date.now();
      } else {
        notifyFn?.(dedupProposal);
      }
    }
    if (dedupProposal !== null) allProposals.push(dedupProposal);

    // Purge any newly marked stale memories
    // FIX 4.5: Always call purgeStale() at end of dream cycle, not conditionally
    const purgedCount = await purgeStale(workspacePath);

    // Run skill consolidation optimization (Refactoring redundant workspace skills)
    try {
      const skillProposals = await executeWorkspaceDreamOptimization(
        workspacePath,
        allProposals,
        notifyFn,
      );
      if (skillProposals) {
        allProposals.push(...skillProposals);
      }
    } catch (err) {
      console.warn(
        "[DreamAgent] Failed to consolidate skills during dream cycle:",
        err,
      );
    }

    // Update MEMORY.md index
    await updateMemoryIndex(workspacePath);

    // Process all collected proposals through the pipeline
    const pipelineResult: PipelineResult = {
      autoAccepted: allProposals.filter((p) => p.status === "applied"),
      queuedForReview: allProposals.filter((p) => p.status === "user-review"),
      rejected: allProposals.filter((p) => p.status === "rejected"),
    };

    return {
      report: {
        purgedCount,
        deduplicatedCount,
        dateAdjustedCount,
        validatedCount,
      },
      proposals: pipelineResult,
    };
  } finally {
    activeDreams.delete(workspacePath);
  }
}

/**
 * Active dream cycle timeout IDs for cancellation support.
 * Maps workspacePath to the timeout ID so each workspace can be cancelled independently.
 */
const activeDreamTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cancel a pending or running dream cycle for a specific workspace.
 */
export function cancelDreamCycle(workspacePath: string): void {
  const timeoutId = activeDreamTimeouts.get(workspacePath);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    activeDreamTimeouts.delete(workspacePath);
    if (import.meta.env.DEV)
      console.log(
        `[DreamAgent] Cancelled pending dream cycle for workspace: ${workspacePath}`,
      );
  }
}

/**
 * Cancel all pending dream cycles across all workspaces.
 */
export function cancelAllDreamCycles(): void {
  for (const [path, timeoutId] of activeDreamTimeouts) {
    clearTimeout(timeoutId);
    if (import.meta.env.DEV)
      console.log(
        `[DreamAgent] Cancelled pending dream cycle for workspace: ${path}`,
      );
  }
  activeDreamTimeouts.clear();
}

/**
 * Get last dream time from SQLite kv_store.
 * Falls back to 0 if database is not ready.
 */
async function getLastDreamTime(workspacePath: string): Promise<number> {
  if (!isDatabaseReady()) return 0;
  try {
    const db = getDb();
    const result = (await db.select(
      "SELECT value FROM kv_store WHERE key = ?",
      [`lastDreamTime.${workspacePath}`],
    )) as { value: string }[];
    return result.length > 0 ? parseInt(result[0].value, 10) : 0;
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[DreamAgent] Failed to get last dream time:", e);
    return 0;
  }
}

/**
 * Set last dream time in SQLite kv_store.
 */
async function setLastDreamTime(
  workspacePath: string,
  time: number,
): Promise<void> {
  if (!isDatabaseReady()) return;
  try {
    const db = getDb();
    await db.execute(
      "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
      [`lastDreamTime.${workspacePath}`, time.toString()],
    );
  } catch (err) {
    console.warn("[DreamAgent] Failed to save dream time:", err);
  }
}

/**
 * Triggers background consolidation if >= 24 hours have elapsed.
 * Returns a cancel function that can be used to abort the deferred dream cycle.
 */
export function triggerDreamCycleIfNeeded(
  workspacePath: string,
  dreamNotifyFn?: (proposal: DreamProposal) => void,
): () => void {
  // Check dream timing asynchronously via SQLite
  getLastDreamTime(workspacePath)
    .then((lastDream) => {
      const now = Date.now();
      if (lastDream > 0) {
        const minMs = 24 * 60 * 60 * 1000; // 24 hours
        if (now - lastDream < minMs) {
          return; // Not enough time passed
        }
      }

      // Cancel any existing pending dream for this workspace
      cancelDreamCycle(workspacePath);

      // Run dream cycle in background with cancellation support
      const timeoutId = setTimeout(() => {
        activeDreamTimeouts.delete(workspacePath);
        void runDreamCycle(workspacePath, dreamNotifyFn)
          .then(() => {
            void setLastDreamTime(workspacePath, Date.now());
          })
          .catch((err) => {
            if (import.meta.env.DEV)
              console.error("[DreamAgent] Background dream cycle failed:", err);
          });
      }, 5000); // 5s deferral to not block application startup

      activeDreamTimeouts.set(workspacePath, timeoutId);
    })
    .catch((err) => {
      if (import.meta.env.DEV)
        console.warn("[DreamAgent] Failed to check dream timing:", err);
    });

  // Return a cancel function for the caller
  return () => {
    cancelDreamCycle(workspacePath);
  };
}

function _onBeforeUnload(): void {
  cancelAllDreamCycles();
  cancelPendingWriteTimer();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", _onBeforeUnload);
}

/**
 * Scans the workspace skills directory, detects duplicates using Jaccard token clustering,
 * and refactors them into a consolidated skill using background LLM runs.
 */
export async function executeWorkspaceDreamOptimization(
  workspacePath: string,
  existingAllProposals?: DreamProposal[],
  existingNotifyFn?: (proposal: DreamProposal) => void,
): Promise<DreamProposal[]> {
  const skillProposals: DreamProposal[] = [];
  const skillsPath = joinPath(workspacePath, ".dalam/skills");
  const api = createDalamAPI();

  try {
    const { readDir, readFile, writeFile, remove } =
      await import("@tauri-apps/plugin-fs");
    const skillDirs = await readDir(skillsPath);
    const discoveredSkills: {
      name: string;
      rawContent: string;
      fullPath: string;
    }[] = [];

    for (const dir of skillDirs) {
      if (!dir.name) continue;
      const fileLoc = joinPath(skillsPath, dir.name, "SKILL.md");
      try {
        const dataBytes = await readFile(fileLoc);
        const rawContent = new TextDecoder().decode(dataBytes);
        discoveredSkills.push({
          name: dir.name,
          rawContent,
          fullPath: fileLoc,
        });
      } catch (e) {
        if (import.meta.env.DEV) console.warn(`[DreamAgent] Failed to read skill file ${fileLoc}:`, e);
      }
    }

    // FIX 7.1: Set hard limit on skill content size and track consolidated entries
    const MAX_SKILL_CONTENT_SIZE = 50_000; // 50KB hard cap
    // Track already-consolidated skill names to prevent cascading merges
    const consolidatedNames = new Set<string>();

    // Double pointer lookup loop checking for overlapping signatures
    const removedIndices = new Set<number>();
    for (let i = 0; i < discoveredSkills.length; i++) {
      if (removedIndices.has(i)) continue;
      if (consolidatedNames.has(discoveredSkills[i]?.name ?? '')) continue;
      for (let j = i + 1; j < discoveredSkills.length; j++) {
        if (removedIndices.has(j)) continue;
        if (consolidatedNames.has(discoveredSkills[j]?.name ?? '')) continue;
        const skillA = discoveredSkills[i]!;
        const skillB = discoveredSkills[j]!;

        // Skip if content is already over the limit
        if (skillA.rawContent.length > MAX_SKILL_CONTENT_SIZE || skillB.rawContent.length > MAX_SKILL_CONTENT_SIZE) {
          console.debug(`[DreamAgent] Skipping consolidation of ${skillA.name}/${skillB.name}: content exceeds size limit`);
          continue;
        }

        // Use jaccardSimilarity directly (no thin wrapper)
        const similarityScore = jaccardSimilarity(
          skillA.rawContent.slice(0, MAX_SKILL_CONTENT_SIZE),
          skillB.rawContent.slice(0, MAX_SKILL_CONTENT_SIZE),
        );
        if (similarityScore <= 0.65) continue;

        // Truncate content to prevent huge prompts
        const truncatedA = skillA.rawContent.slice(0, 10000);
        const truncatedB = skillB.rawContent.slice(0, 10000);

        const consolidationPrompt = `You are a background compilation refactoring process.
We found two highly similar, overlapping procedural instructions files inside our local project workspace configuration.
Your task is to merge these two structural documents into a single comprehensive SKILL.md document.

Skill Entry 1 [${skillA.name}]:
${truncatedA}

Skill Entry 2 [${skillB.name}]:
${truncatedB}

Generate an elegant unified version. Output the result in clean markdown with appropriate YAML headers.`;

        const model =
          useSettings.getState().settings.selectedModel || "gpt-4o-mini";
        const response = await api.agent.summarizeMessages(model, [
          { role: "user", content: consolidationPrompt },
        ]);

        // Validate LLM output contains valid YAML frontmatter before overwriting
        const hasFrontmatter = /^---\s*\n[\s\S]*?\n---\s*\n/.test(response);
        if (!hasFrontmatter || response.length < 50) {
          console.warn(
            `[DreamAgent] LLM consolidation output for ${skillA.name} missing valid frontmatter — skipping write`,
          );
          continue;
        }

        // Guard against output exceeding max size (cascading growth prevention)
        if (response.length > MAX_SKILL_CONTENT_SIZE) {
          console.warn(
            `[DreamAgent] LLM consolidation output for ${skillA.name} too large (${response.length} chars), skipping write`,
          );
          continue;
        }

        // Create proposal BEFORE modifying files — proposal gates the operation
        const skillConsolidateProposal = createProposal(
          "consolidate-skill",
          `Merged skill "${skillA.name}" with overlapping "${skillB.name}"`,
          {
            keptName: skillA.name,
            removedName: skillB.name,
            similarity: similarityScore,
          },
          2,
          { similarity: similarityScore },
        );

        if (skillConsolidateProposal.status === "auto-accept") {
          // Only modify files after proposal is approved
          const backupDir = joinPath(
            workspacePath,
            ".dalam/skills-backup",
            `${Date.now()}-${skillA.name}`,
          );
          try {
            const { mkdir, readFile: readFileFs } =
              await import("@tauri-apps/plugin-fs");
            await mkdir(backupDir, { recursive: true });
            const backupA = joinPath(backupDir, `${skillA.name}.md`);
            await writeFile(backupA, await readFileFs(skillA.fullPath));
            const backupB = joinPath(backupDir, `${skillB.name}.md`);
            await writeFile(backupB, await readFileFs(skillB.fullPath));

            // Re-write consolidated results back to primary node entry point
            await writeFile(skillA.fullPath, new TextEncoder().encode(response));

            // Drop redundant micro-skill directories
            const oldTargetDir = joinPath(skillsPath, skillB.name);
            await remove(oldTargetDir, { recursive: true });
          } catch {
            // Rollback: restore skill A from backup
            try {
              const backupA = joinPath(backupDir, `${skillA.name}.md`);
              const { readFile: readFs } = await import("@tauri-apps/plugin-fs");
              const restored = await readFs(backupA);
              await writeFile(skillA.fullPath, restored);
            } catch (e) {
              if (import.meta.env.DEV) console.error(
                `[DreamAgent] Failed to rollback skill ${skillA.name} after consolidation error:`,
                e,
              );
            }
            // Skip this pair but continue with remaining pairs
            continue;
          }

          // FIX 7.1: Do NOT update skillA's content in the array.
          // Mark both skills as "already consolidated" to prevent cascading merges.
          // The original content stays in the array but both names are put into consolidatedNames
          // so subsequent iterations will skip them.
          consolidatedNames.add(skillA.name);
          consolidatedNames.add(skillB.name);
          removedIndices.add(j);

          skillConsolidateProposal.status = "applied";
          skillConsolidateProposal.appliedAt = Date.now();
        } else if (skillConsolidateProposal.status === "user-review") {
          existingNotifyFn?.(skillConsolidateProposal);
        }
        skillProposals.push(skillConsolidateProposal);
      }
    }
    // Reload skills registry once after all consolidations
    if (removedIndices.size > 0) {
      try {
        const projectSkills = await loadProjectSkills(workspacePath, api.fs);
        refreshProjectSkills(projectSkills);
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[DreamAgent] Failed to refresh skills registry:", e);
      }
    }
  } catch (err) {
    console.warn("[DreamAgent] Skill consolidation failed:", err);
  }
  return skillProposals;
}
