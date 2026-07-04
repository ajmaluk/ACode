/**
 * ============================================================
 * DALAM GENE SYSTEM — Self-Evolving Agent Intelligence
 * ============================================================
 *
 * Inspired by Evolver's GEP (Gene Expression Protocol):
 * - Genes are compact strategy representations (not full skill docs)
 * - They encode: trigger conditions, action patterns, success metrics
 * - They evolve through: reflection, mutation, solidification
 *
 * Gene lifecycle:
 *   1. OBSERVE — Agent notices a pattern in its behavior
 *   2. CANDIDATE — Pattern is promoted to a candidate gene
 *   3. VALIDATE — Gene is tested against historical sessions
 *   4. SOLIDIFY — Gene is committed to the gene pool
 *   5. EXPRESS — Gene influences future agent decisions
 * ============================================================
 */

import type { ChatMessage } from "@dalam/shared-types";

// ─── Gene Types ──────────────────────────────────────────────

export interface Gene {
  id: string;
  name: string;
  description: string;
  trigger: string;           // When to activate (regex or keyword)
  action: string;            // What to do (prompt template or tool call)
  category: "strategy" | "tool_use" | "error_recovery" | "optimization" | "pattern";
  confidence: number;        // 0-1, how reliable this gene is
  activationCount: number;   // How many times it's been used
  successCount: number;      // How many times it succeeded
  createdAt: number;
  lastActivatedAt: number;
  source: "session" | "reflection" | "manual";
  tags: string[];
}

export interface GenePool {
  genes: Gene[];
  version: number;
  lastEvolution: number;
  totalActivations: number;
}

export interface ReflectionResult {
  sessionId: string;
  patterns: DetectedPattern[];
  suggestedGenes: Gene[];
  performanceScore: number;
  timestamp: number;
}

export interface DetectedPattern {
  type: "success" | "failure" | "inefficiency" | "repetition";
  description: string;
  frequency: number;
  impact: "high" | "medium" | "low";
  evidence: string[];
}

// ─── Gene Pool Management ────────────────────────────────────

const GENE_POOL_KEY = "dalam.genePool.v1";

export function loadGenePool(): GenePool {
  try {
    const raw = localStorage.getItem(GENE_POOL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) { console.warn("[Genes] Failed to load gene pool:", err); }
  return {
    genes: [],
    version: 1,
    lastEvolution: 0,
    totalActivations: 0,
  };
}

export function saveGenePool(pool: GenePool): void {
  try {
    localStorage.setItem(GENE_POOL_KEY, JSON.stringify(pool));
  } catch (err) {
    console.warn("[Genes] Failed to save gene pool:", err);
  }
}

export function addGene(pool: GenePool, gene: Gene): GenePool {
  // Deduplication: check for genes with same name or similar trigger
  const existing = pool.genes.find(g => g.name === gene.name || g.trigger === gene.trigger);
  if (existing) {
    // Boost existing gene's confidence instead of creating duplicate
    const updatedConfidence = Math.min(1, existing.confidence + 0.05);
    return {
      ...pool,
      genes: pool.genes.map(g =>
        g.id === existing.id
          ? { ...g, confidence: updatedConfidence, activationCount: g.activationCount + 1, lastActivatedAt: Date.now() }
          : g
      ),
    };
  }

  // Cap gene pool at 50 genes (evict lowest confidence / oldest first)
  let genes = [...pool.genes, gene];
  if (genes.length > 50) {
    genes.sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt);
    genes = genes.slice(0, 50);
  }

  const newPool = {
    ...pool,
    genes,
  };
  saveGenePool(newPool);
  return newPool;
}

export function removeGene(pool: GenePool, geneId: string): GenePool {
  return {
    ...pool,
    genes: pool.genes.filter(g => g.id !== geneId),
  };
}

/**
 * Record a successful activation for a gene (increments successCount).
 */
export function recordGeneSuccess(pool: GenePool, geneId: string): GenePool {
  return {
    ...pool,
    genes: pool.genes.map(g =>
      g.id === geneId ? { ...g, successCount: g.successCount + 1 } : g
    ),
  };
}

// ─── Debounced Gene Pool Save ─────────────────────────────────

let _pendingGeneSave: ReturnType<typeof setTimeout> | null = null;
let _pendingGenePool: GenePool | null = null;

