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
} from "./memoryStore";
import { getDb } from "./database";
import { createDalamAPI } from "./dalamAPI";
import { useSettings } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";
import { loadProjectSkills, refreshProjectSkills } from "./skills";

export interface DreamReport {
  purgedCount: number;
  deduplicatedCount: number;
  dateAdjustedCount: number;
  validatedCount: number;
}

// Mutex to prevent concurrent dream cycles for the same workspace
const activeDreams = new Set<string>();

/**
 * Runs a full memory dream consolidation cycle using the active LLM.
 */
export async function runDreamCycle(workspacePath: string): Promise<DreamReport> {
  if (activeDreams.has(workspacePath)) {
    console.log(`[DreamAgent] Dream cycle already running for ${workspacePath}, skipping.`);
    return { purgedCount: 0, deduplicatedCount: 0, dateAdjustedCount: 0, validatedCount: 0 };
  }
  activeDreams.add(workspacePath);

  try {
    const api = createDalamAPI();
    const model = useSettings.getState().settings.selectedModel;

    if (!model) {
      console.warn("[DreamAgent] No active model configured, skipping dream cycle.");
      return { purgedCount: 0, deduplicatedCount: 0, dateAdjustedCount: 0, validatedCount: 0 };
    }

    // 1. Purge already-flagged stale memories from SQLite & update MEMORY.md
    const purgedCount = await purgeStale();

    // 2. Validate file references (parallelized)
    const memories = await getAllMemories({ excludeStale: false });
    let validatedCount = 0;
    const { exists } = await import("@tauri-apps/plugin-fs");

    // Check file existence in parallel batches of 20
    const batchSize = 20;
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (mem) => {
          if (!mem.sourceFile) return null;
          try {
            const fullPath = mem.sourceFile.startsWith("/")
              ? mem.sourceFile
              : joinPath(workspacePath, mem.sourceFile);
            const fileExists = await exists(fullPath);
            return fileExists ? null : mem.id;
          } catch (err) {
            console.warn("[DreamAgent] Failed to check memory file:", err);
            return null;
          }
        })
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          await markStale(result.value);
          validatedCount++;
        }
      }
    }

    // 2.5. Re-score memories based on access patterns
    // Promote frequently accessed low-tier memories and demote rarely accessed high-tier ones
    try {
      const { scoreMemory } = await import("./memoryStore");
      const db = getDb();
      const allMemories = await getAllMemories({ excludeStale: true });
      let promoted = 0;
      let demoted = 0;

      for (const mem of allMemories) {
        const score = scoreMemory(mem);
        const oldTier = mem.tier;

        // Promote: frequently accessed low/medium tier memories
        if (oldTier !== "critical" && mem.accessCount >= 5 && score > 40) {
          const newTier = oldTier === "low" ? "medium" : "high";
          await db.execute(
            `UPDATE memories SET tier=?, updated_at=? WHERE id=?`,
            [newTier, Date.now(), mem.id]
          );
          promoted++;
        }
        // Demote: rarely accessed high-tier memories older than 30 days
        else if (oldTier === "high" && mem.accessCount <= 1 && (Date.now() - mem.createdAt) > 30 * 86400000) {
          await db.execute(
            `UPDATE memories SET tier=?, updated_at=? WHERE id=?`,
            ["medium", Date.now(), mem.id]
          );
          demoted++;
        }
      }
      if (promoted > 0 || demoted > 0) {
        console.log(`[DreamAgent] Re-scored memories: ${promoted} promoted, ${demoted} demoted`);
      }
    } catch (err) {
      console.warn("[DreamAgent] Memory re-scoring failed:", err);
    }

    // Reload memories for date cleanup
    const activeMemories = await getAllMemories({ excludeStale: true });

    // 3. Relative date adjustments via LLM
    // NOTE: Each memory has unique content and creation timestamp, requiring individual LLM calls.
    // Batching is not feasible here because the prompt includes memory-specific timestamps and
    // content that must be processed independently to produce accurate absolute date replacements.
    let dateAdjustedCount = 0;
    const relativeTimeWords = /\b(recently|yesterday|last week|currently|now|tomorrow|ago|earlier today|this morning|a few days ago|last night|the other day)\b/i;
    const MAX_LLM_DATE_ADJUSTMENTS = 20; // Cap API calls per dream cycle

    for (const mem of activeMemories) {
      if (dateAdjustedCount >= MAX_LLM_DATE_ADJUSTMENTS) break;
      if (relativeTimeWords.test(mem.content)) {
        try {
          const prompt = `You are a memory cleaning assistant.
This memory was recorded at: ${new Date(mem.createdAt).toISOString()} (Unix timestamp: ${mem.createdAt}).
The current time is: ${new Date().toISOString()}.

Memory content:
"${mem.content}"

Instructions:
If the memory content contains relative time references (like "recently", "yesterday", "last week", "currently", "now", "tomorrow", "ago"), rewrite them to be absolute or date-anchored so they don't become incorrect over time (e.g. "implemented yesterday" -> "implemented on ${new Date(mem.createdAt - 24 * 60 * 60 * 1000).toISOString().split('T')[0]}").
If no relative time expressions are present, return the original content exactly.

Output JSON format:
{
  "content": "Updated content"
}
Return ONLY this JSON object. No markdown syntax or explanation.`;

          const responseText = await api.agent.summarizeMessages(model, [
            { role: "system", content: "You are a memory cleaning assistant. Return only a raw JSON block." },
            { role: "user", content: prompt }
          ]);

          const parsed = parseLLMJson<{ content?: string }>(responseText);
          if (parsed?.content && parsed.content !== mem.content) {
            const db = getDb();
            const now = Date.now();
            await db.execute(
              `UPDATE memories SET content=?, updated_at=? WHERE id=?`,
              [parsed.content, now, mem.id]
            );
            // Overwrite the markdown file to keep it in sync
            await writeMemoryMarkdown(workspacePath, {
              ...mem,
              content: parsed.content,
              updatedAt: now
            });
            dateAdjustedCount++;
          }
        } catch (e) {
          console.warn(`[DreamAgent] Failed to adjust dates for memory ${mem.id}:`, e);
        }
      }
    }

    // Reload memories for duplicate matching
    const freshMemories = await getAllMemories({ excludeStale: true });

    // 4. Deduplication and merging
    // NOTE: Each memory pair has unique content requiring individual LLM merge calls.
    // Sequential processing is required because: (1) each pair produces a unique merged
    // result, (2) marking memories as stale mid-loop affects subsequent comparisons,
    // and (3) the LLM needs full context of both memories to produce a coherent merge.
    let deduplicatedCount = 0;
    const categories = Array.from(new Set(freshMemories.map(m => m.category)));
    // Cap LLM merge calls per dream cycle to prevent excessive API usage
    const MAX_LLM_MERGES_PER_CYCLE = 10;
    let llmMergeCount = 0;

    for (const category of categories) {
      if (llmMergeCount >= MAX_LLM_MERGES_PER_CYCLE) break;
      const catMemories = freshMemories.filter(m => m.category === category);
      for (let i = 0; i < catMemories.length; i++) {
        if (llmMergeCount >= MAX_LLM_MERGES_PER_CYCLE) break;
        for (let j = i + 1; j < catMemories.length; j++) {
          if (llmMergeCount >= MAX_LLM_MERGES_PER_CYCLE) break;
          const m1 = catMemories[i];
          const m2 = catMemories[j];
          if (m1.stale || m2.stale) continue;

          const similarity = jaccardSimilarity(m1.content, m2.content);
          if (similarity > 0.55) {
            try {
              const prompt = `You are a memory consolidation assistant. Your task is to merge two related memory entries into a single, comprehensive memory entry.

Memory 1 (Created: ${new Date(m1.createdAt).toISOString()}):
Summary: ${m1.summary}
Content: ${m1.content}
Tags: ${m1.tags.join(", ")}
Category: ${m1.category}
Tier: ${m1.tier}

Memory 2 (Created: ${new Date(m2.createdAt).toISOString()}):
Summary: ${m2.summary}
Content: ${m2.content}
Tags: ${m2.tags.join(", ")}
Category: ${m2.category}
Tier: ${m2.tier}

Instructions:
1. Combine the factual details of both entries. Do not lose key facts or context.
2. If there are contradictions, prefer the newer entry.
3. Produce a consolidated memory entry.
4. Output the result in the following JSON format:
{
  "summary": "Short consolidated summary (<= 150 chars)",
  "content": "Detailed consolidated content",
  "tags": ["consolidated", "tags"],
  "tier": "tier (critical|high|medium|low)"
}
Return ONLY this JSON object. No markdown syntax or explanation.`;

              const responseText = await api.agent.summarizeMessages(model, [
                { role: "system", content: "You are a memory consolidation assistant. Return only a raw JSON block." },
                { role: "user", content: prompt }
              ]);

              const parsed = parseLLMJson<{ summary?: string; content?: string; tier?: string; tags?: string[] }>(responseText);

              if (parsed?.summary && parsed.content) {
                // Create the new merged memory
                const validTiers = ["critical", "high", "medium", "low"] as const;
                const mergedTier = parsed.tier && validTiers.includes(parsed.tier as typeof validTiers[number])
                  ? parsed.tier as typeof validTiers[number]
                  : m1.tier;
                await saveMemory({
                  category,
                  tier: mergedTier,
                  summary: parsed.summary,
                  content: parsed.content,
                  tags: parsed.tags || Array.from(new Set([...m1.tags, ...m2.tags])),
                  sourceSession: m2.sourceSession || m1.sourceSession,
                  sourceFile: m2.sourceFile || m1.sourceFile
                }, workspacePath);

                // Mark old ones as stale
                await markStale(m1.id);
                await markStale(m2.id);

                m1.stale = true;
                m2.stale = true;
                deduplicatedCount++;
                llmMergeCount++;
              }
            } catch (e) {
              console.warn(`[DreamAgent] Failed to merge memories ${m1.id} and ${m2.id}:`, e);
            }
          }
        }
      }
    }

    // Purge any newly marked stale memories
    if (validatedCount > 0 || deduplicatedCount > 0) {
      await purgeStale();
    }

    // Run skill consolidation optimization (Refactoring redundant workspace skills)
    try {
      await executeWorkspaceDreamOptimization(workspacePath);
    } catch (err) {
      console.warn("[DreamAgent] Failed to consolidate skills during dream cycle:", err);
    }

    // Update MEMORY.md index
    await updateMemoryIndex(workspacePath);

    return {
      purgedCount,
      deduplicatedCount,
      dateAdjustedCount,
      validatedCount
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
    console.log(`[DreamAgent] Cancelled pending dream cycle for workspace: ${workspacePath}`);
  }
}

