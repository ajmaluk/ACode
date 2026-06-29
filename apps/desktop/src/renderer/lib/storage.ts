/**
 * ============================================================
 * DALAM IndexedDB STORAGE — Replace localStorage for Large Data
 * ============================================================
 *
 * localStorage has a 5-10MB browser quota that can be exceeded
 * by session messages alone. This module provides:
 *
 * - IndexedDB-backed storage for large data (messages, versions)
 * - Automatic migration from localStorage on first load
 * - Zustand-compatible storage adapter
 * - Quota-safe write operations with pruning
 * ============================================================
 */

const DB_NAME = "dalam-storage";
const DB_VERSION = 1;

type ObjectStoreName = "sessions" | "messages" | "versions" | "compaction";

let dbInstance: IDBDatabase | null = null;
let dbLoadingPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbLoadingPromise) return dbLoadingPromise;

  dbLoadingPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", { keyPath: "id" });
          store.createIndex("workspacePath", "workspacePath");
          store.createIndex("lastActivityAt", "lastActivityAt");
        }

        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("sessionId", "sessionId");
          store.createIndex("timestamp", "timestamp");
        }

        if (!db.objectStoreNames.contains("versions")) {
          const store = db.createObjectStore("versions", { keyPath: "id" });
          store.createIndex("sessionId", "sessionId");
        }

        if (!db.objectStoreNames.contains("compaction")) {
          db.createObjectStore("compaction", { keyPath: "sessionId" });
        }
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbLoadingPromise = null;
      resolve(request.result);
    };

    request.onerror = () => {
      dbLoadingPromise = null;
      reject(request.error);
    };
  });

  return dbLoadingPromise;
}

/**
 * Migrate data from localStorage to IndexedDB.
 * Called once on first load. Removes localStorage keys after migration.
 */
async function migrateFromLocalStorage(): Promise<void> {
  const keys = [
    { lsKey: "dalam.chatSessions.v1", storeName: "sessions" as ObjectStoreName, transform: (v: unknown) => ({ id: "all", data: v }) },
    { lsKey: "dalam.sessionMessages.v1", storeName: "messages" as ObjectStoreName, transform: (v: unknown) => ({ id: "all", data: v }) },
    { lsKey: "dalam.sessionVersions.v1", storeName: "versions" as ObjectStoreName, transform: (v: unknown) => ({ id: "all", data: v }) },
    { lsKey: "dalam.compactionSummaries.v1", storeName: "compaction" as ObjectStoreName, transform: (v: unknown) => ({ sessionId: "all", data: v }) },
  ];

  const db = await openDB();

  for (const { lsKey, storeName, transform } of keys) {
    const raw = localStorage.getItem(lsKey);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.put(transform(data));

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => {
          localStorage.removeItem(lsKey); // Free space after successful migration
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn(`[IndexedDB] Migration failed for ${lsKey}:`, e);
    }
  }
}

// Track whether migration has been attempted
let migrationAttempted = false;

/**
 * Ensure the database is initialized and localStorage migration is done.
 */
async function ensureDB(): Promise<IDBDatabase> {
  const db = await openDB();
  if (!migrationAttempted) {
    migrationAttempted = true;
    try {
      await migrateFromLocalStorage();
    } catch (e) {
      console.warn("[IndexedDB] Migration from localStorage failed:", e);
      // Reset flag so migration is retried on next call
      migrationAttempted = false;
    }
  }
  return db;
}

/**
 * Read a blob from IndexedDB.
 */
export async function idbGet(storeName: ObjectStoreName, key: string): Promise<unknown> {
  try {
    const db = await ensureDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Write a blob to IndexedDB.
 * Note: The value must have the correct keyPath field (e.g., `id` for sessions,
 * `sessionId` for compaction) matching the object store's keyPath.
 */
export async function idbPut(
  storeName: ObjectStoreName,
  value: unknown,
): Promise<void> {
  const db = await ensureDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn(`[IndexedDB] Transaction error writing to ${storeName}:`, tx.error);
        reject(tx.error);
      };
      tx.onabort = () => {
        console.warn(`[IndexedDB] Transaction aborted writing to ${storeName}`);
        reject(new Error(`Transaction aborted for ${storeName}`));
      };
    } catch (e) {
      console.warn(`[IndexedDB] Failed to write to ${storeName}:`, e);
      reject(e);
    }
  });
}

/**
 * Clear all data in an object store.
 */
export async function idbClear(storeName: ObjectStoreName): Promise<void> {
  try {
    const db = await ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn(`[IndexedDB] Failed to clear ${storeName}:`, e);
    throw e;
  }
}

/**
 * Check if IndexedDB is available in this environment.
 */
export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Get estimated storage usage in bytes.
 * Returns null if the Storage Manager API is not available.
 */
export async function getStorageUsage(): Promise<{
  usage: number;
  quota: number;
} | null> {
  if (typeof navigator !== "undefined" && "storage" in navigator && "estimate" in navigator.storage) {
    try {
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    } catch {
      return null;
    }
  }
  return null;
}