// ─── Gene Expression ─────────────────────────────────────────

// Cache compiled regexes for gene triggers to avoid recompilation per prompt
const _geneTriggerCache = new Map<string, RegExp | null>();

function getGeneTriggerRegex(trigger: string): RegExp | null {
  const cached = _geneTriggerCache.get(trigger);
  if (cached !== undefined) return cached;
  try {
    const regex = new RegExp(trigger, "i");
    _geneTriggerCache.set(trigger, regex);
    return regex;
  } catch {
    _geneTriggerCache.set(trigger, null);
    return null;
  }
}

/**
 * Find genes that match a given context (prompt + recent messages).
 * Returns genes sorted by confidence and relevance.
 */
export function expressGenes(
  pool: GenePool,
  prompt: string,
  recentMessages: ChatMessage[]
): Gene[] {
  const lowerPrompt = prompt.toLowerCase();
  const recentContent = recentMessages
    .slice(-5)
    .map(m => m.content.toLowerCase())
    .join(" ");

  const matched = pool.genes
    .filter(gene => {
      const regex = getGeneTriggerRegex(gene.trigger);
      if (regex) {
        return regex.test(lowerPrompt) || regex.test(recentContent);
      }
      return lowerPrompt.includes(gene.trigger.toLowerCase());
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  // Track activation for matched genes
  if (matched.length > 0) {
    const updatedGenes = pool.genes.map(g => {
      const m = matched.find(mg => mg.id === g.id);
      if (m) {
        return { ...g, activationCount: g.activationCount + 1, lastActivatedAt: Date.now() };
      }
      return g;
    });
    // Save updated pool (debounced to avoid race conditions)
    if (_pendingGeneSave) clearTimeout(_pendingGeneSave);
    _pendingGenePool = { ...pool, genes: updatedGenes };
    _pendingGeneSave = setTimeout(() => {
      if (_pendingGenePool) {
        saveGenePool(_pendingGenePool);
        _pendingGenePool = null;
      }
    }, 50);
  }

  return matched;
}

// ─── Reflection Engine ───────────────────────────────────────

/**
 * Analyze a session and detect patterns for gene creation.
 */
export function reflectOnSession(
  messages: ChatMessage[],
  sessionId: string
): ReflectionResult {
  const patterns: DetectedPattern[] = [];
  const suggestedGenes: Gene[] = [];

  // Analyze tool usage patterns
  const toolCalls = messages.filter(m =>
    m.content.startsWith("[TOOL RESULT:") || m.content.startsWith("[TOOL ERROR:")
  );

  const toolErrors = messages.filter(m => m.content.startsWith("[TOOL ERROR:"));
  if (toolErrors.length > 2) {
    patterns.push({
      type: "failure",
      description: `Multiple tool errors in session (${toolErrors.length})`,
      frequency: toolErrors.length,
      impact: "high",
      evidence: toolErrors.map(m => m.content.slice(0, 100)),
    });

    // Extract specific error types for targeted genes
    const errorTypes = extractErrorTypes(toolErrors);
    for (const [errorType, count] of Object.entries(errorTypes)) {
      if (count >= 2) {
        suggestedGenes.push({
          id: createGeneId(),
          name: `recovery-${errorType}`,
          description: `Handle recurring ${errorType} errors`,
          trigger: errorType,
          action: getRecoveryAction(errorType),
          category: "error_recovery",
          confidence: 0.3,
          activationCount: 0,
          successCount: 0,
          createdAt: Date.now(),
          lastActivatedAt: 0,
          source: "reflection",
          tags: ["error", "recovery", errorType],
        });
      }
    }
  }

  // Detect file edit patterns for optimization genes
  const fileEdits = messages.filter(m => m.content.includes("File edited successfully") || m.content.includes("File written successfully"));
  if (fileEdits.length > 3) {
    patterns.push({
      type: "inefficiency",
      description: `Many file operations (${fileEdits.length}) — consider batching`,
      frequency: fileEdits.length,
      impact: "medium",
      evidence: fileEdits.map(m => m.content.slice(0, 80)),
    });

    suggestedGenes.push({
      id: createGeneId(),
      name: "batch-file-operations",
      description: "Batch multiple file edits into a single operation when possible",
      trigger: "edit multiple|change several|update all|refactor",
      action: "When editing multiple files, group related changes and use write_file for each batch instead of individual edits",
      category: "optimization",
      confidence: 0.4,
      activationCount: 0,
      successCount: 0,
      createdAt: Date.now(),
      lastActivatedAt: 0,
      source: "reflection",
      tags: ["optimization", "batching", "file-ops"],
    });
  }

  // Detect repetition patterns
  const userMessages = messages.filter(m => m.role === "user");
  const repeatedPhrases = findRepeatedPhrases(userMessages.map(m => m.content));
  if (repeatedPhrases.length > 0) {
    patterns.push({
      type: "repetition",
      description: `Repeated user requests: ${repeatedPhrases.join(", ")}`,
      frequency: repeatedPhrases.length,
      impact: "medium",
      evidence: repeatedPhrases,
    });

    // Create strategy gene for repeated patterns
    suggestedGenes.push({
      id: createGeneId(),
      name: "repetition-strategy",
      description: "Detect and preempt repeated user requests",
      trigger: repeatedPhrases.slice(0, 2).join("|"),
      action: "When you detect a pattern the user repeats, proactively address it in your response",
      category: "strategy",
      confidence: 0.35,
      activationCount: 0,
      successCount: 0,
      createdAt: Date.now(),
      lastActivatedAt: 0,
      source: "reflection",
      tags: ["strategy", "repetition", "proactive"],
    });
  }

  // Detect successful patterns for positive reinforcement genes
  const assistantMessages = messages.filter(m => m.role === "assistant");
  if (assistantMessages.length > 3 && toolErrors.length === 0) {
    patterns.push({
      type: "success",
      description: "Clean session with no tool errors",
      frequency: 1,
      impact: "low",
      evidence: ["All tools executed successfully"],
    });

    // Analyze what worked well
    const toolNames = extractToolNames(toolCalls);
    if (toolNames.length > 0) {
      suggestedGenes.push({
        id: createGeneId(),
        name: "effective-tool-pattern",
        description: `Successful use of tools: ${toolNames.join(", ")}`,
        trigger: toolNames.join("|"),
        action: "Continue using this tool combination for similar tasks",
        category: "pattern",
        confidence: 0.5,
        activationCount: 0,
        successCount: 0,
        createdAt: Date.now(),
        lastActivatedAt: 0,
        source: "reflection",
        tags: ["pattern", "success", "tools"],
      });
    }
  }

  // Calculate performance score
  const totalTools = toolCalls.length;
  const errorRate = totalTools > 0 ? toolErrors.length / totalTools : 0;
  const performanceScore = Math.max(0, 1 - errorRate);

  return {
    sessionId,
    patterns,
    suggestedGenes,
    performanceScore,
    timestamp: Date.now(),
  };
}

/**
 * Extract error types from tool error messages.
 */
function extractErrorTypes(errors: ChatMessage[]): Record<string, number> {
  const types: Record<string, number> = {};
  for (const err of errors) {
    const content = err.content.toLowerCase();
    if (content.includes("permission")) types["permission"] = (types["permission"] || 0) + 1;
    else if (content.includes("not found")) types["not-found"] = (types["not-found"] || 0) + 1;
    else if (content.includes("timeout")) types["timeout"] = (types["timeout"] || 0) + 1;
    else if (content.includes("network")) types["network"] = (types["network"] || 0) + 1;
    else if (content.includes("syntax")) types["syntax"] = (types["syntax"] || 0) + 1;
    else types["generic"] = (types["generic"] || 0) + 1;
  }
  return types;
}

/**
 * Get recovery action based on error type.
 */
function getRecoveryAction(errorType: string): string {
  const actions: Record<string, string> = {
    "permission": "Check file permissions and try with elevated access or different path",
    "not-found": "Verify the file/directory exists before attempting operations",
    "timeout": "Split the operation into smaller chunks or increase timeout",
    "network": "Check network connectivity and retry with exponential backoff",
    "syntax": "Review the command syntax and use --help to check valid options",
    "generic": "Analyze the error message and try an alternative approach",
  };
  return actions[errorType] || actions["generic"];
}

/**
 * Extract tool names from tool call messages.
 */
function extractToolNames(toolCalls: ChatMessage[]): string[] {
  const names: string[] = [];
  for (const msg of toolCalls) {
    const match = msg.content.match(/\[TOOL (?:RESULT|ERROR):\s*(\S+)/);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)];
}

/**
 * Find repeated phrases in messages (potential automation candidates).
 */
function findRepeatedPhrases(contents: string[]): string[] {
  const phrases: Record<string, number> = {};
  for (const content of contents) {
    // Extract 3-5 word phrases
    const words = content.split(/\s+/).filter(w => w.length > 2);
    for (let i = 0; i <= words.length - 3; i++) {
      const phrase = words.slice(i, i + 3).join(" ").toLowerCase();
      phrases[phrase] = (phrases[phrase] || 0) + 1;
    }
  }
  return Object.entries(phrases)
    .filter(([_, count]) => count >= 2)
    .map(([phrase]) => phrase)
    .slice(0, 5);
}

// ─── Solidification ──────────────────────────────────────────

/**
 * Solidify a candidate gene into the gene pool.
 * Validates the gene before adding it.
 */
export function solidifyGene(
  pool: GenePool,
  candidate: Omit<Gene, "id" | "createdAt" | "lastActivatedAt">
): { success: boolean; gene?: Gene; error?: string } {
  // Validate trigger is a valid regex
  try {
    new RegExp(candidate.trigger, "i");
  } catch {
    return { success: false, error: "Invalid trigger regex" };
  }

  // Check for duplicate names
  if (pool.genes.some(g => g.name === candidate.name)) {
    return { success: false, error: "Gene with this name already exists" };
  }

  const gene: Gene = {
    ...candidate,
    id: `gene-${Date.now().toString(36)}-${crypto.randomUUID()}`,
    createdAt: Date.now(),
    lastActivatedAt: 0,
  };

  const newPool = addGene(pool, gene);
  saveGenePool(newPool);

  return { success: true, gene };
}

/**
 * Evolve genes based on usage statistics.
 * - Remove genes with low confidence and zero activations
 * - Boost confidence of frequently successful genes
 */
export function evolveGenes(pool: GenePool): GenePool {
  const now = Date.now();
  const STALE_DAYS = 30 * 24 * 60 * 60 * 1000; // 30 days

  const evolved = pool.genes.map(gene => {
    // Boost confidence for successful genes
    if (gene.activationCount > 5 && gene.successCount > gene.activationCount * 0.7) {
      return { ...gene, confidence: Math.min(1, gene.confidence + 0.05) };
    }
    // Reduce confidence for unused genes (zero activations, stale)
    if (now - gene.lastActivatedAt > STALE_DAYS && gene.activationCount === 0) {
      return { ...gene, confidence: Math.max(0, gene.confidence - 0.1) };
    }
    // Reduce confidence for rarely-used stale genes (1-3 activations, stale)
    if (now - gene.lastActivatedAt > STALE_DAYS && gene.activationCount > 0 && gene.activationCount <= 3) {
      return { ...gene, confidence: Math.max(0, gene.confidence - 0.05) };
    }
    return gene;
  });

  // Remove very low confidence genes
  const filtered = evolved.filter(g => g.confidence > 0.1 || g.activationCount > 0);

  return {
    ...pool,
    genes: filtered,
    version: pool.version + 1,
    lastEvolution: now,
  };
}

// ─── Gene Injection into Prompts ─────────────────────────────

/**
 * Format active genes for injection into system prompts.
 */
export function formatGenesForPrompt(genes: Gene[]): string {
  if (genes.length === 0) return "";

  const lines = [
    "\n\n=== EVOLVED STRATEGIES ===",
    "The following strategies have been learned from past sessions:",
    "",
  ];

  for (const gene of genes) {
    lines.push(`- [${gene.category}] ${gene.name}: ${gene.description}`);
    lines.push(`  Trigger: ${gene.trigger}`);
    lines.push(`  Action: ${gene.action}`);
    lines.push("");
  }

  lines.push("===========================");
  return lines.join("\n");
}

// ─── Utility ─────────────────────────────────────────────────

export function createGeneId(): string {
  return `gene-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

export function getGeneSuccessRate(gene: Gene): number {
  if (gene.activationCount === 0) return 0;
  return gene.successCount / gene.activationCount;
}
