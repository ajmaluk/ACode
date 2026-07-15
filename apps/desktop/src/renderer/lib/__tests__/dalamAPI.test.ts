/**
 * Tests for dalamAPI.ts — core API bridge layer.
 *
 * Tests the exported pure functions and factory.
 * Tauri-dependent functions (createDalamAPI()) are tested with structural
 * shape checks rather than full integration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProviderError,
  getRecentFiles,
  getActiveProvider,
  corsFetch,
  createDalamAPI,
} from "../dalamAPI";

// ============================================================================
// ProviderError
// ============================================================================

describe("ProviderError", () => {
  it("creates an error with message and code", () => {
    const err = new ProviderError("API key invalid", "auth");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("API key invalid");
    expect(err.code).toBe("auth");
    expect(err.name).toBe("ProviderError");
  });

  it("supports all error codes", () => {
    const codes = [
      "auth",
      "credit",
      "network",
      "provider",
      "timeout",
      "validation",
    ] as const;
    for (const code of codes) {
      const err = new ProviderError(`Test ${code}`, code);
      expect(err.code).toBe(code);
    }
  });

  it("preserves stack trace", () => {
    const err = new ProviderError("test", "network");
    expect(err.stack).toBeDefined();
  });
});

// ============================================================================
// getRecentFiles
// ============================================================================

describe("getRecentFiles", () => {
  beforeEach(() => {
    localStorage.removeItem("dalam.recentFiles.v1");
  });

  it("returns empty array when no recent files stored", () => {
    expect(getRecentFiles()).toEqual([]);
  });

  it("returns parsed array from localStorage", () => {
    localStorage.setItem(
      "dalam.recentFiles.v1",
      JSON.stringify(["/a.ts", "/b.ts"]),
    );
    expect(getRecentFiles()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("returns empty array on invalid JSON", () => {
    localStorage.setItem("dalam.recentFiles.v1", "not-json");
    expect(getRecentFiles()).toEqual([]);
  });

  it("returns empty array on corrupt data", () => {
    localStorage.setItem("dalam.recentFiles.v1", "{broken");
    expect(getRecentFiles()).toEqual([]);
  });
});

// ============================================================================
// getActiveProvider
// ============================================================================

describe("getActiveProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    // Set up default provider config
    const defaultSettings = {
      selectedProvider: "test-provider",
      selectedModel: "gpt-4o",
    };
    localStorage.setItem("dalam.settings.v1", JSON.stringify(defaultSettings));
    localStorage.setItem(
      "dalam.provider.test-provider",
      JSON.stringify({
        baseUrl: "https://api.test.com",
        apiKey: "sk-test-key",
        apiFormat: "openai",
      }),
    );
  });

  it("throws ProviderError when no provider selected", () => {
    localStorage.setItem("dalam.settings.v1", JSON.stringify({}));
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });

  it("throws ProviderError with 'provider' code when no provider config", () => {
    localStorage.setItem(
      "dalam.settings.v1",
      JSON.stringify({ selectedProvider: "nonexistent" }),
    );
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });

  it("throws ProviderError when requireModel is true and no model", () => {
    localStorage.setItem(
      "dalam.settings.v1",
      JSON.stringify({ selectedProvider: "test-provider" }),
    );
    expect(() => getActiveProvider(true)).toThrow(ProviderError);
  });

  it("does not throw when requireModel is false and no model", () => {
    localStorage.setItem(
      "dalam.settings.v1",
      JSON.stringify({ selectedProvider: "test-provider" }),
    );
    expect(() => getActiveProvider(false)).not.toThrow();
  });

  it("returns settings, providerId, modelId, and config", () => {
    const result = getActiveProvider();
    expect(result.settings).toBeDefined();
    expect(result.providerId).toBe("test-provider");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.config.baseUrl).toBe("https://api.test.com");
    expect(result.config.apiKey).toBe("sk-test-key");
    expect(result.config.apiFormat).toBe("openai");
  });

  it("falls back to providers array when individual provider not found", () => {
    localStorage.removeItem("dalam.provider.test-provider");
    localStorage.setItem(
      "dalam.providers.v1",
      JSON.stringify([
        {
          id: "test-provider",
          baseUrl: "https://fallback.com",
          apiKey: "sk-fallback",
          apiFormat: "openai",
        },
      ]),
    );
    const result = getActiveProvider();
    expect(result.config.baseUrl).toBe("https://fallback.com");
    expect(result.config.apiKey).toBe("sk-fallback");
  });

  it("throws when no provider config found anywhere", () => {
    localStorage.removeItem("dalam.provider.test-provider");
    localStorage.setItem("dalam.providers.v1", JSON.stringify([]));
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });
});

// ============================================================================
// corsFetch
// ============================================================================

// Mock the Tauri HTTP plugin so corsFetch's import succeeds but calling the
// plugin fetch throws ReferenceError (matching the runtime fallback condition:
// corsFetch catches ReferenceError and falls back to browser fetch).
// vi.hoisted() is required because vitest hoists vi.mock() to the file top.
const mockTauriFetch = vi.hoisted(() =>
  vi.fn().mockRejectedValue(
    new ReferenceError("window.__TAURI__ not available — falling back to browser fetch")
  )
);

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockTauriFetch,
}));

describe("corsFetch", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("falls back to browser fetch when Tauri plugin unavailable", async () => {
    const mockResponse = new Response('{"ok": true}', { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await corsFetch("https://example.com", { method: "GET" });
    expect(result.ok).toBe(true);
    const text = await result.text();
    expect(text).toBe('{"ok": true}');

    vi.unstubAllGlobals();
  });

  it("passes through network error from browser fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure")),
    );
    await expect(
      corsFetch("https://example.com", { method: "GET" }),
    ).rejects.toThrow("Network failure");
    vi.unstubAllGlobals();
  });

  it("forwards headers to underlying fetch", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return Promise.resolve(new Response("ok", { status: 200 }));
      }),
    );

    await corsFetch("https://example.com", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "value" }),
    });
    expect(capturedHeaders["Authorization"]).toBe("Bearer test");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    vi.unstubAllGlobals();
  });

  it("handles non-ok status codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })),
    );
    const result = await corsFetch("https://example.com", { method: "GET" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    vi.unstubAllGlobals();
  });
});

// ============================================================================
// createDalamAPI (structural shape check)
// ============================================================================

describe("createDalamAPI", () => {
  it("returns a DalamAPI instance with expected shape", () => {
    const api = createDalamAPI();
    expect(api).toBeDefined();
    expect(api).toBeTypeOf("object");

    // Core API sections
    expect(api).toHaveProperty("fs");
    expect(api).toHaveProperty("terminal");
    expect(api).toHaveProperty("agent");
    expect(api).toHaveProperty("git");
    expect(api).toHaveProperty("system");
    expect(api).toHaveProperty("settings");

    // fs methods
    expect(api.fs).toHaveProperty("readFile");
    expect(api.fs).toHaveProperty("writeFile");
    expect(api.fs).toHaveProperty("listDir");
    expect(api.fs).toHaveProperty("createFile");
    expect(api.fs).toHaveProperty("createDirectory");
    expect(api.fs).toHaveProperty("deletePath");
    expect(api.fs).toHaveProperty("renamePath");

    // agent methods
    expect(api.agent).toHaveProperty("startSession");
    expect(api.agent).toHaveProperty("sendPrompt");
    expect(api.agent).toHaveProperty("abort");
    expect(api.agent).toHaveProperty("onStreamEvent");
    expect(api.agent).toHaveProperty("cleanupStream");

    // git methods
    expect(api.git).toHaveProperty("status");

    // system methods
    expect(api.system).toHaveProperty("openDirectoryPicker");

    // settings methods
    expect(api.settings).toHaveProperty("getAll");
    expect(api.settings).toHaveProperty("set");
  });

  it("returns singleton (same reference)", () => {
    const api1 = createDalamAPI();
    const api2 = createDalamAPI();
    expect(api1).toBe(api2);
  });

  it("agent.startSession returns session with id", async () => {
    const api = createDalamAPI();
    const result = await api.agent.startSession({
      workspacePath: "/test",
      model: "gpt-4o",
      mode: "build",
    });
    expect(result).toHaveProperty("sessionId");
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).toMatch(/^ses-/);
  });

  it("agent.onStreamEvent registers and calls back", async () => {
    const api = createDalamAPI();
    const callback = vi.fn();
    api.agent.onStreamEvent("test-session", callback);
    // Should not throw
    api.agent.cleanupStream("test-session");
  });
});
