/**
 * Auto-Update Module — checks for and installs updates via tauri-plugin-updater.
 *
 * Usage:
 *   import { checkForUpdates, installUpdate } from "@/lib/updater";
 *   const info = await checkForUpdates();
 *   if (info.available) await installUpdate();
 */

export interface UpdateInfo {
  available: boolean;
  version?: string;
  notes?: string;
}

/**
 * Check if an update is available.
 * Returns update metadata or { available: false }.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    // Dynamic import — module may not be available in all environments
    const updater = await import("@tauri-apps/plugin-updater") as { check: () => Promise<{ version: string; body?: string } | null> };
    const update = await updater.check();

    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
      };
    }

    return { available: false };
  } catch (err) {
    console.warn("[Updater] Failed to check for updates:", err);
    return { available: false };
  }
}

/**
 * Download and install the latest update, then relaunch the app.
 */
export async function installUpdate(
  onProgress?: (percent: number) => void
): Promise<void> {
  try {
    const updater = await import("@tauri-apps/plugin-updater") as {
      check: () => Promise<{ downloadAndInstall: (cb: (event: { data?: { event: string; contentLength?: number; data?: { chunkLength?: number } } }) => void) => Promise<void> } | null>;
    };
    const process = await import("@tauri-apps/plugin-process") as { relaunch: () => Promise<void> };

    const update = await updater.check();
    if (!update) {
      console.warn("[Updater] No update available");
      return;
    }

    await update.downloadAndInstall((event) => {
      if (event.data && event.data.event === "Progress") {
        const chunkLength = event.data.data?.chunkLength ?? 0;
        onProgress?.(chunkLength);
      } else if (event.data && event.data.event === "Finished") {
        onProgress?.(100);
      }
    });

    await process.relaunch();
  } catch (err) {
    console.warn("[Updater] Failed to install update:", err);
  }
}