/**
 * Cancel all pending dream cycles across all workspaces.
 */
export function cancelAllDreamCycles(): void {
  for (const [path, timeoutId] of activeDreamTimeouts) {
    clearTimeout(timeoutId);
    console.log(`[DreamAgent] Cancelled pending dream cycle for workspace: ${path}`);
  }
  activeDreamTimeouts.clear();
}

/**
 * Triggers background consolidation if >= 24 hours have elapsed.
 * Returns a cancel function that can be used to abort the deferred dream cycle.
 */
export function triggerDreamCycleIfNeeded(workspacePath: string): () => void {
  const lastDreamStr = localStorage.getItem(`dalam.lastDreamTime.${workspacePath}`);
  const now = Date.now();
  if (lastDreamStr) {
    const lastDream = parseInt(lastDreamStr, 10);
    const minMs = 24 * 60 * 60 * 1000; // 24 hours
    if (now - lastDream < minMs) {
      return () => {}; // Not enough time passed, return no-op cancel
    }
  }

  // Cancel any existing pending dream for this workspace
  cancelDreamCycle(workspacePath);

  // Run dream cycle in background with cancellation support
  const timeoutId = setTimeout(() => {
    activeDreamTimeouts.delete(workspacePath);
    runDreamCycle(workspacePath)
      .then(() => {
        localStorage.setItem(`dalam.lastDreamTime.${workspacePath}`, Date.now().toString());
      })
      .catch(err => {
        if (import.meta.env.DEV) console.error("[DreamAgent] Background dream cycle failed:", err);
      });
  }, 5000); // 5s deferral to not block application startup

  activeDreamTimeouts.set(workspacePath, timeoutId);

  // Return a cancel function for the caller
  return () => {
    cancelDreamCycle(workspacePath);
  };
}

