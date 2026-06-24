import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Mock pathUtils
vi.mock("@/lib/pathUtils", () => ({
  joinPath: (...parts: string[]) => parts.join("/"),
  basename: (p: string) => p.split("/").pop() || "",
  toPosix: (p: string) => p,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn().mockResolvedValue(true),
  readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("{}")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(""),
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../database", () => ({
  getDb: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
    select: vi.fn().mockResolvedValue([]),
  })),
}));

// Import store hooks and components after mocks
import { useSettings, useChat, useModelProviders } from "../../store/useAppStore";
import { runDreamCycle } from "../dreamAgent";
import { ensureAcodeAPI } from "../acodeAPI";

describe("ACode End-to-End Integration Flow", () => {
  beforeEach(() => {
    localStorageMock.clear();
    useSettings.setState({ loaded: false, settings: { selectedModel: "", selectedProvider: "" } as any });
    useChat.setState({ selectedModelId: "", messages: [] });
  });

  it("handles settings loading, atomic model switching, and memory consolidation", async () => {
    // 1. Load initial settings
    const api = ensureAcodeAPI();
    
    // Set mock settings in localStorage
    localStorageMock.setItem("acode.settings.v1", JSON.stringify({
      selectedModel: "gpt-4o",
      selectedProvider: "openai"
    }));
    
    // Setup model providers
    useModelProviders.setState({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          type: "built-in",
          enabled: true,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-mock-key",
          apiFormat: "openai",
          models: [
            { name: "GPT-4o", modelId: "gpt-4o", contextWindow: "128k" }
          ]
        }
      ]
    });

    await useSettings.getState().load();
    expect(useSettings.getState().settings.selectedModel).toBe("gpt-4o");
    expect(useChat.getState().selectedModelId).toBe("gpt-4o");

    // 2. Select a different model
    // Add new model
    useModelProviders.setState({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          type: "built-in",
          enabled: true,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-mock-key",
          apiFormat: "openai",
          models: [
            { name: "GPT-4o", modelId: "gpt-4o", contextWindow: "128k" },
            { name: "GPT-4o mini", modelId: "gpt-4o-mini", contextWindow: "128k" }
          ]
        }
      ]
    });

    // Switch model
    await useChat.getState().setSelectedModel("gpt-4o-mini");
    expect(useChat.getState().selectedModelId).toBe("gpt-4o-mini");
    expect(useSettings.getState().settings.selectedModel).toBe("gpt-4o-mini");

    // 3. Consolidated memory dream consolidation integration test
    const mockSummarizeMessages = vi.fn().mockResolvedValue(
      JSON.stringify({
        summary: "Consolidated memory",
        content: "Detailed consolidated content about TypeScript",
        tags: ["typescript", "react"],
        tier: "high"
      })
    );
    api.agent.summarizeMessages = mockSummarizeMessages;

    // Simulate database returning two similar memories
    const dbSelectMock = vi.fn().mockResolvedValue([
      {
        id: "mem-1",
        category: "project",
        tier: "medium",
        content: "TypeScript interface implementation",
        summary: "TS interface",
        tags: "[\"typescript\"]",
        created_at: Date.now() - 100000,
        updated_at: Date.now() - 100000,
        access_count: 0,
        last_accessed_at: 0,
        verified: 0,
        stale: 0
      },
      {
        id: "mem-2",
        category: "project",
        tier: "medium",
        content: "TypeScript interface optimization",
        summary: "TS optimization",
        tags: "[\"typescript\"]",
        created_at: Date.now(),
        updated_at: Date.now(),
        access_count: 0,
        last_accessed_at: 0,
        verified: 0,
        stale: 0
      }
    ]);
    const dbExecuteMock = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    
    // We override getDb behavior for the test
    const { getDb } = await import("../database");
    vi.mocked(getDb).mockReturnValue({
      execute: dbExecuteMock,
      select: dbSelectMock,
    } as any);

    // Run runDreamCycle
    await runDreamCycle("/test/workspace");

    // Verify summarizeMessages was called to merge them
    expect(mockSummarizeMessages).toHaveBeenCalled();
  });
});
