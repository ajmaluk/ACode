/**
 * ACode Line Diff Engine
 *
 * Computes a proper LCS (Longest Common Subsequence) based line diff
 * between two texts, producing a list of diff lines categorized as
 * context (unchanged), add (new), or remove (deleted).
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
 * Compute LCS table for two arrays of strings.
 * Returns a 2D array where lcs[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1].
 */
function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  // Use two rows to save memory — but we need the full table for backtracking.
  // For large files, this is acceptable since it's O(m*n) in memory.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Backtrack through the LCS table to produce the diff operations.
 * Each operation is either: keep (line in both), delete (old only), insert (new only).
 */
type DiffOp =
  | { type: "keep"; oldIdx: number; newIdx: number }
  | { type: "delete"; oldIdx: number }
  | { type: "insert"; newIdx: number };

function backtrackLCS(
  dp: number[][],
  oldLines: string[],
  newLines: string[]
): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "keep", oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", newIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: "delete", oldIdx: i - 1 });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Compute a line-level diff between two texts.
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

  // For very large files, fall back to a simple comparison to avoid O(n^2) blowup
  if (oldLines.length * newLines.length > 10_000_000) {
    return computeSimpleDiff(oldLines, newLines);
  }

  const dp = computeLCS(oldLines, newLines);
  const ops = backtrackLCS(dp, oldLines, newLines);

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
