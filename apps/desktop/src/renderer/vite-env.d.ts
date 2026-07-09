/// <reference types="vite/client" />

declare module "@tauri-apps/plugin-updater" {
  export function check(): Promise<{
    version: string;
    body?: string;
    downloadAndInstall: (
      cb: (event: {
        data?: {
          event: string;
          contentLength?: number;
          data?: { chunkLength?: number };
        };
      }) => void,
    ) => Promise<void>;
  } | null>;
}

declare module "@tauri-apps/plugin-process" {
  export function relaunch(): Promise<void>;
}
