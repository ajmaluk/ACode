import { loader, type OnMount, type EditorProps } from "@monaco-editor/react";
import { useSettings } from "@/store/useAppStore";
import { detectLanguage } from "@/lib/pathUtils";
import { useMemo, useState, useEffect, Suspense, lazy } from "react";

export type MonacoEditorInstance = Parameters<OnMount>[0];

// Configure Monaco to load from CDN with proper worker setup
loader.config({
  paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs" },
});

const DALAM_LIGHT = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "888888", fontStyle: "italic" },
    { token: "keyword", foreground: "2563eb" },
    { token: "string", foreground: "1a7f37" },
    { token: "number", foreground: "b08800" },
    { token: "type", foreground: "8250df" },
    { token: "identifier", foreground: "1a1a1a" },
    { token: "regexp", foreground: "d14d72" },
    { token: "operator", foreground: "cf222e" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1a1a1a",
    "editor.lineHighlightBackground": "#f6f8fa",
    "editor.lineHighlightBorder": "#f6f8fa",
    "editorLineNumber.foreground": "#b0b0b0",
    "editorLineNumber.activeForeground": "#555555",
    "editor.selectionBackground": "#2563eb22",
    "editor.inactiveSelectionBackground": "#2563eb11",
    "editorCursor.foreground": "#2563eb",
    "editor.findMatchBackground": "#fde047",
    "editor.findMatchHighlightBackground": "#fde04744",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#d4d4d4",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#d4d4d4",
    "editorSuggestWidget.selectedBackground": "#f6f8fa",
    "editorSuggestWidget.highlightForeground": "#2563eb",
    "editorBracketMatch.background": "#2563eb22",
    "editorBracketMatch.border": "#2563eb",
    "editorIndentGuide.background1": "#e8e8e8",
    "editorIndentGuide.activeBackground1": "#d0d0d0",
    "editorBracketHighlight.foreground1": "#2563eb",
    "editorBracketHighlight.foreground2": "#8250df",
    "editorBracketHighlight.foreground3": "#cf222e",
    "scrollbarSlider.background": "#d4d4d480",
    "scrollbarSlider.hoverBackground": "#b0b0b0",
    "scrollbarSlider.activeBackground": "#2563eb",
    "minimap.background": "#fafafa",
    "editorGutter.background": "#ffffff",
    "editorOverviewRuler.border": "#ffffff",
  },
};

const DALAM_DARK = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "555555", fontStyle: "italic" },
    { token: "keyword", foreground: "4f8ef7" },
    { token: "string", foreground: "73c991" },
    { token: "number", foreground: "e2c08d" },
    { token: "type", foreground: "c792ea" },
    { token: "identifier", foreground: "e0e0e0" },
    { token: "regexp", foreground: "f44747" },
    { token: "operator", foreground: "d4d4d4" },
    { token: "tag", foreground: "4f8ef7" },
    { token: "metatag", foreground: "4f8ef7" },
    { token: "attribute.name", foreground: "9cdcfe" },
    { token: "attribute.value", foreground: "ce9178" },
    { token: "delimiter", foreground: "d4d4d4" },
    { token: "delimiter.bracket", foreground: "ffd700" },
    { token: "predefined", foreground: "4fc1ff" },
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
    "editorSuggestWidget.highlightForeground": "#4f8ef7",
    "editorBracketMatch.background": "#4f8ef733",
    "editorBracketMatch.border": "#4f8ef7",
    "editorIndentGuide.background1": "#2a2a2a",
    "editorIndentGuide.activeBackground1": "#404040",
    "editorBracketHighlight.foreground1": "#4f8ef7",
    "editorBracketHighlight.foreground2": "#c792ea",
    "editorBracketHighlight.foreground3": "#f44747",
    "scrollbarSlider.background": "#2a2a2a80",
    "scrollbarSlider.hoverBackground": "#404040",
    "scrollbarSlider.activeBackground": "#4f8ef7",
    "minimap.background": "#111111",
    "editorGutter.background": "#0d0d0d",
    "editorOverviewRuler.border": "#0d0d0d",
  },
};

// Lazy load Monaco editor — defers the ~2MB bundle until the editor tab is first opened
const MonacoEditor = lazy(() => import("@monaco-editor/react"));

