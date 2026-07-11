/**
 * ============================================================
 * MULTI-FILE DIFF — Inline Diff Preview Component
 * ============================================================
 *
 * Shows all file changes from an agent turn with expandable
 * inline diff hunks, approve/reject controls per file and batch.
 * ============================================================
 */

import React, { useMemo, useState, useEffect, useRef } from "react";
import { useChat } from "@/store/useAppStore";
import type { DiffProposal } from "@dalam/shared-types";
import { Check, X, FileText, ChevronDown, ChevronRight } from "lucide-react";

interface PendingDiffInfo {
  id: string;
  diffId: string;
  filePath: string;
  additions: number;
  deletions: number;
  diff?: DiffProposal;
}

function InlineDiffHunks({ diff }: { diff: DiffProposal }) {
  const [expanded, setExpanded] = useState(false);
  const maxLines = 20;
  const allLines = diff.hunks.flatMap((h) => h.lines);
  const truncated = allLines.length > maxLines && !expanded;
  const visibleLines = truncated ? allLines.slice(0, maxLines) : allLines;

  if (allLines.length === 0) return null;

  return (
    <div className="ml-6 mb-1">
      <div className="font-mono text-[11px] leading-[18px] bg-dalam-bg-primary/50 rounded border border-dalam-border-primary overflow-x-auto">
        {visibleLines.map((line, i) => (
          <div
            key={i}
            className={`px-2 ${
              line.type === "add"
                ? "bg-dalam-git-added/10 text-dalam-git-added"
                : line.type === "remove"
                  ? "bg-dalam-git-deleted/10 text-dalam-git-deleted"
                  : "text-dalam-text-secondary"
            }`}
          >
            <span className="inline-block w-4 text-right mr-2 opacity-40">
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
            </span>
            {line.content}
          </div>
        ))}
        {truncated && (
          <button
            onClick={() => setExpanded(true)}
            className="w-full px-2 py-0.5 text-dalam-accent hover:underline text-left"
          >
            ... {allLines.length - maxLines} more lines
          </button>
        )}
      </div>
    </div>
  );
}

export const MultiFileDiffSummary: React.FC = () => {
  const pendingToolCalls = useChat((s) => s.pendingToolCalls);
  const resolveToolApproval = useChat((s) => s.resolveToolApproval);
  const [batchResolving, setBatchResolving] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingDiffs: PendingDiffInfo[] = useMemo(() => {
    return pendingToolCalls
      .filter((tc) => tc.diffId && tc.status === "awaiting-approval")
      .map((tc) => ({
        id: tc.id,
        diffId: tc.diffId!,
        filePath: tc.diff?.filePath ?? (tc.args.path as string) ?? "unknown",
        additions: tc.diff?.hunks?.reduce((n, h) => n + h.newLines, 0) ?? 0,
        deletions: tc.diff?.hunks?.reduce((n, h) => n + h.oldLines, 0) ?? 0,
        diff: tc.diff,
      }));
  }, [pendingToolCalls]);

  if (pendingDiffs.length === 0) return null;

  const totalAdditions = pendingDiffs.reduce((s, d) => s + d.additions, 0);
  const totalDeletions = pendingDiffs.reduce((s, d) => s + d.deletions, 0);

  const toggleFile = (id: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mx-4 mb-3 rounded-lg border border-dalam-border-primary bg-dalam-bg-secondary/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-dalam-border-primary bg-dalam-bg-secondary">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-dalam-text-primary">
            {pendingDiffs.length} file{pendingDiffs.length !== 1 ? "s" : ""}{" "}
            changed
          </span>
          <span className="text-xs text-dalam-git-added">
            +{totalAdditions}
          </span>
          <span className="text-xs text-dalam-git-deleted">
            -{totalDeletions}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setBatchResolving(true);
              try {
                const ids = pendingDiffs.map((d) => d.id);
                await Promise.allSettled(
                  ids.map((id) => resolveToolApproval(id, "approved")),
                );
              } catch (e) {
                if (import.meta.env.DEV) console.warn("[MultiFileDiff] Batch approve failed:", e);
              } finally {
                if (mountedRef.current) setBatchResolving(false);
              }
            }}
            disabled={batchResolving}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-dalam-git-added/80 hover:bg-dalam-git-added text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={12} />
            Approve All
          </button>
          <button
            onClick={async () => {
              setBatchResolving(true);
              try {
                const ids = pendingDiffs.map((d) => d.id);
                await Promise.allSettled(
                  ids.map((id) => resolveToolApproval(id, "denied")),
                );
              } catch (e) {
                if (import.meta.env.DEV) console.warn("[MultiFileDiff] Batch deny failed:", e);
              } finally {
                if (mountedRef.current) setBatchResolving(false);
              }
            }}
            disabled={batchResolving}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-dalam-git-deleted/80 hover:bg-dalam-git-deleted text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X size={12} />
            Reject All
          </button>
        </div>
      </div>

      {/* File list with inline diffs */}
      <div className="divide-y divide-dalam-border-primary">
        {pendingDiffs.map((diff) => {
          const isExpanded = expandedFiles.has(diff.id);
          return (
            <div
              key={diff.id}
              className="hover:bg-dalam-bg-hover transition-colors"
            >
              <div className="flex items-center justify-between px-3 py-1.5">
                <button
                  onClick={() => toggleFile(diff.id)}
                  className="flex items-center gap-2 min-w-0 text-left"
                >
                  {diff.diff && diff.diff.hunks.length > 0 ? (
                    isExpanded ? (
                      <ChevronDown
                        size={12}
                        className="text-dalam-text-muted shrink-0"
                      />
                    ) : (
                      <ChevronRight
                        size={12}
                        className="text-dalam-text-muted shrink-0"
                      />
                    )
                  ) : (
                    <FileText
                      size={14}
                      className="text-dalam-text-muted shrink-0"
                    />
                  )}
                  <span className="text-xs font-mono truncate text-dalam-text-primary">
                    {diff.filePath}
                  </span>
                </button>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-dalam-git-added">
                    +{diff.additions}
                  </span>
                  <span className="text-[10px] text-dalam-git-deleted">
                    -{diff.deletions}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { void resolveToolApproval(diff.id, "approved"); }}
                      className="p-0.5 text-dalam-git-added hover:opacity-80 transition-colors"
                      title="Approve"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      onClick={() => { void resolveToolApproval(diff.id, "denied"); }}
                      className="p-0.5 text-dalam-git-deleted hover:opacity-80 transition-colors"
                      title="Reject"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              </div>
              {isExpanded && diff.diff && <InlineDiffHunks diff={diff.diff} />}
            </div>
          );
        })}
      </div>
    </div>
  );
};
