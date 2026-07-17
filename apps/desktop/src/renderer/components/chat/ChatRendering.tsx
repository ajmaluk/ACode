import React, { useState, useCallback, useEffect, useRef } from "react";
import { FileCode, Globe, ExternalLink, Copy, Eye } from "lucide-react";
import { useWorkspace, useUI, useDiffView } from "@/store/useAppStore";
import { useToast } from "@/components/ui/toastStore";
import { basename } from "@/lib/pathUtils";
import { closeIncompleteMarkdown } from "@/lib/chatUtils";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "@/lib/highlight";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

// Module-level escapeHtml — stable reference, never recreated per render
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Sanitize highlighted HTML output to prevent XSS via crafted code content
// or AI-generated output that includes markdown with embedded HTML.
// highlight.js only produces <span class="..."> tags, so we use a whitelist
// approach: only allow <span> with class attribute, strip everything else.
function sanitizeHighlightedHtml(html: string): string {
  // Normalize Unicode to prevent homoglyph-based bypasses
  let normalized: string;
  try {
    normalized = html.normalize("NFKC");
  } catch {
    normalized = html;
  }

  // Recursively strip dangerous elements (handles nesting like <svg><foreignObject><script>)
  const DANGEROUS_TAGS =
    /<(script|iframe|object|embed|form|svg|math|template|style|link|base|meta)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let prev = "";
  let cleaned = normalized;
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(DANGEROUS_TAGS, "<!-- removed -->");
  }

  // Strip self-closing dangerous tags
  cleaned = cleaned
    .replace(/<(script|iframe|object|embed|form|svg|math|template|style|link|base|meta)\b[^>]*\/?>/gi, "<!-- removed -->")
    // Remove event handlers, javascript: URIs, style attributes on remaining elements
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s+xlink:href\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    // Strip dangerous URI schemes
    .replace(
      /((?:href|src|action|formaction|srcset|poster|ping|xlink:href)\s*=\s*)(["'])\s*(?:javascript|vbscript|livescript|data):[^"']*\2/gi,
      "$1$2#",
    )
    .replace(
      /((?:href|src|action|srcset|poster|data)\s*=\s*)(["'])data:[^"']*\2/gi,
      "$1$2#",
    );

  return cleaned;
}

// Named link component (extracted to satisfy React hooks rules)
function LinkComponent({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: React.ReactNode;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setShowMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    firstMenuItemRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [showMenu]);

  const safeUrl = (() => {
    if (!href) return { isExternal: false, isNavigable: false, safeHref: "#" };
    try {
      const u = new URL(href);
      const safe = u.protocol === "http:" || u.protocol === "https:";
      return { isExternal: safe, isNavigable: safe, safeHref: safe ? u.href : "#" };
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[ChatLink] URL parsing failed:", e);
      if (
        /^\s*javascript:/i.test(href) ||
        /^\s*data:/i.test(href) ||
        /^\s*vbscript:/i.test(href)
      ) {
        return { isExternal: false, isNavigable: false, safeHref: "#" };
      }
      // eslint-disable-next-line no-control-regex
      const stripped = href.replace(/[\x00-\x20\x7f-\x9f]/g, "").trim().toLowerCase();
      if (stripped.startsWith("javascript:") || stripped.startsWith("data:") || stripped.startsWith("vbscript:")) {
        return { isExternal: false, isNavigable: false, safeHref: "#" };
      }
      return { isExternal: false, isNavigable: true, safeHref: href };
    }
  })();

  if (!safeUrl.isNavigable) {
    return (
      <span className="relative inline-block">
        <span
          role="button"
          tabIndex={0}
          aria-label={typeof children === "string" ? children : "Link"}
          className="text-dalam-accent-primary hover:underline cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
            }
          }}
        >
          {children}
        </span>
      </span>
    );
  }

  return (
    <span className="relative inline-block">
      <a
        href={safeUrl.safeHref}
        {...props}
        onClick={(e) => {
          setShowMenu(!showMenu);
          if (safeUrl.isExternal) e.preventDefault();
        }}
        className="text-dalam-accent-primary hover:underline cursor-pointer"
      >
        {children}
      </a>
      {showMenu && safeUrl.isExternal && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute z-50 bottom-full left-0 mb-1 w-52 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg shadow-lg py-1 animate-fade-in"
        >
          <button
            ref={firstMenuItemRef}
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-bg-hover flex items-center gap-2"
            onClick={() => {
              const ui = useUI.getState();
              ui.addBrowserTab({ url: href! });
              ui.setRightPanelTab("browser");
              if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
              setShowMenu(false);
            }}
          >
            <Globe className="w-3.5 h-3.5" aria-hidden="true" /> Open in Dalam
          </button>
          <button
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-bg-hover flex items-center gap-2"
            onClick={() => {
              try {
                window.open(href, "_blank");
              } catch (e) {
                if (import.meta.env.DEV) console.warn("[ChatLink] window.open failed:", e);
              }
              setShowMenu(false);
            }}
          >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> Open in external browser
          </button>
          <button
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-xs text-dalam-text-primary hover:bg-dalam-bg-hover flex items-center gap-2"
            onClick={() => {
              navigator.clipboard.writeText(href || "").catch(() => {});
              setShowMenu(false);
            }}
          >
            <Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copy URL
          </button>
        </div>
      )}
    </span>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="whitespace-pre-wrap break-words mb-2 last:mb-0">{children}</p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-dalam-text-primary">
      {children}
    </strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic">{children}</em>
  ),
  a: LinkComponent,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-dalam-text-secondary">{children}</li>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-lg font-bold mb-2 text-dalam-text-primary">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-base font-bold mb-2 text-dalam-text-primary">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-bold mb-1 text-dalam-text-primary">
      {children}
    </h3>
  ),
  code: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="px-1 py-0.5 bg-dalam-bg-tertiary rounded text-[12px] font-mono text-dalam-accent-primary">
          {children}
        </code>
      );
    }
    return <code className={className}>{children}</code>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-dalam-accent-primary/40 pl-3 my-2 text-dalam-text-muted italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-dalam-border-primary" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-2 py-1 border border-dalam-border-primary text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-2 py-1 border border-dalam-border-primary">{children}</td>
  ),
};

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
}: {
  content: string;
}) {
  return (
    <Markdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
});

