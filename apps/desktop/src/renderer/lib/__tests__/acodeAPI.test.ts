import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Mock Tauri dependencies
vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(false),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/home/test"),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: { create: vi.fn() },
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({}));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../hookBus", () => ({
  hookBus: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));
vi.mock("../skills", () => ({
  matchSkillInvocation: vi.fn(),
  renderSkillForPrompt: vi.fn(),
  loadSkillContent: vi.fn(),
}));
vi.mock("../instructions", () => ({
  loadInstructions: vi.fn(),
  formatInstructionsForPrompt: vi.fn(),
}));

const SETTINGS_KEY = "acode.settings.v1";
const validConfig = { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", apiFormat: "openai" };

function setSettings(selectedProvider: string | null, selectedModel: string | null) {
  localStorageMock.setItem(SETTINGS_KEY, JSON.stringify({
    selectedProvider,
    selectedModel,
    maxTokens: 4096,
  }));
}

function setProviderConfig(id: string, config: { baseUrl: string; apiKey: string; apiFormat: string }) {
  localStorageMock.setItem(`acode.provider.${id}`, JSON.stringify(config));
}

// ============================================================
// Module re-import helper (busts SETTINGS_CACHE)
// ============================================================
async function importFresh() {
  const mod = await import("../acodeAPI");
  return { getActiveProvider: mod.getActiveProvider, ProviderError: mod.ProviderError };
}

// ============================================================
// getActiveProvider tests
// ============================================================
describe("getActiveProvider", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.resetModules(); // Bust the SETTINGS_CACHE
  })

  it("returns settings, providerId, modelId, config when valid config exists", async () => {
    setSettings("openai", "gpt-4");
    setProviderConfig("openai", validConfig);
    const { getActiveProvider } = await importFresh();
    const result = getActiveProvider();
    expect(result.providerId).toBe("openai");
    expect(result.modelId).toBe("gpt-4");
    expect(result.config.baseUrl).toBe("https://api.openai.com/v1");
    expect(result.config.apiKey).toBe("sk-test");
    expect(result.config.apiFormat).toBe("openai");
  });

  it("throws ProviderError when no settings exist", async () => {
    const { getActiveProvider, ProviderError } = await importFresh();
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });

  it("throws when providerId is set but provider config is missing", async () => {
    setSettings("openai", "gpt-4");
    // No setProviderConfig — config not found
    const { getActiveProvider, ProviderError } = await importFresh();
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });

  it("throws when requireModel=true and modelId is null", async () => {
    setSettings("openai", null);
    setProviderConfig("openai", validConfig);
    const { getActiveProvider, ProviderError } = await importFresh();
    expect(() => getActiveProvider(true)).toThrow(ProviderError);
  });

  it("succeeds when requireModel=false and modelId is null", async () => {
    setSettings("openai", null);
    setProviderConfig("openai", validConfig);
    const { getActiveProvider } = await importFresh();
    const result = getActiveProvider(false);
    expect(result.providerId).toBe("openai");
    expect(result.modelId).toBe("");
    expect(result.config.apiFormat).toBe("openai");
  });

  it("returns correct config for anthropic format", async () => {
    const anthropicConfig = { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test", apiFormat: "anthropic" };
    setSettings("anthropic", "claude-3-opus");
    setProviderConfig("anthropic", anthropicConfig);
    const { getActiveProvider } = await importFresh();
    const result = getActiveProvider();
    expect(result.config.apiFormat).toBe("anthropic");
    expect(result.modelId).toBe("claude-3-opus");
  });

  it("throws when providerId is empty string", async () => {
    setSettings("", "gpt-4");
    const { getActiveProvider, ProviderError } = await importFresh();
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });

  it("throws when selectedProvider key missing from settings", async () => {
    localStorageMock.setItem(SETTINGS_KEY, JSON.stringify({
      selectedModel: "gpt-4",
      maxTokens: 4096,
    }));
    const { getActiveProvider, ProviderError } = await importFresh();
    expect(() => getActiveProvider()).toThrow(ProviderError);
  });
});

// ============================================================
// ProviderError tests
// ============================================================
describe("ProviderError", () => {
  it("has correct name and code", async () => {
    const { ProviderError } = await importFresh();
    const err = new ProviderError("test error", "auth");
    expect(err.name).toBe("ProviderError");
    expect(err.code).toBe("auth");
    expect(err.message).toBe("test error");
    expect(err instanceof Error).toBe(true);
  });

  it("supports all error codes", async () => {
    const { ProviderError } = await importFresh();
    for (const code of ["auth", "credit", "network", "provider", "timeout"] as const) {
      const err = new ProviderError(`error ${code}`, code);
      expect(err.code).toBe(code);
    }
  });
});