// Clean up all dream cycle timeouts on page unload to prevent
// background LLM calls and disk writes during or after shutdown.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", cancelAllDreamCycles);
}

/**
 * Scans the workspace skills directory, detects duplicates using Jaccard token clustering,
 * and refactors them into a consolidated skill using background LLM runs.
 */
export async function executeWorkspaceDreamOptimization(workspacePath: string): Promise<void> {
  const skillsPath = joinPath(workspacePath, ".dalam/skills");
  const api = createDalamAPI();
  
  try {
    const { readDir, readFile, writeFile, remove } = await import("@tauri-apps/plugin-fs");
    const skillDirs = await readDir(skillsPath);
    const discoveredSkills: { name: string; rawContent: string; fullPath: string }[] = [];
    
    for (const dir of skillDirs) {
      if (!dir.name) continue;
      const fileLoc = joinPath(skillsPath, dir.name, "SKILL.md");
      try {
        const dataBytes = await readFile(fileLoc);
        const rawContent = new TextDecoder().decode(dataBytes);
        discoveredSkills.push({ name: dir.name, rawContent, fullPath: fileLoc });
      } catch {
        // Skill file might not exist or be unreadable
      }
    }

    // Double pointer lookup loop checking for overlapping signatures
    const removedIndices = new Set<number>();
    for (let i = 0; i < discoveredSkills.length; i++) {
      if (removedIndices.has(i)) continue;
      for (let j = i + 1; j < discoveredSkills.length; j++) {
        if (removedIndices.has(j)) continue;
        const skillA = discoveredSkills[i]!;
        const skillB = discoveredSkills[j]!;
        
        // Use jaccardSimilarity directly (no thin wrapper)
        if (jaccardSimilarity(skillA.rawContent, skillB.rawContent) <= 0.45) continue;
        
        const consolidationPrompt = `You are a background compilation refactoring process.
We found two highly similar, overlapping procedural instructions files inside our local project workspace configuration.
Your task is to merge these two structural documents into a single comprehensive SKILL.md document.

Skill Entry 1 [${skillA.name}]:
${skillA.rawContent}

Skill Entry 2 [${skillB.name}]:
${skillB.rawContent}

Generate an elegant unified version. Output the result in clean markdown with appropriate YAML headers.`;

        const model = useSettings.getState().settings.selectedModel || "gpt-4o-mini";
        const response = await api.agent.summarizeMessages(model, [
          { role: "user", content: consolidationPrompt }
        ]);

        // Validate LLM output contains valid YAML frontmatter before overwriting
        const hasFrontmatter = /^---\s*\n[\s\S]*?\n---\s*\n/.test(response);
        if (!hasFrontmatter || response.length < 50) {
          console.warn(`[DreamAgent] LLM consolidation output for ${skillA.name} missing valid frontmatter — skipping write`);
          continue;
        }

        // Re-write consolidated results back to primary node entry point
        await writeFile(skillA.fullPath, new TextEncoder().encode(response));
        
        // Drop redundant micro-skill directories
        const oldTargetDir = joinPath(skillsPath, skillB.name);
        await remove(oldTargetDir, { recursive: true });

        // Update skillA content IN the array so subsequent comparisons use merged version.
        // Must re-read from array (not stale destructured `skillA` which has old rawContent).
        discoveredSkills[i] = {
          ...discoveredSkills[i]!,
          rawContent: response,
        };

        // Mark skillB for removal so subsequent comparisons skip it
        removedIndices.add(j);

        // Reload skills registry so UI updates
        const projectSkills = await loadProjectSkills(workspacePath, api.fs);
        refreshProjectSkills(projectSkills);
      }
    }
  } catch (err) {
    console.warn("[DreamAgent] Skill consolidation failed:", err);
  }
}
