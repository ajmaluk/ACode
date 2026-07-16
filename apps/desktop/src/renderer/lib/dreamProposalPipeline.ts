/**
 * ============================================================
 * DALAM DREAM PROPOSAL PIPELINE — Phase 7.2
 * ============================================================
 *
 * Wraps the dream cycle's direct operations into a scored proposal
 * pipeline: propose → score → accept/apply.
 *
 * Scoring dimensions (0-10):
 *   - Impact: how many memories/entries affected
 *   - Confidence: similarity scores, LLM certainty
 *   - Freshness: how recent/active the affected data is
 *
 * Decision thresholds:
 *   - score >= 7: auto-accept, apply immediately
 *   - score >= 4: queue for user review (via notification)
 *   - score <  4: silently reject (drop proposal)
 *
 * The pipeline collects proposals from dream cycle phases, scores
 * each one, and routes to the appropriate handler.
 * ============================================================
 */

// ─── Proposal Types ──────────────────────────────────────────

export type DreamProposalType =
  | "purge-stale" // Hard-delete already-flagged stale memories
  | "mark-stale" // Mark memories stale because source files missing
  | "date-adjust" // Rewrite relative dates to absolute dates
  | "deduplicate-merge" // Merge two similar memories via LLM
  | "consolidate-skill" // Merge overlapping skill files
  | "re-score" // Promote/demote memories based on access patterns
  | "budget-prune"; // Prune low-quality memories to stay under budget

export type DreamProposalStatus =
  | "pending" // Created but not yet scored
  | "scored" // Scored, awaiting action decision
  | "auto-accept" // High-score, will be auto-applied
  | "user-review" // Medium-score, queued for user decision
  | "rejected" // Low-score or user-declined
  | "applied"; // Changes have been applied

export interface DreamProposal {
  id: string;
  type: DreamProposalType;
  /** Human-readable description shown in notifications */
  description: string;
  /** Details stored for potential application */
  details: Record<string, unknown>;
  /** Composite score 0-10 */
  score: number;
  status: DreamProposalStatus;
  createdAt: number;
  appliedAt?: number;
  /** Count of affected items (memories, skills, etc.) */
  affectedCount: number;
}

// ─── Scoring thresholds ──────────────────────────────────────

export const SCORE_THRESHOLDS = {
  AUTO_ACCEPT: 7,
  USER_REVIEW: 4,
} as const;

// ─── Scoring weights ─────────────────────────────────────────

const WEIGHTS = {
  /** High impact: affects many entries or critical data */
  IMPACT_HIGH: 3,
  /** Low impact: few entries or low-tier data */
  IMPACT_LOW: 1,
  /** High confidence: strong similarity, verified check */
  CONFIDENCE_HIGH: 4,
  /** Low confidence: weak signal, heuristic only */
  CONFIDENCE_LOW: 1,
  /** High freshness: recently active, frequently accessed */
  FRESHNESS_HIGH: 2,
  /** Low freshness: old or rarely accessed */
  FRESHNESS_LOW: 0,
} as const;

// ─── Scoring function ────────────────────────────────────────

/**
 * Score a proposal based on its type, affected count, and context.
 * Returns a score 0-10.
 */
export function scoreProposal(
  type: DreamProposalType,
  affectedCount: number,
  context: {
    /** Jaccard or similarity score (0-1) for dedup/consolidation proposals */
    similarity?: number;
    /** Average age in days of affected entries */
    avgAgeDays?: number;
    /** Average access count of affected entries */
    avgAccessCount?: number;
    /** Total number of entries in the category (for impact ratio) */
    totalInCategory?: number;
  } = {},
): number {
  let score = 5; // Baseline

  // ── Impact score ────────────────────────────────────────────
  const impactRatio =
    context.totalInCategory && context.totalInCategory > 0
      ? affectedCount / context.totalInCategory
      : 0;

  if (type === "purge-stale") {
    // Purging already-flagged stale entries is always safe and beneficial
    score += 3; // Base bonus for cleanup
    score += Math.min(2, affectedCount); // +1 per affected entry, max +2
  } else if (type === "mark-stale") {
    // Marking stale based on missing source files is high confidence
    score += WEIGHTS.CONFIDENCE_HIGH;
    score += impactRatio > 0.1 ? WEIGHTS.IMPACT_HIGH : WEIGHTS.IMPACT_LOW;
  } else if (type === "date-adjust") {
    // Date adjustments are generally safe but less critical
    score += 2;
    if (affectedCount > 3) score += 1; // Batch bonus
  } else if (type === "deduplicate-merge") {
    // Dedup confidence depends on Jaccard similarity
    const similarity = context.similarity ?? 0.55;
    if (similarity > 0.8) score += 4;
    else if (similarity > 0.65) score += 2;
    else score += 1;
    score += affectedCount >= 2 ? 1 : 0;
  } else if (type === "consolidate-skill") {
    const similarity = context.similarity ?? 0.45;
    if (similarity > 0.7) score += 3;
    else score += 1;
  } else if (type === "re-score") {
    // Re-scoring based on access patterns is low-risk maintenance
    score += affectedCount > 5 ? 2 : 1;
  } else if (type === "budget-prune") {
    // Budget pruning is necessary but destructive
    score += WEIGHTS.CONFIDENCE_HIGH; // High confidence in pruning rules
    score -= 1; // Penalty for destructive operation
  }

  // ── Freshness adjustment ────────────────────────────────────
  if (context.avgAccessCount !== undefined) {
    score +=
      context.avgAccessCount >= 3
        ? WEIGHTS.FRESHNESS_HIGH
        : WEIGHTS.FRESHNESS_LOW;
  }

  return Math.max(0, Math.min(10, Math.round(score)));
}