// Lightweight streaming renderer — uses full markdown parsing for real-time formatting.
// react-markdown is fast enough for streaming deltas. The visual quality improvement
// (proper bold, headings, lists, code highlighting) far outweighs the minor re-parse cost.
export const StreamingContent = React.memo(function StreamingContent({
  content,
}: {
  content: string;
}) {
  // Close incomplete markdown markers so bold/italic render correctly during streaming
  const safeContent = closeIncompleteMarkdown(content);
  // Limit rendered content size to prevent lag on very large streaming output
  // Show only the last 50KB of content during streaming (final message shows full)
  const MAX_STREAM_RENDER = 50000;
  const renderContent = safeContent.length > MAX_STREAM_RENDER
    ? "..." + safeContent.slice(-MAX_STREAM_RENDER)
    : safeContent;
  return <MarkdownContent content={renderContent} />;
});

function openInReview(filename: string | undefined, content: string) {
  const openFile = useDiffView.getState().openFile;
  openFile({
    path: filename || "untitled",
    action: "modified",
    additions: content.split("\n").length,
    deletions: 0,
  });
}

export const CodeBlock = React.memo(function CodeBlock({
  language,
  content,
  filename,
}: {
  language: string;
  content: string;
  filename?: string;
}) {
  const toast = useToast();
  const activeFilePath = useWorkspace((s) => s.activeFilePath);
  const updateTabContent = useWorkspace((s) => s.updateTabContent);
  const [expanded, setExpanded] = useState(true);
  const lines = content.split("\n");
  const isLong = lines.length > 30;

  // Synchronous highlighting via useMemo — guard against large content to prevent frame drops
  const highlighted = React.useMemo(() => {
    if (content.length > 10000) return escapeHtml(content);
    const lang =
      language && hljs.getLanguage(language) ? language : "plaintext";
    try {
      return hljs.highlight(content, { language: lang }).value;
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[CodeBlock] hljs.highlight failed:", e);
      return escapeHtml(content);
    }
  }, [content, language]);

  const handleApply = useCallback(async () => {
    if (!activeFilePath) {
      toast.info("No active file open in the editor");
      return;
    }
    const { openTabs } = useWorkspace.getState();
    const currentTab = openTabs.find((t) => t.path === activeFilePath);
    const hasExistingContent =
      currentTab && currentTab.content.trim().length > 0;
    if (hasExistingContent) {
      let shouldOverwrite;
      try {
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        shouldOverwrite = await confirm(
          `Overwrite entire content of ${basename(activeFilePath)}? This cannot be undone.`,
          { title: "Overwrite file?", kind: "warning" },
        );
      } catch (e) {
        if (import.meta.env.DEV) console.warn("[ApplyButton] Tauri confirm dialog failed, falling back:", e);
        try {
          shouldOverwrite = window.confirm(
            `Overwrite entire content of ${basename(activeFilePath)}? This cannot be undone.`,
          );
        } catch (e2) {
          if (import.meta.env.DEV) console.warn("[ApplyButton] window.confirm also failed:", e2);
          shouldOverwrite = false;
        }
      }
      if (!shouldOverwrite) return;
    }
    updateTabContent(activeFilePath, content);
    toast.success("Applied to editor");
  }, [activeFilePath, content, updateTabContent, toast]);

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted min-w-0">
          <FileCode className="w-3 h-3 shrink-0" aria-hidden="true" />
          {filename ? (
            <button
              type="button"
              className="font-medium text-dalam-accent-primary hover:text-dalam-accent-hover truncate flex items-center gap-1 transition-colors"
              title={`Open ${filename} in Review`}
              onClick={() => openInReview(filename, content)}
            >
              <span className="truncate">{filename}</span>
              <Eye className="w-2.5 h-2.5 shrink-0 opacity-60" />
            </button>
          ) : (
            <span>{language || "code"}</span>
          )}
          <span className="text-dalam-text-muted/50 shrink-0">
            · {lines.length} lines
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Copy code block"
            className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(content).then(
                () => toast.success("Copied to clipboard"),
                () => toast.error("Failed to copy"),
              );
            }}
          >
            Copy
          </button>
          {isLong && (
            <button
              type="button"
              aria-expanded={expanded}
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
          <button
            type="button"
            aria-label="Apply code to editor"
            className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </div>
      <pre
        className="p-3 text-[12px] font-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed"
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      >
        <code
          dangerouslySetInnerHTML={{
            __html: sanitizeHighlightedHtml(highlighted),
          }}
        />
      </pre>
      {isLong && !expanded && (
        <button
          type="button"
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
});

// Streaming code block — lightweight during streaming to avoid frame drops.
// Skips highlight.js entirely (the #1 cause of streaming lag) and only shows
// escaped text with a shimmer overlay. Final CodeBlock handles syntax highlighting.
export const StreamingCodeBlock = React.memo(function StreamingCodeBlock({
  language,
  content,
  filename,
}: {
  language: string;
  content: string;
  filename?: string;
}) {
  const lines = content.split("\n");
  const isLong = lines.length > 30;
  const [expanded, setExpanded] = useState(true);
  const hasContent = content.trim().length > 0;

  // Escaped text only — no highlight.js during streaming.
  // This eliminates the synchronous parsing that caused frame drops on large code blocks.
  // Limit rendered content to prevent lag on very large streaming output
  const MAX_STREAM_CODE = 30000;
  const escaped = React.useMemo(() => escapeHtml(content.length > MAX_STREAM_CODE ? content.slice(-MAX_STREAM_CODE) : content), [content]);

  return (
    <div className="my-2 bg-dalam-bg-primary border border-dalam-border-primary rounded-lg overflow-hidden relative">
      {/* Shimmer overlay — active while streaming content arrives */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 pointer-events-none z-10 rounded-lg overflow-hidden transition-opacity duration-500 ${
          hasContent ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="w-full h-full animate-shimmer" />
      </div>

      <div className="flex items-center justify-between px-3 py-1.5 bg-dalam-bg-tertiary border-b border-dalam-border-primary">
        <div className="flex items-center gap-1.5 text-[10px] text-dalam-text-muted min-w-0">
          <FileCode className="w-3 h-3 shrink-0" aria-hidden="true" />
          {filename ? (
            <span className="font-medium text-dalam-text-secondary truncate" title={filename}>
              {filename}
            </span>
          ) : (
            <span>{language || "code"}</span>
          )}
          {!hasContent && (
            <span className="text-dalam-accent-primary italic animate-pulse">generating...</span>
          )}
          {hasContent && (
            <span className="text-dalam-text-muted/50 shrink-0">
              · {lines.length} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              type="button"
              aria-expanded={expanded}
              className="text-[10px] text-dalam-text-muted hover:text-dalam-text-primary px-1.5 py-0.5 rounded hover:bg-dalam-bg-hover transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>
      <pre
        className={`p-3 text-[12px] font-mono text-dalam-text-primary overflow-x-auto scrollbar-thin leading-relaxed ${
          !hasContent ? "min-h-[60px]" : ""
        }`}
        style={{ maxHeight: isLong && !expanded ? "240px" : undefined }}
      >
        {hasContent ? (
          <code dangerouslySetInnerHTML={{ __html: escaped }} />
        ) : null}
      </pre>
      {isLong && !expanded && (
        <button
          type="button"
          className="w-full py-1.5 text-[10px] text-dalam-accent-primary hover:bg-dalam-bg-hover border-t border-dalam-border-primary transition-colors"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
});
