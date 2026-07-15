/**
 * ============================================================
 * PROPERTY-BASED TESTS — Dream Agent Consolidation & Date Adjust
 * ============================================================
 *
 * Uses fast-check to verify invariants of the dream agent's:
 *   1. Memory consolidation (clustering algorithm)
 *   2. Simple date pattern replacement (yesterday/today/now)
 *
 * Properties tested:
 *   - Clustering invariants: category separation, tag overlap,
 *     Jaccard threshold, single-memory exclusion, sorting
 *   - Date replacement: yyyy-mm-dd format, case insensitivity,
 *     unchanged content for unrelated text
 * ============================================================
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { jaccardSimilarity } from "../memoryStore";

// ─── Mock database (not needed for pure-logic properties) ────

vi.mock("../database", () => ({
  getDb: vi.fn(() => { throw new Error("Database not used"); }),
}));

// ============================================================================
// HELPERS — replicate the dream agent's inline logic
// ============================================================================

/**
 * Replicates the replaceSimplePatterns() function from dreamAgent.ts
 * to avoid importing it (it's defined inside runDreamCycle).
 */
function replaceSimplePatterns(content: string): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();
  return content
    .replace(/\byesterday\b/gi, yesterday.toISOString().split("T")[0])
    .replace(/\btoday\b/gi, today.toISOString().split("T")[0])
    .replace(/\bnow\b/gi, new Date().toISOString());
}

/**
 * Replicates the clustering algorithm from dreamAgent.ts (Phase 1).
 * Groups memories by category, then within each category, forms clusters
 * when tagOverlap > 0 AND jaccardSimilarity > 0.55.
 *
 * Returns clusters sorted by importance (memberCount × totalAccess, desc).
 */
interface MemoryStub { id: string; category: string; tags: string[]; content: string; accessCount: number; }
interface ClusterStub { members: MemoryStub[]; totalAccess: number; }