// ─── Decision function ───────────────────────────────────────

export function decideProposalAction(
  score: number,
): "auto-accept" | "user-review" | "reject" {
  if (score >= SCORE_THRESHOLDS.AUTO_ACCEPT) return "auto-accept";
  if (score >= SCORE_THRESHOLDS.USER_REVIEW) return "user-review";
  return "reject";
}

// ─── Proposal creation ───────────────────────────────────────

export function createProposal(
  type: DreamProposalType,
  description: string,
  details: Record<string, unknown>,
  affectedCount: number,
  scoreContext?: {
    similarity?: number;
    avgAgeDays?: number;
    avgAccessCount?: number;
    totalInCategory?: number;
  },
): DreamProposal {
  // FIX 9.4: Use crypto.randomUUID() for globally unique IDs instead of counter-based approach
  const id = `dp-${crypto.randomUUID()}`;
  const score = scoreProposal(type, affectedCount, scoreContext);
  const action = decideProposalAction(score);

  return {
    id,
    type,
    description,
    details,
    score,
    status:
      action === "auto-accept"
        ? "auto-accept"
        : action === "user-review"
          ? "user-review"
          : "rejected",
    createdAt: Date.now(),
    affectedCount,
  };
}

// ─── Pipeline Router ─────────────────────────────────────────

export interface PipelineResult {
  /** Proposals that were auto-accepted and applied */
  autoAccepted: DreamProposal[];
  /** Proposals queued for user review */
  queuedForReview: DreamProposal[];
  /** Proposals that were rejected (score too low) */
  rejected: DreamProposal[];
}

/**
 * Process a batch of proposals through the pipeline.
 * Auto-applies high-scored proposals via the provided apply function.
 * Returns categorized results.
 */
export async function processProposals(
  proposals: DreamProposal[],
  applyFn: (proposal: DreamProposal) => Promise<void>,
  notifyFn?: (proposal: DreamProposal) => void,
): Promise<PipelineResult> {
  const result: PipelineResult = {
    autoAccepted: [],
    queuedForReview: [],
    rejected: [],
  };

  for (const proposal of proposals) {
    switch (proposal.status) {
      case "auto-accept":
        try {
          await applyFn(proposal);
          proposal.status = "applied";
          proposal.appliedAt = Date.now();
          result.autoAccepted.push(proposal);
        } catch (err) {
          console.warn(
            `[DreamProposal] Auto-apply failed for ${proposal.id}:`,
            err,
          );
          proposal.status = "rejected";
          result.rejected.push(proposal);
        }
        break;

      case "user-review":
        // Queue for user review — notify the UI
        notifyFn?.(proposal);
        result.queuedForReview.push(proposal);
        break;

      case "applied":
        // Already applied (e.g., by dreamAgent directly) — count as accepted
        result.autoAccepted.push(proposal);
        break;

      default:
        // "pending" or "rejected" — skip
        result.rejected.push(proposal);
        break;
    }
  }

  return result;
}

// ─── Report formatter ────────────────────────────────────────

/**
 * Format a pipeline result into a human-readable summary string.
 */
export function formatPipelineSummary(result: PipelineResult): string {
  const parts: string[] = [];

  if (result.autoAccepted.length > 0) {
    const summaries = result.autoAccepted
      .map(
        (p) =>
          `  ✓ ${p.description} (score: ${p.score}, ${p.affectedCount} items)`,
      )
      .join("\n");
    parts.push(
      `Auto-applied ${result.autoAccepted.length} proposal(s):\n${summaries}`,
    );
  }

  if (result.queuedForReview.length > 0) {
    const summaries = result.queuedForReview
      .map(
        (p) =>
          `  ? ${p.description} (score: ${p.score}, ${p.affectedCount} items)`,
      )
      .join("\n");
    parts.push(
      `Queued ${result.queuedForReview.length} proposal(s) for review:\n${summaries}`,
    );
  }

  if (result.rejected.length > 0) {
    parts.push(
      `Rejected ${result.rejected.length} low-scoring proposal(s) silently.`,
    );
  }

  return parts.join("\n\n") || "No proposals generated.";
}
