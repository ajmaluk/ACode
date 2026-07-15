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

type DiffOp =
  | { type: "keep"; oldIdx: number; newIdx: number }
  | { type: "delete"; oldIdx: number }
  | { type: "insert"; newIdx: number };

/**
 * Myers' diff algorithm — O(ND) where D is edit distance.
 * Uses the standard trace-based approach: stores the v map at each depth
 * (BEFORE processing each step) so the backtrack can reconstruct the path
 * by walking the trace in reverse.
 */
function myersDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  if (max === 0) return [];

  if (max > 10000) {
    return patienceDiff(oldLines, newLines);
  }

  // Trace stores the v map BEFORE processing each depth level.
  // trace[d][k] = x value at depth d for diagonal k, before the snake.
  const trace: Map<number, number>[] = [];
  const v = new Map<number, number>();
  v.set(1, 0);

  for (let d = 0; d <= max; d++) {
    // vPrev at start of step d — store BEFORE computing k values
    const vPrev = new Map(v);
    trace.push(vPrev);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (vPrev.get(k - 1) ?? -Infinity) < (vPrev.get(k + 1) ?? -Infinity))) {
        // INSERT: came from k+1, x stays the same
        x = vPrev.get(k + 1) ?? 0;
      } else {
        // DELETE: came from k-1, x increases by 1
        x = (vPrev.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      // Extend the snake (common lines)
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        return backtrackTrace(trace, oldLines, newLines, d, k);
      }
    }
  }

  return [];
}

/**
 * Backtrack through the trace to reconstruct the edit path.
 * trace[d] is the v map BEFORE step d, containing all k values reachable
 * at that depth. We walk from (n, m) back to (0, 0) by determining,
 * at each depth, which k value was the predecessor.
 */
function backtrackTrace(
  trace: Map<number, number>[],
  oldLines: string[],
  newLines: string[],
  endD: number,
  endK: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = oldLines.length;
  let y = newLines.length;
  let k = endK;

  // trace[endD] was stored BEFORE the end step's k values were computed.
  // The end state (n, m) was reached during step endD on diagonal k.
  // So we start backtracking from endD down to 0.
  for (let d = endD; d >= 0; d--) {
    const vPrev = trace[d];

    // Determine which predecessor was used in the forward pass
    let prevK: number;
    if (k === -d) {
      prevK = k + 1; // bottom edge → must come from k+1 (INSERT)
    } else if (k !== d && (vPrev.get(k - 1) ?? -Infinity) < (vPrev.get(k + 1) ?? -Infinity)) {
      prevK = k + 1; // came from k+1 (INSERT)
    } else {
      prevK = k - 1; // came from k-1 (DELETE)
    }

    const prevX = vPrev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // Pop common lines (the snake at this depth)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "keep", oldIdx: x, newIdx: y });
    }

    // Add the edit operation for this transition
    if (d > 0) {
      if (prevK === k - 1) {
        // DELETE: x increased by 1 between prev and current
        x--;
        ops.push({ type: "delete", oldIdx: x });
      } else {
        // INSERT: y increased by 1 between prev and current
        y--;
        ops.push({ type: "insert", newIdx: y });
      }
    }

    k = prevK;
  }

  return ops.reverse();
}

function patienceDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const oldUnique = new Map<string, number>();
  const newUnique = new Map<string, number>();

  for (let i = 0; i < oldLines.length; i++) {
    const line = oldLines[i];
    if (!oldUnique.has(line)) oldUnique.set(line, i);
    else oldUnique.set(line, -1);
  }
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];
    if (!newUnique.has(line)) newUnique.set(line, i);
    else newUnique.set(line, -1);
  }

  const anchors: [number, number][] = [];
  for (const [line, oldIdx] of oldUnique) {
    if (oldIdx === -1) continue;
    const newIdx = newUnique.get(line);
    if (newIdx !== undefined && newIdx !== -1) {
      anchors.push([oldIdx, newIdx]);
    }
  }

  anchors.sort((a, b) => a[0] - b[0]);
  const lisAnchors = patienceLIS(anchors);
  const lcs = patienceLCS(lisAnchors);

  const ops: DiffOp[] = [];
  let prevOld = 0;
  let prevNew = 0;

  for (const [oldIdx, newIdx] of lcs) {
    if (oldIdx < prevOld || newIdx < prevNew) continue;

    const subOld = oldLines.slice(prevOld, oldIdx);
    const subNew = newLines.slice(prevNew, newIdx);
    const subOps = myersDiffSimple(subOld, subNew, prevOld, prevNew);
    ops.push(...subOps);

    ops.push({ type: "keep", oldIdx, newIdx });

    prevOld = oldIdx + 1;
    prevNew = newIdx + 1;
  }

  const subOld = oldLines.slice(prevOld);
  const subNew = newLines.slice(prevNew);
  ops.push(...myersDiffSimple(subOld, subNew, prevOld, prevNew));

  return ops;
}

