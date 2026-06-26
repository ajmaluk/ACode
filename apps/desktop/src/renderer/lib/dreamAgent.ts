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
 *   4. Near-duplicate memory merging via LLM (Jaccard similarity > 0.40).
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
  jaccardSimilarity
} from "./memoryStore";
import { getDb } from "./database";
import { ensureDalamAPI } from "./dalamAPI";
import { useSettings } from "../store/useAppStore";
import { joinPath } from "@/lib/pathUtils";

export interface DreamReport {
  purgedCount: number;
  deduplicatedCount: number;
  dateAdjustedCount: number;
  validatedCount: number;
}

/**
 * Runs a full memory dream consolidation cycle using the active LLM.
 */
export async function runDreamCycle(workspacePath: string): Promise<DreamReport> {
  const api = ensureDalamAPI();
  const model = useSettings.getState().settings.selectedModel;

  if (!model) {
    console.warn("[DreamAgent] No active model configured, skipping dream cycle.");
    return { purgedCount: 0, deduplicatedCount: 0, dateAdjustedCount: 0, validatedCount: 0 };
  }

  // 1. Purge already-flagged stale memories from SQLite & update MEMORY.md
  const purgedCount = await purgeStale();

  // 2. Validate file references
  const memories = await getAllMemories({ excludeStale: false });
  let validatedCount = 0;
  const { exists } = await import("@tauri-apps/plugin-fs");

  for (const mem of memories) {
    if (mem.sourceFile) {
      try {
        const fullPath = mem.sourceFile.startsWith("/")
          ? mem.sourceFile
          : joinPath(workspacePath, mem.sourceFile);
        const fileExists = await exists(fullPath);
        if (!fileExists) {
          await markStale(mem.id);
          validatedCount++;
        }
      } catch (err) {
        console.warn(`[DreamAgent] Failed to check existence of ${mem.sourceFile}:`, err);
      }
    }
  }

  // Reload memories for date cleanup
  const activeMemories = await getAllMemories({ excludeStale: true });

  // 3. Relative date adjustments via LLM
  // NOTE: Each memory has unique content and creation timestamp, requiring individual LLM calls.
  // Batching is not feasible here because the prompt includes memory-specific timestamps and
  // content that must be processed independently to produce accurate absolute date replacements.
  let dateAdjustedCount = 0;
  const relativeTimeWords = /\b(recently|yesterday|last week|currently|now|tomorrow|ago)\b/i;

  for (const mem of activeMemories) {
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

        let cleanedResponse = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        const startIdx = cleanedResponse.indexOf("{");
        const endIdx = cleanedResponse.lastIndexOf("}");
        if (startIdx !== -1 && endIdx !== -1) {
          cleanedResponse = cleanedResponse.slice(startIdx, endIdx + 1);
        }
        const parsed = JSON.parse(cleanedResponse);
        if (parsed.content && parsed.content !== mem.content) {
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

  for (const category of categories) {
    const catMemories = freshMemories.filter(m => m.category === category);
    for (let i = 0; i < catMemories.length; i++) {
      for (let j = i + 1; j < catMemories.length; j++) {
        const m1 = catMemories[i];
        const m2 = catMemories[j];
        if (m1.stale || m2.stale) continue;

        const similarity = jaccardSimilarity(m1.content, m2.content);
        if (similarity > 0.40) {
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

            let cleanedResponse = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
            const startIdx = cleanedResponse.indexOf("{");
            const endIdx = cleanedResponse.lastIndexOf("}");
            if (startIdx !== -1 && endIdx !== -1) {
              cleanedResponse = cleanedResponse.slice(startIdx, endIdx + 1);
            }
            const parsed = JSON.parse(cleanedResponse);

            if (parsed.summary && parsed.content) {
              // Create the new merged memory
              await saveMemory({
                category,
                tier: parsed.tier || m1.tier,
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
        console.error("[DreamAgent] Background dream cycle failed:", err);
      });
  }, 5000); // 5s deferral to not block application startup

  activeDreamTimeouts.set(workspacePath, timeoutId);

  // Return a cancel function for the caller
  return () => {
    cancelDreamCycle(workspacePath);
  };
}

/**
 * Computes token-level intersection sets to catch surface-level duplicate structures.
 */
function calculateTokenSimilarity(textA: string, textB: string): number {
  const tokensA = new Set(textA.toLowerCase().split(/[\s,.\-/:()]+/));
  const tokensB = new Set(textB.toLowerCase().split(/[\s,.\-/:()]+/));

  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Scans the workspace skills directory, detects duplicates using Jaccard token clustering,
 * and refactors them into a consolidated skill using background LLM runs.
 */
export async function executeWorkspaceDreamOptimization(workspacePath: string): Promise<void> {
  const skillsPath = joinPath(workspacePath, ".dalam/skills");
  const api = ensureDalamAPI();
  
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
    for (let i = 0; i < discoveredSkills.length; i++) {
      for (let j = i + 1; j < discoveredSkills.length; j++) {
        const skillA = discoveredSkills[i];
        const skillB = discoveredSkills[j];
        
        // Skip entries whose files were deleted by a prior merge
        if (!skillA || !skillB) continue;
        
        const coefficientScore = calculateTokenSimilarity(skillA.rawContent, skillB.rawContent);
        
        // Threshold triggering context merging via background LLM pass
        if (coefficientScore > 0.45) {
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
          
          // Re-write consolidated results back to primary node entry point
          await writeFile(skillA.fullPath, new TextEncoder().encode(response));
          
          // Drop redundant micro-skill directories
          const oldTargetDir = joinPath(skillsPath, skillB.name);
          await remove(oldTargetDir, { recursive: true });

          // Update skillA content in-memory so subsequent comparisons use merged version
          discoveredSkills[i] = { ...skillA, rawContent: response };

          // Null out skillB so subsequent comparisons skip it
          discoveredSkills[j] = null as any;

          // Reload skills registry so UI updates
          const { loadProjectSkills, refreshProjectSkills } = await import("./skills");
          const projectSkills = await loadProjectSkills(workspacePath, api.fs);
          refreshProjectSkills(projectSkills);
          
          continue; // Skip skillB in subsequent comparisons
        }
      }
    }
  } catch {
    // Graceful exit for cold workspaces containing zero initialized skill states
  }
}
