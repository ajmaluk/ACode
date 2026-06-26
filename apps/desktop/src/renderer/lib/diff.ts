/**
 * Dalam Line Diff Engine — Myers' Algorithm
 *
 * Implements Myers' diff algorithm (O(ND)) which is significantly faster
 * than the naive O(m*n) LCS approach for typical code changes.
 * Falls back to patience diff for files with many identical lines.
 *
 * Reference: "An O(ND) Difference Algorithm and Its Variations" (Eugene Myers, 1986)
 */

export type DiffLineType = "context" | "add" | "remove";

export type ComputedDiffLine = {
  type: DiffLineType;
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
};

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ComputedDiffLine[];
};

export type DiffResult = {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

/**
 * Myers' diff algorithm — O(ND) where D is edit distance.
 * Much faster than LCS for small edits in large files.
 */
function myersDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  if (max === 0) return [];

  // For very large files with small changes, use patience diff
  if (max > 10000) {
    return patienceDiff(oldLines, newLines);
  }

  // Forward pass: find shortest edit script
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    const newV = new Map(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      newV.set(k, x);
      if (x >= n && y >= m) {
        trace.push(newV);
        return backtrack(trace, oldLines, newLines);
      }
    }
    trace.push(newV);
    for (const [key, val] of newV) v.set(key, val);
  }

  return [];
}

/**
 * Backtrack through Myers' trace to produce edit operations.
 */
function backtrack(trace: Map<number, number>[], oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // Diagonal (keep matching lines)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "keep", oldIdx: x, newIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insert
        y--;
        ops.push({ type: "insert", newIdx: y });
      } else {
        // Delete
        x--;
        ops.push({ type: "delete", oldIdx: x });
      }
    }
  }

  return ops.reverse();
}

/**
 * Patience diff — better for files with many identical lines.
 * Uses unique lines as anchors, then diffs between anchors.
 */
function patienceDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  // Find unique lines in both
  const oldUnique = new Map<string, number>();
  const newUnique = new Map<string, number>();

  for (let i = 0; i < oldLines.length; i++) {
    const line = oldLines[i];
    if (!oldUnique.has(line)) oldUnique.set(line, i);
    else oldUnique.set(line, -1); // mark as non-unique
  }
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    if (!newUnique.has(line)) newUnique.set(line, i);
    else newUnique.set(line, -1);
  }

  // Find common unique lines (anchors)
  const anchors: [number, number][] = [];
  for (const [line, oldIdx] of oldUnique) {
    if (oldIdx === -1) continue;
    const newIdx = newUnique.get(line);
    if (newIdx !== undefined && newIdx !== -1) {
      anchors.push([oldIdx, newIdx]);
    }
  }

  // Sort anchors by position
  anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Build LCS of anchors using patience sorting
  const lcs = patienceLCS(anchors);

  // Convert anchors to edit operations
  const ops: DiffOp[] = [];
  let prevOld = 0;
  let prevNew = 0;

  for (const [oldIdx, newIdx] of lcs) {
    // Diff between previous anchor and this one
    const subOld = oldLines.slice(prevOld, oldIdx);
    const subNew = newLines.slice(prevNew, newIdx);
    const subOps = myersDiffSimple(subOld, subNew, prevOld, prevNew);
    ops.push(...subOps);

    // Keep the anchor line
    ops.push({ type: "keep", oldIdx, newIdx });

    prevOld = oldIdx + 1;
    prevNew = newIdx + 1;
  }

  // Diff remaining lines after last anchor
  const subOld = oldLines.slice(prevOld);
  const subNew = newLines.slice(prevNew);
  ops.push(...myersDiffSimple(subOld, subNew, prevOld, prevNew));

  return ops;
}

/**
 * Simple Myers diff for small segments (used by patience diff).
 */
function myersDiffSimple(oldLines: string[], newLines: string[], oldOffset: number, newOffset: number): DiffOp[] {
  const ops = myersDiff(oldLines, newLines);
  return ops.map(op => {
    if (op.type === "keep") return { ...op, oldIdx: op.oldIdx + oldOffset, newIdx: op.newIdx + newOffset };
    if (op.type === "delete") return { ...op, oldIdx: op.oldIdx + oldOffset };
    return { ...op, newIdx: op.newIdx + newOffset };
  });
}

/**
 * Patience LCS — longest increasing subsequence of anchor positions.
 * Uses patience sorting for O(n log n) LIS computation.
 */
function patienceLCS(anchors: [number, number][]): [number, number][] {
  if (anchors.length === 0) return [];

  // Standard patience-sorting LIS on the newIdx values
  // tails[i] = smallest tail value for an increasing subsequence of length i+1
  const tails: number[] = [];
  // For each anchor, which pile it was placed on (= LIS length ending at this element)
  const pileOf: number[] = [];

  for (const anchor of anchors) {
    const val = anchor[1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < val) lo = mid + 1;
      else hi = mid;
    }
    pileOf.push(lo);
    if (lo === tails.length) tails.push(val);
    else tails[lo] = val;
  }

  // Trace back: pick one element per pile level in reverse
  const lisLength = tails.length;
  const result: [number, number][] = [];
  let currentLevel = lisLength - 1;
  for (let i = anchors.length - 1; i >= 0 && currentLevel >= 0; i--) {
    if (pileOf[i] === currentLevel) {
      result.unshift(anchors[i]);
      currentLevel--;
    }
  }

  return result;
}

