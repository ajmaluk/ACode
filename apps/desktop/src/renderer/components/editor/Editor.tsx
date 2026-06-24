import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import { useSettings, useWorkspace } from "@/store/useAppStore";
import { useEffect, useRef, useState } from "react";

loader.config({
  paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs" },
});

const ACODE_LIGHT = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "888888", fontStyle: "italic" },
    { token: "keyword", foreground: "2563eb" },
    { token: "string", foreground: "1a7f37" },
    { token: "number", foreground: "b08800" },
    { token: "type", foreground: "8250df" },
    { token: "identifier", foreground: "1a1a1a" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1a1a1a",
    "editor.lineHighlightBackground": "#f6f6f6",
    "editor.lineHighlightBorder": "#f6f6f6",
    "editorLineNumber.foreground": "#b0b0b0",
    "editorLineNumber.activeForeground": "#555555",
    "editor.selectionBackground": "#2563eb44",
    "editor.inactiveSelectionBackground": "#2563eb22",
    "editorCursor.foreground": "#2563eb",
    "editor.findMatchBackground": "#fde047",
    "editor.findMatchHighlightBackground": "#fde04744",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#d4d4d4",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#d4d4d4",
    "editorSuggestWidget.selectedBackground": "#f6f6f6",
    "editorBracketMatch.background": "#2563eb22",
    "editorBracketMatch.border": "#2563eb",
    "scrollbarSlider.background": "#d4d4d480",
    "scrollbarSlider.hoverBackground": "#b0b0b0",
    "scrollbarSlider.activeBackground": "#2563eb",
  },
};

const ACODE_DARK = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "666666", fontStyle: "italic" },
    { token: "keyword", foreground: "4f8ef7" },
    { token: "string", foreground: "73c991" },
    { token: "number", foreground: "e2c08d" },
    { token: "type", foreground: "c792ea" },
    { token: "identifier", foreground: "e0e0e0" },
  ],
  colors: {
    "editor.background": "#0d0d0d",
    "editor.foreground": "#e0e0e0",
    "editor.lineHighlightBackground": "#1a1a1a",
    "editor.lineHighlightBorder": "#1a1a1a",
    "editorLineNumber.foreground": "#444444",
    "editorLineNumber.activeForeground": "#a0a0a0",
    "editor.selectionBackground": "#4f8ef744",
    "editor.inactiveSelectionBackground": "#4f8ef722",
    "editorCursor.foreground": "#4f8ef7",
    "editor.findMatchBackground": "#4f8ef755",
    "editor.findMatchHighlightBackground": "#4f8ef733",
    "editorWidget.background": "#1a1a1a",
    "editorWidget.border": "#333333",
    "editorSuggestWidget.background": "#1a1a1a",
    "editorSuggestWidget.border": "#333333",
    "editorSuggestWidget.selectedBackground": "#252525",
    "editorBracketMatch.background": "#4f8ef733",
    "editorBracketMatch.border": "#4f8ef7",
    "scrollbarSlider.background": "#2a2a2a80",
    "scrollbarSlider.hoverBackground": "#404040",
    "scrollbarSlider.activeBackground": "#4f8ef7",
  },
};

type Props = {
  path: string | null;
  content: string;
  onChange?: (value: string) => void;
};

export function CodeView({ path, content, onChange }: Props) {
  const { settings, effectiveTheme } = useSettings();
  const { setCursor } = useWorkspace();
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(effectiveTheme());
  const language = path?.split(".").pop()?.toLowerCase() ?? "plaintext";

  const monacoLang = (() => {
    if (["ts", "tsx"].includes(language)) return "typescript";
    if (language === "js") return "javascript";
    if (language === "json") return "json";
    if (language === "md") return "markdown";
    if (language === "py") return "python";
    if (language === "rs") return "rust";
    if (language === "css") return "css";
    if (language === "html") return "html";
    if (language === "yml" || language === "yaml") return "yaml";
    return "plaintext";
  })();

  // Track the resolved theme so Monaco re-themes when the user toggles.
  useEffect(() => {
    setResolvedTheme(effectiveTheme());
  }, [settings.theme, effectiveTheme]);

  const onMount: OnMount = (editor, monaco) => {
    monaco.editor.defineTheme("acode-dark", ACODE_DARK as never);
    monaco.editor.defineTheme("acode-light", ACODE_LIGHT as never);
    monaco.editor.setTheme(resolvedTheme === "light" ? "acode-light" : "acode-dark");
    editor.onDidChangeCursorPosition((e) => {
      if (path) setCursor(path, e.position.lineNumber, e.position.column);
    });
  };

  // Switch theme live (e.g. when user toggles in Settings).
  useEffect(() => {
    // Defer to next tick to ensure Monaco is loaded.
    const t = setTimeout(() => {
      try {
        const monaco = (window as unknown as { monaco?: { editor: { setTheme: (name: string) => void } } }).monaco;
        if (monaco) monaco.editor.setTheme(resolvedTheme === "light" ? "acode-light" : "acode-dark");
      } catch { /* noop */ }
    }, 0);
    return () => clearTimeout(t);
  }, [resolvedTheme]);

  return (
    <MonacoEditor
      path={path ?? undefined}
      value={content}
      language={monacoLang}
      theme={resolvedTheme === "light" ? "acode-light" : "acode-dark"}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={onMount}
      loading={
        <div className="h-full w-full flex items-center justify-center bg-acode-bg-primary">
          <div className="flex items-center gap-2 text-sm text-acode-text-muted">
            <div className="w-2 h-2 rounded-full bg-acode-accent-primary animate-pulse-soft" />
            Loading editor…
          </div>
        </div>
      }
      options={{
        fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
        fontSize: settings.codeFontSize,
        fontLigatures: true,
        lineNumbers: settings.showLineNumbers ? "on" : "off",
        lineNumbersMinChars: 3,
        wordWrap: settings.wordWrap ? "on" : "off",
        minimap: { enabled: true, scale: 1, renderCharacters: false, maxColumn: 120 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "gutter",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        padding: { top: 12, bottom: 12 },
        tabSize: 2,
        automaticLayout: true,
        renderWhitespace: "selection",
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        folding: true,
        links: true,
      }}
    />
  );
}