type Props = {
  path: string | null;
  content: string;
  onChange?: (value: string) => void;
  onEditorReady?: (editor: MonacoEditorInstance) => void;
};

export function CodeView({ path, content, onChange, onEditorReady }: Props) {
  const { settings } = useSettings();

  // Track system theme changes for "system" theme mode
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  });

  useEffect(() => {
    if (settings.theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [settings.theme]);

  const theme = useMemo(() => {
    if (settings.theme === "dark") return "dark";
    if (settings.theme === "light") return "light";
    return systemDark ? "dark" : "light";
  }, [settings.theme, systemDark]);

  const onMount: OnMount = (editor, monaco) => {
    monaco.editor.defineTheme("dalam-dark", DALAM_DARK);
    monaco.editor.defineTheme("dalam-light", DALAM_LIGHT);
    monaco.editor.setTheme(theme === "light" ? "dalam-light" : "dalam-dark");
    onEditorReady?.(editor);
  };

  // Memoize editor options to prevent unnecessary Monaco reconfiguration on every render
  const editorOptions = useMemo((): EditorProps["options"] => ({
      fontFamily:
        "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
      fontSize: settings.codeFontSize,
      fontLigatures: true,
      fontWeight: "400",
      letterSpacing: settings.letterSpacing ?? 0.3,
      lineNumbers: settings.showLineNumbers ? "on" : "off",
      lineNumbersMinChars: 3,
      wordWrap: settings.wordWrap ? "on" : "off",
      minimap: {
        enabled: settings.showMinimap ?? true,
        scale: 1,
        renderCharacters: false,
        maxColumn: 120,
        showSlider: "mouseover",
      },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      cursorWidth: settings.cursorWidth ?? 2,
      renderLineHighlight: "all",
      renderLineHighlightOnlyWhenFocus: false,
      bracketPairColorization: {
        enabled: settings.bracketPairColorization ?? true,
        independentColorPoolPerBracketType: true,
      },
      guides: {
        bracketPairs: true,
        bracketPairsHorizontal: true,
        indentation: settings.showIndentGuides ?? true,
        highlightActiveIndentation: true,
      },
      padding: { top: 12, bottom: 12 },
      tabSize: settings.tabSize ?? 2,
      automaticLayout: true,
      renderWhitespace: "selection",
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
        verticalSliderSize: 6,
      },
      folding: true,
      foldingHighlight: true,
      showFoldingControls: "mouseover",
      links: true,
      colorDecorators: true,
      contextmenu: true,
      mouseWheelZoom: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      parameterHints: { enabled: true },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: "smart",
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoSurround: "languageDefined",
      formatOnPaste: false,
      formatOnType: false,
      dragAndDrop: true,
      copyWithSyntaxHighlighting: true,
      occurrencesHighlight: "singleFile",
      selectionHighlight: true,
      roundedSelection: true,
      readOnly: !onChange,
      showDeprecated: true,
      inlineSuggest: { enabled: true },
    }),
    [
      settings.codeFontSize,
      settings.letterSpacing,
      settings.showLineNumbers,
      settings.wordWrap,
      settings.showMinimap,
      settings.cursorWidth,
      settings.bracketPairColorization,
      settings.showIndentGuides,
      settings.tabSize,
      onChange,
    ],
  );

  return (
    <Suspense
      fallback={
        <div className="h-full w-full flex items-center justify-center bg-dalam-bg-primary">
          <div className="flex items-center gap-2 text-sm text-dalam-text-muted">
            <div className="w-2 h-2 rounded-full bg-dalam-accent-primary animate-pulse-soft" />
            Loading editor...
          </div>
        </div>
      }
    >
      <MonacoEditor
        key={path ?? "empty"}
        path={path ?? undefined}
        value={content}
        language={detectLanguage(path)}
        theme={theme === "light" ? "dalam-light" : "dalam-dark"}
        onChange={(v) => onChange?.(v ?? "")}
        onMount={onMount}
        loading={
          <div className="h-full w-full flex items-center justify-center bg-dalam-bg-primary">
            <div className="flex items-center gap-2 text-sm text-dalam-text-muted">
              <div className="w-2 h-2 rounded-full bg-dalam-accent-primary animate-pulse-soft" />
              Loading editor...
            </div>
          </div>
        }
        options={editorOptions}
      />
    </Suspense>
  );
}