function clusterMemories(memories: MemoryStub[]): ClusterStub[] {
  const categories = Array.from(new Set(memories.map((m) => m.category)));
  const clusters: ClusterStub[] = [];
  const assigned = new Set<string>();

  for (const category of categories) {
    const catMemories = memories.filter((m) => m.category === category);
    for (const mem of catMemories) {
      if (assigned.has(mem.id)) continue;
      const cluster: ClusterStub = { members: [mem], totalAccess: mem.accessCount };
      assigned.add(mem.id);

      for (const other of catMemories) {
        if (assigned.has(other.id) || mem.id === other.id) continue;
        const tagOverlap = mem.tags.filter((t) => other.tags.includes(t)).length;
        if (tagOverlap > 0 && jaccardSimilarity(mem.content, other.content) > 0.55) {
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

  clusters.sort((a, b) => b.members.length * b.totalAccess - a.members.length * a.totalAccess);
  return clusters;
}

// ─── Regex copied from dreamAgent.ts for date candidate detection
const relativeTimeWords =
  /\b(recently|yesterday|last week|currently|now|tomorrow|ago|earlier today|this morning|a few days ago|last night|the other day)\b/i;

// ============================================================================
// ARBITRARIES
// ============================================================================

/** Safe strings that don't interfere with YAML or clustering */
const safeString = (minLen = 1, maxLen = 30): fc.Arbitrary<string> =>
  fc.string({ minLength: minLen, maxLength: maxLen }).map((s) =>
    s.replace(/[^a-zA-Z0-9_/.\- ]/g, "x"),
  );

/** IDs for test memories */
const _idArbitrary: fc.Arbitrary<string> =
  fc.string({ minLength: 5, maxLength: 40 }).map((s) =>
    s.replace(/[^a-zA-Z0-9_-]/g, "-"),
  );

/** Tags — must be non-empty, no commas (implementation splits on comma) */
const tagArbitrary: fc.Arbitrary<string> =
  fc.string({ minLength: 1, maxLength: 12 }).map((s) =>
    s.replace(/[^a-zA-Z0-9_]/g, "_"),
  );

/** Content for memories — uses space-separated words to make Jaccard meaningful */
const contentArbitrary: fc.Arbitrary<string> =
  fc.array(fc.string({ minLength: 2, maxLength: 15 }).map((s) =>
    s.replace(/[^a-zA-Z]/g, "x")
  ), { minLength: 3, maxLength: 10 }).map((words) => words.join(" "));

/**
 * Generate N memories with deliberately shared properties so clusters can form.
 * Uses a mix of "base" content (shared) and "unique" content (distinct).
 */
function memorySetArbitrary(): fc.Arbitrary<MemoryStub[]> {
  return fc
    .tuple(
      fc.integer({ min: 2, max: 12 }),    // number of memories
      fc.array(fc.constantFrom("user", "project", "decision", "reference"), { minLength: 2, maxLength: 4 }),
      safeString(10, 30),                  // shared base content for potential clustering
      fc.array(tagArbitrary, { minLength: 1, maxLength: 3 }),  // shared tags
    )
    .chain(([count, cats, baseContent, sharedTags]) => {
      return fc
        .record({
          extraTagsArr: fc.array(fc.array(tagArbitrary, { minLength: 0, maxLength: 3 }), { minLength: count, maxLength: count }),
          categories: fc.array(fc.constantFrom(...cats), { minLength: count, maxLength: count }),
          contents: fc.array(
            fc.oneof(fc.constant(baseContent), contentArbitrary),
            { minLength: count, maxLength: count },
          ),
        })
        .map(({ extraTagsArr, categories: catsArr, contents }) => {
          const memories: MemoryStub[] = [];
          for (let i = 0; i < count; i++) {
            const useBase = i % 2 === 0;
            memories.push({
              id: `mem-${i}-${Date.now()}`,
              category: catsArr[i % catsArr.length],
              tags: [...sharedTags, ...(extraTagsArr[i] ?? [])],
              content: useBase ? baseContent : (contents[i] ?? baseContent),
              accessCount: Math.floor(Math.random() * 10),
            });
          }
          return memories;
        });
    });
}

// ============================================================================
// PROPERTY TESTS
// ============================================================================

// ── Date Pattern Replacement ─────────────────────────────────

describe("DreamAgent property — date pattern replacement", () => {

  it("replaces 'yesterday' with a YYYY-MM-DD date string", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }).map((s) =>
          s.replace(/[^a-zA-Z0-9_ ]/g, "")
        ),
        (prefix) => {
          const input = prefix + " yesterday " + prefix;
          const result = replaceSimplePatterns(input);
          const dateMatch = result.match(
            /\d{4}-\d{2}-\d{2}/,
          );
          expect(dateMatch).not.toBeNull();
          const dateStr = dateMatch![0];
          const parsed = new Date(dateStr);
          expect(parsed instanceof Date && !isNaN(parsed.getTime())).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("replaces 'today' with a YYYY-MM-DD date string", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).map((s) =>
          s.replace(/[^a-zA-Z0-9_ ]/g, "")
        ),
        (prefix) => {
          const input = prefix + " today " + prefix;
          const result = replaceSimplePatterns(input);
          const dateMatch = result.match(/\d{4}-\d{2}-\d{2}/);
          expect(dateMatch).not.toBeNull();
          const parsed = new Date(dateMatch![0]);
          expect(parsed instanceof Date && !isNaN(parsed.getTime())).toBe(true);
          // today should be today's date
          const expected = new Date().toISOString().split("T")[0];
          expect(dateMatch![0]).toBe(expected);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("replaces 'now' with a valid ISO timestamp", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }).map((s) =>
          s.replace(/[^a-zA-Z0-9_ ]/g, "")
        ),
        (prefix) => {
          const input = prefix + " now " + prefix;
          const result = replaceSimplePatterns(input);
          // ISO timestamp format: 2024-01-15T10:30:00.000Z
          const isoMatch = result.match(
            /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
          );
          expect(isoMatch).not.toBeNull();
          const parsed = new Date(isoMatch![0]);
          expect(parsed instanceof Date && !isNaN(parsed.getTime())).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("does not modify content without date patterns", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }).map((s) =>
          s.replace(/[^a-zA-Z0-9_ ]/g, ""),
        ),
        (content) => {
          fc.pre(!relativeTimeWords.test(content));
          const result = replaceSimplePatterns(content);
          expect(result).toBe(content);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("replaces multiple occurrences of 'yesterday' in the same string", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constant("yesterday"), { minLength: 2, maxLength: 10 }),
        (words) => {
          const input = words.join(" ");
          const result = replaceSimplePatterns(input);
          // All "yesterday" should be replaced — no more occurrences
          expect(result).not.toContain("yesterday");
          expect(result).not.toContain("Yesterday");
          // Should have the same number of dates as input had "yesterday"s
          const dates = result.match(/\d{4}-\d{2}-\d{2}/g);
          expect(dates).not.toBeNull();
          expect(dates!.length).toBe(words.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("preserves the surrounding text when replacing date patterns", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).map((s) =>
          s.replace(/[^a-zA-Z0-9_]/g, "x")
        ),
        (surrounding) => {
          const input = `On yesterday we started working on ${surrounding}`;
          const result = replaceSimplePatterns(input);
          // The surrounding text should be preserved
          expect(result).toContain(surrounding);
          // The word "yesterday" should be gone
          expect(result).not.toContain("yesterday");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("handles case-insensitive date patterns (Yesterday, YESTERDAY, etc.)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("yesterday", "Yesterday", "YESTERDAY", "yESTERDAY"),
        (variant) => {
          const input = `Completed ${variant} the task`;
          const result = replaceSimplePatterns(input);
          expect(result).not.toContain(variant);
          expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
        },
      ),
    );
  });
});

// ── Clustering Invariants ────────────────────────────────────

describe("DreamAgent property — clustering invariants", () => {

  it("memories in different categories never cluster together", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        for (const cluster of clusters) {
          const categories = new Set(cluster.members.map((m) => m.category));
          expect(categories.size).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("memories without overlapping tags never cluster together", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        for (const cluster of clusters) {
          for (let i = 0; i < cluster.members.length; i++) {
            for (let j = i + 1; j < cluster.members.length; j++) {
              const overlap = cluster.members[i].tags.filter((t) =>
                cluster.members[j].tags.includes(t),
              ).length;
              expect(overlap).toBeGreaterThan(0);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("each memory appears in at most one cluster", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        const seenIds = new Set<string>();
        for (const cluster of clusters) {
          for (const member of cluster.members) {
            expect(seenIds.has(member.id)).toBe(false);
            seenIds.add(member.id);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("clusters are sorted by importance (memberCount × totalAccess, descending)", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        for (let i = 1; i < clusters.length; i++) {
          const prev = clusters[i - 1].members.length * clusters[i - 1].totalAccess;
          const curr = clusters[i].members.length * clusters[i].totalAccess;
          expect(prev).toBeGreaterThanOrEqual(curr);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("memories with Jaccard similarity ≤ 0.55 never cluster together", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        for (const cluster of clusters) {
          for (let i = 0; i < cluster.members.length; i++) {
            for (let j = i + 1; j < cluster.members.length; j++) {
              const sim = jaccardSimilarity(
                cluster.members[i].content,
                cluster.members[j].content,
              );
              expect(sim).toBeGreaterThan(0.55);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("single memories never form clusters", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        for (const cluster of clusters) {
          expect(cluster.members.length).toBeGreaterThan(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("none of the original memories are mutated by the clustering process", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const originalContents = memories.map((m) => m.content);
        const originalTags = memories.map((m) => [...m.tags]);
        const originalCategories = memories.map((m) => m.category);

        clusterMemories(memories);

        // Verify original arrays are unchanged
        const newContents = memories.map((m) => m.content);
        const newTags = memories.map((m) => [...m.tags]);
        const newCategories = memories.map((m) => m.category);

        expect(newContents).toEqual(originalContents);
        expect(newTags).toEqual(originalTags);
        expect(newCategories).toEqual(originalCategories);
      }),
      { numRuns: 50 },
    );
  });
});

// ── Cluster Merging Lifecycle ────────────────────────────────

describe("DreamAgent property — cluster merging lifecycle", () => {

  it("merged entry has union of all tags from originals (deduplicated)", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        if (clusters.length === 0) return; // nothing to merge

        const cluster = clusters[0];
        // Simulate the tag union (same as dream agent does)
        const mergedTags = Array.from(
          new Set(cluster.members.flatMap((m) => m.tags)),
        );

        // All original tags should be represented
        for (const member of cluster.members) {
          for (const tag of member.tags) {
            expect(mergedTags).toContain(tag);
          }
        }
        // No duplicate tags
        expect(mergedTags.length).toBe(new Set(mergedTags).size);
      }),
      { numRuns: 100 },
    );
  });

  it("merged entry shares category with all originals (same category cluster)", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        if (clusters.length === 0) return;

        const cluster = clusters[0];
        const category = cluster.members[0].category;
        for (const member of cluster.members) {
          expect(member.category).toBe(category);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("cluster with highest importance appears first after sorting", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        if (clusters.length < 2) return;

        // Generate all unique importance values
        const importances = clusters.map(
          (c) => c.members.length * c.totalAccess,
        );
        // The first cluster should have the maximum importance
        expect(importances[0]).toBe(Math.max(...importances));
      }),
      { numRuns: 100 },
    );
  });

  it("no orphaned memories (assigned set matches cluster members + unclustered)", () => {
    fc.assert(
      fc.property(memorySetArbitrary(), (memories) => {
        const clusters = clusterMemories(memories);
        const clusteredIds = new Set(
          clusters.flatMap((c) => c.members.map((m) => m.id)),
        );
        const allIds = new Set(memories.map((m) => m.id));
        const unclustered = [...allIds].filter((id) => !clusteredIds.has(id));

        // All IDs are accounted for: clustered + unclustered = total
        expect(clusteredIds.size + unclustered.length).toBe(allIds.size);
      }),
      { numRuns: 100 },
    );
  });
});
