/**
 * Global test setup — provides common mocks and utilities for all test files.
 */

// ─── window mock for Tauri plugins ──────────────────────────
// Many source files (memoryStore, codeIndex, dalamAPI, etc.) dynamically import
// Tauri plugins like @tauri-apps/plugin-fs which access window.__TAURI_INTERNALS__
// at module evaluation time. In Node.js test environment, window is not defined,
// causing ReferenceError noise in test output. This mock intercepts those imports
// so they resolve cleanly without crashing.
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, ..._args: unknown[]) => {
        throw new Error(
          `Tauri invoke('${cmd}') called in test environment — mock the calling module with vi.mock()`
        );
      },
      transformCallback: (fn: (...args: unknown[]) => void) => {
        // Return a numeric callback ID for Tauri listener registration
        return Math.floor(Math.random() * 2 ** 32);
      },
    },
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  };
}

// ─── localStorage mock ──────────────────────────────────────
const localStorageStore = new Map<string, string>();

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => localStorageStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageStore.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageStore.delete(key);
      },
      clear: () => {
        localStorageStore.clear();
      },
      get length() {
        return localStorageStore.size;
      },
      key: (index: number) => [...localStorageStore.keys()][index] ?? null,
    },
    writable: true,
  });
}

// ─── crypto.randomUUID mock ─────────────────────────────────
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      },
    },
    writable: true,
  });
} else if (typeof globalThis.crypto.randomUUID === "undefined") {
  globalThis.crypto.randomUUID = () => {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };
}

// ─── Clean up between tests ─────────────────────────────────
afterEach(() => {
  localStorageStore.clear();
});
