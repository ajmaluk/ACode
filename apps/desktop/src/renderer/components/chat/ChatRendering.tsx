import React, { useState, useCallback } from "react";
import { FileCode } from "lucide-react";
import { useWorkspace, useUI } from "@/store/useAppStore";
import { useToast } from "@/components/ui/toastStore";
import { basename } from "@/lib/pathUtils";
import { splitCodeFences } from "@/lib/chatUtils";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

// Module-level escapeHtml — stable reference, never recreated per render
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MARKDOWN_COMPONENTS: Record<string, any> = {
  p: ({ children }: { children: React.ReactNode }) => <p className="whitespace-pre-wrap break-words mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-dalam-text-primary">{children}</strong>,
  em: ({ children }: { children: React.ReactNode }) => <em className="italic">{children}</em>,
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children: React.ReactNode }) => (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        if (!href) return;
        try {
          const parsed = new URL(href);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            e.preventDefault();
            const ui = useUI.getState();
            ui.addBrowserTab({ url: href });
            ui.setRightPanelTab("browser");
            if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
          }
        } catch {
          // Invalid URL — let the browser handle it normally
        }
      }}
      className="text-dalam-accent-primary hover:underline cursor-pointer"
    >{children}</a>
  ),
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="text-dalam-text-secondary">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-lg font-bold mb-2 text-dalam-text-primary">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-base font-bold mb-2 text-dalam-text-primary">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-sm font-bold mb-1 text-dalam-text-primary">{children}</h3>,
  code: ({ children, className }: { children: React.ReactNode; className?: string }) => {
    const isInline = !className;
    if (isInline) {
      return <code className="px-1 py-0.5 bg-dalam-bg-tertiary rounded text-[12px] font-mono text-dalam-accent-primary">{children}</code>;
    }
    return <code className={className}>{children}</code>;
  },
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-dalam-accent-primary/40 pl-3 my-2 text-dalam-text-muted italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-dalam-border-primary" />,
  table: ({ children }: { children: React.ReactNode }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse">{children}</table></div>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-2 py-1 border border-dalam-border-primary text-left font-medium">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-2 py-1 border border-dalam-border-primary">{children}</td>,
};

export const MarkdownContent = React.memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
});

// Lightweight streaming renderer — avoids expensive react-markdown re-parsing on each delta.
// For short content (under 100 chars), uses full MarkdownContent since the cost is negligible.
// For longer content during streaming, uses splitCodeFences to only highlight code blocks,
// skipping the full react-markdown parse on every delta.
export const StreamingContent = React.memo(function StreamingContent({ content, pending }: { content: string; pending: boolean }) {
  // During streaming, content under ~100 chars is likely a fragment or thinking indicator
  // where full markdown parsing is fine. Longer content benefits from fence-split optimization.
  if (!pending || content.length < 100) {
    return <MarkdownContent content={content} />;
  }
  const segments = splitCodeFences(content);
  return (
    <div className="prose-dalam mb-2 last:mb-0">
      {segments.map((seg, idx) =>
        seg.type === "code"
          ? <StreamingCodeBlock key={"sc-" + idx} language={seg.language ?? ""} content={seg.content} />
          : <p key={"st-" + idx} className="whitespace-pre-wrap break-words mb-2 last:mb-0 leading-relaxed">{seg.content}</p>
      )}
    </div>
  );
});

export const CodeBlock = React.memo(function CodeBlock({ language, content }: { language: string; content: string }) {
  const toast = useToast();
  const activeFilePath = useWorkspace((s) => s.activeFilePath);
  const updateTabContent = useWorkspace((s) => s.updateTabContent);
  const [expanded, setExpanded] = useState(true);
  const lines = content.split("\n");
  const isLong = lines.length > 30;

  // Synchronous highlighting via useMemo — no flash, no 200ms delay
  const highlighted = React.useMemo(() => {
    const lang = language && hljs.getLanguage(language) ? language : "plaintext";
    try {
      return hljs.highlight(content, { language: lang }).value;
    } catch {
      return escapeHtml(content);
    }
  }, [content, language]);

  const handleApply = useCallback(() => {
    if (!activeFilePath) {
      toast.info("No active file open in the editor");
      return;
    }
    const { openTabs } = useWorkspace.getState();
    const currentTab = openTabs.find((t) => t.path === activeFilePath);
    const hasExistingContent = currentTab && currentTab.content.trim().length > 0;
    if (hasExistingContent) {
      if (!window.confirm(`Overwrite entire content of ${basename(activeFilePath)}? This cannot be undone.`)) return;
    }
    updateTabContent(activeFilePath, content);
    toast.success("Applied to editor");
  }, [activeFilePath, content, updateTabContent, toast]);

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted"><FileCode className="w-3 h-3" />{language || "code"}<span className="text-dalam-text-muted/50">· {lines.length} lines</span></div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >{expanded ? "Collapse" : "Expand"}</button>
          )}
          <button className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors" onClick={handleApply}>Apply</button>
        </div>
      </div>
      <pre
        className="p-3 text-[12px] text-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      ><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {isLong && !expanded && (
        <button
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >Show all {lines.length} lines</button>
      )}
    </div>
  );
});

// Streaming code block — shows highlighted code immediately during stream
// For very large blocks (>10000 chars), falls back to plaintext to avoid frame drops.
export const StreamingCodeBlock = React.memo(function StreamingCodeBlock({ language, content }: { language: string; content: string }) {
  const lines = content.split("\n");
  const isLong = lines.length > 30;
  const [expanded, setExpanded] = useState(true);

  // Synchronous highlighting via useMemo — no flash, no 100ms delay
  // Length guard: skip highlight.js for very large blocks during streaming
  // to prevent frame drops from synchronous parsing of huge content.
  const highlighted = React.useMemo(() => {
    if (content.length > 10000) return escapeHtml(content);
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(content, { language }).value; } catch { /* fall through */ }
    }
    try { return hljs.highlightAuto(content).value; } catch { /* fall through */ }
    return escapeHtml(content);
  }, [content, language]);

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted">
          <FileCode className="w-3 h-3" />
          {language || "code"}
          <span className="text-dalam-text-muted/50">· {lines.length} lines</span>
        </div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >{expanded ? "Collapse" : "Expand"}</button>
          )}
        </div>
      </div>
      <pre
        className="p-3 text-[12px] font-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      ><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {isLong && !expanded && (
        <button
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >Show all {lines.length} lines</button>
      )}
    </div>
  );
});
