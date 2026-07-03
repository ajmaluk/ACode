import React, { useState } from "react";
import {
  X, FileCode, ChevronDown, Loader2,
  RotateCcw, History,
} from "lucide-react";

// ============================================================================
// VersionRestoreBar — banner shown when viewing a historical version
// ============================================================================
export function VersionRestoreBar({ restoredVersionId, activeSessionId, sessionVersions, onConfirm, onCancel }: {
  restoredVersionId: string;
  activeSessionId: string;
  sessionVersions: Record<string, import("@dalam/shared-types").ChatVersion[]>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const versions = sessionVersions[activeSessionId] ?? [];
  const ver = versions.find((v) => v.id === restoredVersionId);
  if (!ver) return null;
  return (
    <div className="px-3 pt-1.5 pb-0 flex-shrink-0 bg-dalam-bg-primary">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-dalam-accent-subtle/40 border border-dalam-accent-primary/20 rounded-lg text-xs">
        <History className="w-3.5 h-3.5 text-dalam-accent-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-dalam-text-primary font-medium truncate">{ver.label}</span>
          <span className="text-dalam-text-muted ml-1.5">· {ver.messages.length} message{ver.messages.length !== 1 ? "s" : ""}</span>
        </div>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-dalam-accent-primary/10 hover:bg-dalam-accent-primary/20 text-dalam-accent-primary rounded-md transition-colors"
          title="Reset to this version"
          onClick={onConfirm}
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset</span>
        </button>
        <button
          className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
          title="Cancel and return to current"
          onClick={onCancel}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ResetConfirmDialog — modal to confirm message reset with file change preview
// ============================================================================
export function ResetConfirmDialog({ fileChanges, loading, onConfirm, onCancel }: {
  fileChanges: { path: string; action: string; additions: number; deletions: number }[];
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="w-[440px] max-h-[70vh] bg-dalam-bg-primary border border-dalam-border-primary rounded-xl shadow-2xl flex flex-col overflow-hidden animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-dalam-border-primary flex items-center gap-2">
          {loading ? (
            <Loader2 className="w-4 h-4 text-dalam-accent-primary animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4 text-dalam-accent-primary" />
          )}
          <h3 className="text-sm font-semibold text-dalam-text-primary">
            {loading ? "Computing changes..." : "Reset to this message"}
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-xs text-dalam-text-muted">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Analyzing file changes...
            </div>
          ) : fileChanges.length === 0 ? (
            <div className="text-center text-xs text-dalam-text-muted py-8">No file changes will be reverted.</div>
          ) : (
            <div className="space-y-1">
              <div className="text-[11px] text-dalam-text-muted mb-2">
                The following files will be reverted:
              </div>
              {fileChanges.map((fc) => (
                <div key={fc.path} className="border border-dalam-border-primary/50 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-dalam-bg-hover transition-colors"
                    onClick={() => toggleFile(fc.path)}
                  >
                    <ChevronDown className={`w-3 h-3 text-dalam-text-muted transition-transform flex-shrink-0 ${expandedFiles.has(fc.path) ? "" : "-rotate-90"}`} />
                    <FileCode className="w-3 h-3 text-dalam-text-muted flex-shrink-0" />
                    <span className="flex-1 min-w-0 text-xs text-dalam-text-primary truncate font-mono">{fc.path}</span>
                    {fc.additions > 0 && <span className="text-[10px] text-dalam-git-added font-mono">+{fc.additions}</span>}
                    {fc.deletions > 0 && <span className="text-[10px] text-dalam-git-deleted font-mono">-{fc.deletions}</span>}
                  </button>
                  {expandedFiles.has(fc.path) && (
                    <div className="px-3 pb-2 text-[10px] text-dalam-text-muted border-t border-dalam-border-primary/30 pt-1">
                      <div className="flex items-center gap-3">
                        <span className="text-dalam-text-secondary">{fc.action}</span>
                        <span className="text-dalam-git-added">+{fc.additions} added</span>
                        <span className="text-dalam-git-deleted">-{fc.deletions} removed</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-dalam-border-primary flex items-center justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-lg transition-colors"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            onClick={onConfirm}
            disabled={loading}
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// RestorePopup — notification after reset with restore option
// ============================================================================
export function RestorePopup({ removedMessages, onRestore, onDismiss }: {
  removedMessages: import("@dalam/shared-types").ChatMessage[];
  onRestore: () => void;
  onDismiss: () => void;
}) {
  if (removedMessages.length === 0) return null;
  const userMsgCount = removedMessages.filter((m) => m.role === "user").length;
  const assistantMsgCount = removedMessages.filter((m) => m.role === "assistant").length;
  return (
    <div className="mb-2 px-3">
      <div className="max-w-2xl mx-auto bg-dalam-bg-secondary border border-dalam-accent-primary/30 rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 animate-fade-in">
        <History className="w-3.5 h-3.5 text-dalam-accent-primary flex-shrink-0" />
        <div className="flex-1 min-w-0 text-[11px] text-dalam-text-secondary">
          <span className="text-dalam-text-primary font-medium">{removedMessages.length} message{removedMessages.length !== 1 ? "s" : ""}</span>
          {" "}removed ({userMsgCount} user, {assistantMsgCount} assistant)
        </div>
        <button
          className="px-2 py-1 text-[11px] bg-dalam-accent-primary/10 hover:bg-dalam-accent-primary/20 text-dalam-accent-primary rounded-md transition-colors font-medium"
          onClick={onRestore}
        >
          Restore
        </button>
        <button
          className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
          onClick={onDismiss}
          title="Dismiss"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
