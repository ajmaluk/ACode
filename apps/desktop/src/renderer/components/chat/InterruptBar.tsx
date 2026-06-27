/**
 * ============================================================
 * INTERRUPT BAR — Interrupt & Redirect Agent Mid-Stream
 * ============================================================
 *
 * Shows a floating bar when the agent is streaming, allowing
 * the user to stop or redirect without losing context.
 * Addresses Issue #23 (No Interrupt-and-Redirect).
 * ============================================================
 */

import React, { useState, useRef, useEffect } from "react";
import { useChat } from "@/store/useAppStore";
import { Square, CornerDownRight } from "lucide-react";

export const InterruptBar: React.FC = () => {
  const [showRedirect, setShowRedirect] = useState(false);
  const [redirectText, setRedirectText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreaming = useChat((s) => s.isStreaming);
  const abort = useChat((s) => s.abort);
  const sendMessage = useChat((s) => s.sendMessage);
  const activeSessionId = useChat((s) => s.activeSessionId);

  useEffect(() => {
    if (showRedirect && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showRedirect]);

  if (!isStreaming || !activeSessionId) return null;

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50">
      {!showRedirect ? (
        <div className="flex items-center gap-2 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg px-4 py-2 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-dalam-accent-primary rounded-full animate-pulse" />
            <span className="text-sm text-dalam-text-secondary">Agent is working…</span>
          </div>
          <div className="h-4 w-px bg-dalam-border-primary" />
          <button
            onClick={() => setShowRedirect(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-dalam-accent-primary hover:bg-dalam-accent-primary/10 rounded transition-colors"
            title="Redirect the agent with a new instruction"
          >
            <CornerDownRight size={12} />
            Redirect
          </button>
          <button
            onClick={() => abort(activeSessionId)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-dalam-git-deleted hover:bg-dalam-git-deleted/10 rounded transition-colors"
            title="Stop the agent"
          >
            <Square size={10} />
            Stop
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-dalam-bg-secondary border border-dalam-accent-primary rounded-lg px-4 py-2 shadow-lg backdrop-blur-sm">
          <input
            ref={inputRef}
            type="text"
            value={redirectText}
            onChange={(e) => setRedirectText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && redirectText.trim()) {
                abort(activeSessionId);
                sendMessage(redirectText.trim());
                setRedirectText("");
                setShowRedirect(false);
              }
              if (e.key === "Escape") {
                setShowRedirect(false);
                setRedirectText("");
              }
            }}
            placeholder="Type redirect instruction…"
            className="bg-transparent text-sm outline-none flex-1 min-w-[200px] text-dalam-text-primary"
          />
          <button
            onClick={() => {
              if (redirectText.trim()) {
                abort(activeSessionId);
                sendMessage(redirectText.trim());
                setRedirectText("");
                setShowRedirect(false);
              }
            }}
            className="px-2 py-1 text-xs bg-dalam-accent-primary text-white rounded hover:bg-dalam-accent-primary/90 transition-colors"
          >
            Send ↵
          </button>
        </div>
      )}
    </div>
  );
};
