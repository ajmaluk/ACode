/**
 * ============================================================
 * MULTI-FILE DIFF — Batch Diff Approval Component
 * ============================================================
 *
 * Shows all file changes from an agent turn in a unified
 * diff view with approve/reject controls per file and batch.
 * Addresses Issue #22 (No Multi-File Diff Preview).
 * ============================================================
 */

import React, { useMemo } from "react";
import { useChat } from "@/store/useAppStore";
import { Check, X, FileText } from "lucide-react";

export const MultiFileDiffSummary: React.FC = () => {
  const pendingToolCalls = useChat((s) => s.pendingToolCalls);
  const resolveToolApproval = useChat((s) => s.resolveToolApproval);

  // Collect all pending diffs
  const pendingDiffs = useMemo(() => {
    return pendingToolCalls
      .filter((tc) => tc.diffId && tc.status === "awaiting-approval")
      .map((tc) => ({
        id: tc.id,
        diffId: tc.diffId!,
        filePath: tc.diff?.filePath ?? (tc.args.path as string) ?? "unknown",
        additions: tc.diff?.hunks?.reduce((n, h) => n + h.newLines, 0) ?? 0,
        deletions: tc.diff?.hunks?.reduce((n, h) => n + h.oldLines, 0) ?? 0,
      }));
  }, [pendingToolCalls]);

  if (pendingDiffs.length === 0) return null;

  const totalAdditions = pendingDiffs.reduce((s, d) => s + d.additions, 0);
  const totalDeletions = pendingDiffs.reduce((s, d) => s + d.deletions, 0);

  return (
    <div className="mx-4 mb-3 rounded-lg border border-dalam-border-primary bg-dalam-bg-secondary/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-dalam-border-primary bg-dalam-bg-secondary">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-dalam-text-primary">
            {pendingDiffs.length} file{pendingDiffs.length !== 1 ? "s" : ""} changed
          </span>
          <span className="text-xs text-dalam-git-added">+{totalAdditions}</span>
          <span className="text-xs text-dalam-git-deleted">-{totalDeletions}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const ids = pendingDiffs.map((d) => d.id);
              ids.forEach((id) => resolveToolApproval(id, "approved"));
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-dalam-git-added/80 hover:bg-dalam-git-added text-white rounded transition-colors"
          >
            <Check size={12} />
            Approve All
          </button>
          <button
            onClick={() => {
              const ids = pendingDiffs.map((d) => d.id);
              ids.forEach((id) => resolveToolApproval(id, "denied"));
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-dalam-git-deleted/80 hover:bg-dalam-git-deleted text-white rounded transition-colors"
          >
            <X size={12} />
            Reject All
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="divide-y divide-dalam-border-primary">
        {pendingDiffs.map((diff) => (
          <div
            key={diff.id}
            className="flex items-center justify-between px-3 py-1.5 hover:bg-dalam-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={14} className="text-dalam-text-muted shrink-0" />
              <span className="text-xs font-mono truncate text-dalam-text-primary">{diff.filePath}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-[10px] text-dalam-git-added">+{diff.additions}</span>
              <span className="text-[10px] text-dalam-git-deleted">-{diff.deletions}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => resolveToolApproval(diff.id, "approved")}
                  className="p-0.5 text-dalam-git-added hover:opacity-80 transition-colors"
                  title="Approve"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={() => resolveToolApproval(diff.id, "denied")}
                  className="p-0.5 text-dalam-git-deleted hover:opacity-80 transition-colors"
                  title="Reject"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