/**
 * Type operation for diff.
 */
type DiffOp =
  | { type: "keep"; oldIdx: number; newIdx: number }
  | { type: "delete"; oldIdx: number }
  | { type: "insert"; newIdx: number };

/**
 * Compute a line-level diff between two texts using Myers' algorithm.
 *
 * @param oldText - The original text
 * @param newText - The modified text
 * @param contextLines - Number of unchanged context lines to show around each hunk (default 3)
 * @returns DiffResult with hunks, addition count, and deletion count
 */
export function computeDiff(
  oldText: string,
  newText: string,
  contextLines: number = 3
): DiffResult {
  if (oldText === newText) {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // For very large files, fall back to simple comparison
  if (oldLines.length + newLines.length > 50000) {
    return computeSimpleDiff(oldLines, newLines);
  }

  // Use Myers' algorithm (automatically falls back to patience for large files)
  const ops = myersDiff(oldLines, newLines);

  // Convert ops to computed diff lines
  const diffLines: (ComputedDiffLine & { op: DiffOp })[] = [];
  let additions = 0;
  let deletions = 0;

  for (const op of ops) {
    switch (op.type) {
      case "keep":
        diffLines.push({
          type: "context",
          content: oldLines[op.oldIdx],
          oldLineNum: op.oldIdx + 1,
          newLineNum: op.newIdx + 1,
          op,
        });
        break;
      case "delete":
        diffLines.push({
          type: "remove",
          content: oldLines[op.oldIdx],
          oldLineNum: op.oldIdx + 1,
          newLineNum: null,
          op,
        });
        deletions++;
        break;
      case "insert":
        diffLines.push({
          type: "add",
          content: newLines[op.newIdx],
          oldLineNum: null,
          newLineNum: op.newIdx + 1,
          op,
        });
        additions++;
        break;
    }
  }

  // Group into hunks with context
  const hunks = groupIntoHunks(diffLines, contextLines);

  return { hunks, additions, deletions };
}

/**
 * Group diff lines into hunks, showing `contextLines` of unchanged lines
 * around each change. Adjacent hunks that overlap in context are merged.
 */
function groupIntoHunks(
  diffLines: (ComputedDiffLine & { op: DiffOp })[],
  contextLines: number
): DiffHunk[] {
  if (diffLines.length === 0) return [];

  // Find indices of changed lines
  const changeIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Build hunk ranges with context
  const ranges: [number, number][] = [];
  for (const ci of changeIndices) {
    const start = Math.max(0, ci - contextLines);
    const end = Math.min(diffLines.length - 1, ci + contextLines);

    if (ranges.length > 0) {
      const lastRange = ranges[ranges.length - 1];
      // Merge if overlapping or adjacent
      if (start <= lastRange[1] + 1) {
        lastRange[1] = Math.max(lastRange[1], end);
        continue;
      }
    }
    ranges.push([start, end]);
  }

  // Convert ranges to hunks
  const hunks: DiffHunk[] = [];
  for (const [start, end] of ranges) {
    const hunkLines = diffLines.slice(start, end + 1);

    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;

    for (const line of hunkLines) {
      if (line.oldLineNum !== null) {
        if (oldStart === 0) oldStart = line.oldLineNum;
      }
      if (line.newLineNum !== null) {
        if (newStart === 0) newStart = line.newLineNum;
      }
      if (line.type === "context" || line.type === "remove") oldCount++;
      if (line.type === "context" || line.type === "add") newCount++;
    }

    // If start was 0 (e.g., all removed lines), compute from line numbers
    if (oldStart === 0) {
      // Find the first line with an oldLineNum in the next hunk, or derive
      oldStart = 1;
    }
    if (newStart === 0) {
      newStart = 1;
    }

    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Simple fallback diff for very large files — just marks everything as changed.
 */
function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffResult {
  const lines: ComputedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < oldLines.length && i < newLines.length) {
      if (oldLines[i] === newLines[i]) {
        lines.push({
          type: "context",
          content: oldLines[i],
          oldLineNum: i + 1,
          newLineNum: i + 1,
        });
      } else {
        lines.push({
          type: "remove",
          content: oldLines[i],
          oldLineNum: i + 1,
          newLineNum: null,
        });
        deletions++;
        lines.push({
          type: "add",
          content: newLines[i],
          oldLineNum: null,
          newLineNum: i + 1,
        });
        additions++;
      }
    } else if (i < oldLines.length) {
      lines.push({
        type: "remove",
        content: oldLines[i],
        oldLineNum: i + 1,
        newLineNum: null,
      });
      deletions++;
    } else {
      lines.push({
        type: "add",
        content: newLines[i],
        oldLineNum: null,
        newLineNum: i + 1,
      });
      additions++;
    }
  }

  // Group into a single hunk for simplicity
  if (lines.length === 0) {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  return {
    hunks: [
      {
        oldStart: 1,
        oldCount: oldLines.length,
        newStart: 1,
        newCount: newLines.length,
        lines,
      },
    ],
    additions,
    deletions,
  };
}