function patienceLIS(anchors: [number, number][]): [number, number][] {
  if (anchors.length === 0) return [];
  const tails: number[] = [];
  const backlinks: number[] = new Array(anchors.length).fill(-1);
  const tailIndices: number[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const newIdx = anchors[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < newIdx) lo = mid + 1;
      else hi = mid;
    }
    if (lo === tails.length) {
      tails.push(newIdx);
      tailIndices.push(i);
    } else {
      tails[lo] = newIdx;
      tailIndices[lo] = i;
    }
    backlinks[i] = lo > 0 ? tailIndices[lo - 1] : -1;
  }

  const result: [number, number][] = [];
  let idx = tailIndices[tailIndices.length - 1];
  while (idx !== -1) {
    result.unshift(anchors[idx]);
    idx = backlinks[idx];
  }
  return result;
}

function myersDiffSimple(
  oldLines: string[],
  newLines: string[],
  oldOffset: number,
  newOffset: number,
): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n + m <= 1000) {
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
      new Array(m + 1).fill(0),
    );
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] =
          oldLines[i - 1] === newLines[j - 1]
            ? dp[i - 1][j - 1] + 1
            : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const ops: DiffOp[] = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        ops.push({
          type: "keep",
          oldIdx: i - 1 + oldOffset,
          newIdx: j - 1 + newOffset,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push({ type: "insert", newIdx: j - 1 + newOffset });
        j--;
      } else {
        ops.push({ type: "delete", oldIdx: i - 1 + oldOffset });
        i--;
      }
    }
    return ops.reverse();
  }

  const CHUNK_SIZE = 500;

  function lcsChunkDiff(
    oldChunk: string[],
    newChunk: string[],
    baseOldIdx: number,
    baseNewIdx: number,
  ): DiffOp[] {
    const cn = oldChunk.length;
    const cm = newChunk.length;
    const dp: number[][] = Array.from({ length: cn + 1 }, () =>
      new Array(cm + 1).fill(0),
    );
    for (let i = 1; i <= cn; i++) {
      for (let j = 1; j <= cm; j++) {
        dp[i][j] =
          oldChunk[i - 1] === newChunk[j - 1]
            ? dp[i - 1][j - 1] + 1
            : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const chunkOps: DiffOp[] = [];
    let i = cn, j = cm;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldChunk[i - 1] === newChunk[j - 1]) {
        chunkOps.push({
          type: "keep",
          oldIdx: i - 1 + baseOldIdx,
          newIdx: j - 1 + baseNewIdx,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        chunkOps.push({ type: "insert", newIdx: j - 1 + baseNewIdx });
        j--;
      } else {
        chunkOps.push({ type: "delete", oldIdx: i - 1 + baseOldIdx });
        i--;
      }
    }
    return chunkOps.reverse();
  }

  const ops: DiffOp[] = [];
  let oldPos = 0;
  let newPos = 0;
  while (oldPos < n || newPos < m) {
    const oldChunk = oldLines.slice(oldPos, oldPos + CHUNK_SIZE);
    const newChunk = newLines.slice(newPos, newPos + CHUNK_SIZE);
    const cn = oldChunk.length;
    const cm = newChunk.length;
    ops.push(
      ...lcsChunkDiff(oldChunk, newChunk, oldPos + oldOffset, newPos + newOffset),
    );
    oldPos += cn;
    newPos += cm;
  }
  return ops;
}

function patienceLCS(anchors: [number, number][]): [number, number][] {
  if (anchors.length === 0) return [];

  const tails: number[] = [];
  const pileOf: number[] = [];
  const prev: number[] = new Array(anchors.length).fill(-1);
  const pileTails: number[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const val = anchors[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < val) lo = mid + 1;
      else hi = mid;
    }
    pileOf.push(lo);
    if (lo === tails.length) {
      tails.push(val);
      pileTails.push(i);
    } else {
      tails[lo] = val;
      pileTails[lo] = i;
    }
    prev[i] = lo > 0 ? pileTails[lo - 1] : -1;
  }

  const lisLength = tails.length;
  const result: [number, number][] = [];
  let idx = pileTails[lisLength - 1];
  while (idx !== -1 && idx !== undefined) {
    result.unshift(anchors[idx]);
    idx = prev[idx];
  }

  return result;
}

