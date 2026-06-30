import { useUI, useTerminal } from "@/store/useAppStore";
import type { useToast } from "@/components/ui/toastStore";
import { createDalamAPI } from "@/lib/dalamAPI";

/**
 * Copy text to clipboard (tries Tauri native plugin first, falls back to browser API).
 * Shows a toast notification on success.
 */
export async function copyToClipboard(
  text: string,
  toast: ReturnType<typeof useToast>,
  truncatedMsg?: string,
): Promise<void> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
  const display = truncatedMsg ?? (text.length > 60 ? text.slice(0, 57) + "…" : text);
  toast.success("Copied to clipboard", display);
}

/** Open the OS file manager and reveal the given path. */
export function revealInFinder(path: string): void {
  void createDalamAPI().system.revealInFinder(path).catch(() => {});
}

/** Open a terminal tab scoped to the given directory. */
export function openInTerminal(path: string): void {
  useTerminal.getState().ensureTabForCwd(path);
  const ui = useUI.getState();
  ui.setBottomPanelTab("terminal");
  ui.setBottomPanelOpen(true);
}
