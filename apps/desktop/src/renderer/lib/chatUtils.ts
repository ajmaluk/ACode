/**
 * ChatView utility functions.
 * Extracted from ChatView.tsx to fix React Fast Refresh warnings — pure
 * functions that don't depend on component state or hooks.
 */

/** Format a Unix timestamp to a short HH:MM string. */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Split markdown text into alternating text and code-fence segments.
 * Handles both complete fences (```lang ... ```) and incomplete trailing
 * fences (no closing ```).
 */
export function splitCodeFences(text: string): { type: "text" | "code"; content: string; language?: string }[] {
  const out: { type: "text" | "code"; content: string; language?: string }[] = [];
  // Match complete code fences: ```lang\n...```
  // Use [\w-]+ for language to handle hyphens (e.g. "typescript", "csharp", "dockerfile")
  const re = /```([\w-]*)(?:\n([\s\S]*?))?\n?```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ type: "text", content: text.slice(last, match.index) });
    out.push({ type: "code", content: match[2] ?? "", language: match[1] || undefined });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    const fenceIdx = rest.indexOf("```");
    if (fenceIdx !== -1) {
      if (fenceIdx > 0) {
        out.push({ type: "text", content: rest.slice(0, fenceIdx) });
      }
      const codePart = rest.slice(fenceIdx + 3);
      const newlineIdx = codePart.indexOf("\n");
      if (newlineIdx !== -1) {
        const language = codePart.slice(0, newlineIdx).trim();
        const content = codePart.slice(newlineIdx + 1);
        // Incomplete code fence (no closing ```) — show as code block
        out.push({ type: "code", content, language: language || undefined });
      } else {
        out.push({ type: "code", content: "", language: codePart.trim() || undefined });
      }
    } else {
      out.push({ type: "text", content: rest });
    }
  }
  return out;
}