/**
 * Compute a line-level diff between two texts using Myers' algorithm.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  contextLines: number = 3,
): DiffResult {
  if (oldText === newText) {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  if (oldText === "") {
    const newLines = newText.split("\n");
    if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
      return { hunks: [], additions: 0, deletions: 0 };
    }
    const diffLines: ComputedDiffLine[] = newLines.map((content, i) => ({
      type: "add" as const,
      content,
      oldLineNum: null,
      newLineNum: i + 1,
    }));
    return {
      hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: newLines.length, lines: diffLines }],
      additions: newLines.length,
      deletions: 0,
    };
  }

  if (newText === "") {
    const oldLines = oldText.split("\n");
    const diffLines: ComputedDiffLine[] = oldLines.map((content, i) => ({
      type: "remove" as const,
      content,
      oldLineNum: i + 1,
      newLineNum: null,
    }));
    return {
      hunks: [{ oldStart: 1, oldCount: oldLines.length, newStart: 1, newCount: 0, lines: diffLines }],
      additions: 0,
      deletions: oldLines.length,
    };
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length + newLines.length > 50000) {
    return computeSimpleDiff(oldLines, newLines);
  }

  const ops = myersDiff(oldLines, newLines);

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

  const hunks = groupIntoHunks(diffLines, contextLines);

  return { hunks, additions, deletions };
}

function groupIntoHunks(
  diffLines: (ComputedDiffLine & { op: DiffOp })[],
  contextLines: number,
): DiffHunk[] {
  if (diffLines.length === 0) return [];

  const changeIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const ci of changeIndices) {
    const start = Math.max(0, ci - contextLines);
    const end = Math.min(diffLines.length - 1, ci + contextLines);

    if (ranges.length > 0) {
      const lastRange = ranges[ranges.length - 1];
      if (start <= lastRange[1] + 1) {
        lastRange[1] = Math.max(lastRange[1], end);
        continue;
      }
    }
    ranges.push([start, end]);
  }

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

    if (oldStart === 0) oldStart = 1;
    if (newStart === 0) newStart = 1;

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

function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffResult {
  const n = oldLines.length;
  const m = newLines.length;

  // Trim common prefix and suffix to reduce the DP problem size.
  // For large files with small changes (the typical case), this brings
  // O(n*m) down to O(k*l) where k,l are the changed region sizes.
  let prefixLen = 0;
  while (prefixLen < n && prefixLen < m && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < n - prefixLen &&
    suffixLen < m - prefixLen &&
    oldLines[n - 1 - suffixLen] === newLines[m - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const innerOld = oldLines.slice(prefixLen, n - suffixLen);
  const innerNew = newLines.slice(prefixLen, m - suffixLen);
  const innerN = innerOld.length;
  const innerM = innerNew.length;

  // If there's no changed region, return empty diff
  if (innerN === 0 && innerM === 0) {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  const lines: ComputedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  // Add common prefix lines
  for (let p = 0; p < prefixLen; p++) {
    lines.push({
      type: "context",
      content: oldLines[p],
      oldLineNum: p + 1,
      newLineNum: p + 1,
    });
  }

  // Compute LCS on the inner (changed) region
  const dp: number[][] = Array.from({ length: innerN + 1 }, () =>
    new Array(innerM + 1).fill(0),
  );
  for (let i = 1; i <= innerN; i++) {
    for (let j = 1; j <= innerM; j++) {
      dp[i][j] =
        innerOld[i - 1] === innerNew[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops: { type: "keep" | "remove" | "add"; oldIdx?: number; newIdx?: number }[] = [];
  let i = innerN, j = innerM;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && innerOld[i - 1] === innerNew[j - 1]) {
      ops.push({ type: "keep", oldIdx: i - 1 + prefixLen, newIdx: j - 1 + prefixLen });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", newIdx: j - 1 + prefixLen });
      j--;
    } else {
      ops.push({ type: "remove", oldIdx: i - 1 + prefixLen });
      i--;
    }
  }

  for (let idx = ops.length - 1; idx >= 0; idx--) {
    const op = ops[idx];
    switch (op.type) {
      case "keep":
        lines.push({
          type: "context",
          content: oldLines[op.oldIdx!],
          oldLineNum: op.oldIdx! + 1,
          newLineNum: op.newIdx! + 1,
        });
        break;
      case "remove":
        lines.push({
          type: "remove",
          content: oldLines[op.oldIdx!],
          oldLineNum: op.oldIdx! + 1,
          newLineNum: null,
        });
        deletions++;
        break;
      case "add":
        lines.push({
          type: "add",
          content: newLines[op.newIdx!],
          oldLineNum: null,
          newLineNum: op.newIdx! + 1,
        });
        additions++;
        break;
    }
  }

  // Add common suffix lines
  for (let s = 0; s < suffixLen; s++) {
    const oldIdx = n - suffixLen + s;
    const newIdx = m - suffixLen + s;
    lines.push({
      type: "context",
      content: oldLines[oldIdx],
      oldLineNum: oldIdx + 1,
      newLineNum: newIdx + 1,
    });
  }

  if (lines.length === 0) {
    return { hunks: [], additions: 0, deletions: 0 };
  }

  return {
    hunks: [{ oldStart: 1, oldCount: oldLines.length, newStart: 1, newCount: newLines.length, lines }],
    additions,
    deletions,
  };
}
