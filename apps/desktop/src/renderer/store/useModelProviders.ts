import { create } from "zustand";
import { saveWorkspaceData } from "./useWorkspace";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

export type SettingsTab =
  | "general"
  | "code-preview"
  | "models"
  | "instructions"
  | "skills"
  | "mcp"
  | "memory-graph"
  | "commands"
  | "indexing"
  | "onboard"
  | "connectors";

export type ModelProvider = {
  id: string;
  name: string;
  type: "built-in" | "custom";
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiFormat: "openai" | "anthropic";
  models: { name: string; modelId: string; contextWindow: string; connected?: boolean; enabled?: boolean }[];
};

const PROVIDERS_STORAGE_KEY = "dalam.providers.v1";

function loadProviders(): ModelProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    if (import.meta.env.DEV) devWarn("[Store] const raw = localStorage.getItem(PROVIDERS_STORAGE:", e);
  }
  return DEFAULT_PROVIDERS;
}

function saveProviders(providers: ModelProvider[]) {
  try {
    localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      devWarn("[Storage] Quota exceeded saving providers:", e);
    } else {
      devWarn("[Storage] Failed to save providers:", e);
    }
  }
  void saveWorkspaceData();
}

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "GPT-4o", modelId: "gpt-4o", contextWindow: "128k" },
      { name: "GPT-4o mini", modelId: "gpt-4o-mini", contextWindow: "128k" },
      { name: "GPT-4.1", modelId: "gpt-4.1", contextWindow: "1m" },
      { name: "GPT-4.1 mini", modelId: "gpt-4.1-mini", contextWindow: "1m" },
      { name: "o3", modelId: "o3", contextWindow: "200k" },
      { name: "o4-mini", modelId: "o4-mini", contextWindow: "200k" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    apiFormat: "anthropic",
    models: [
      { name: "Claude Sonnet 4", modelId: "claude-sonnet-4-20250514", contextWindow: "200k" },
      { name: "Claude Opus 4", modelId: "claude-opus-4-20250514", contextWindow: "200k" },
      { name: "Claude 3.5 Haiku", modelId: "claude-3-5-haiku-20241022", contextWindow: "200k" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "Llama 3.3 70B", modelId: "llama-3.3-70b-versatile", contextWindow: "128k" },
      { name: "Llama 3.1 8B", modelId: "llama-3.1-8b-instant", contextWindow: "128k" },
      { name: "Mixtral 8x7B", modelId: "mixtral-8x7b-32768", contextWindow: "32k" },
      { name: "Gemma 2 9B", modelId: "gemma2-9b-it", contextWindow: "8k" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "built-in",
    enabled: false,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "DeepSeek V3", modelId: "deepseek-chat", contextWindow: "64k" },
      { name: "DeepSeek R1", modelId: "deepseek-reasoner", contextWindow: "64k" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "built-in",
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "Nemotron 3 Ultra 550B (Free)", modelId: "nvidia/nemotron-3-ultra-550b-a55b:free", contextWindow: "1m" },
      { name: "North Mini Code (Free)", modelId: "cohere/north-mini-code:free", contextWindow: "256k" },
      { name: "Qwen 3 Next 80B (Free)", modelId: "qwen/qwen3-next-80b-a3b-instruct:free", contextWindow: "262k" },
      { name: "Llama 3.3 70B (Free)", modelId: "meta-llama/llama-3.3-70b-instruct:free", contextWindow: "131k" },
      { name: "Claude Sonnet 4", modelId: "anthropic/claude-sonnet-4", contextWindow: "200k" },
      { name: "GPT-4o", modelId: "openai/gpt-4o", contextWindow: "128k" },
      { name: "Gemini 2.5 Pro", modelId: "google/gemini-2.5-pro-preview", contextWindow: "1m" },
      { name: "DeepSeek R1", modelId: "deepseek/deepseek-r1", contextWindow: "128k" },
      { name: "Llama 4 Maverick", modelId: "meta-llama/llama-4-maverick", contextWindow: "1m" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    type: "built-in",
    enabled: false,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "",
    apiFormat: "openai",
    models: [
      { name: "MiniMax M3", modelId: "minimaxai/minimax-m3", contextWindow: "128k" },
      { name: "GLM-5.1", modelId: "z-ai/glm-5.1", contextWindow: "128k" },
      { name: "Kimi K2.6", modelId: "moonshotai/kimi-k2.6", contextWindow: "128k" },
      { name: "Step 3.7 Flash", modelId: "stepfun-ai/step-3.7-flash", contextWindow: "128k" },
      { name: "Llama 3.3 70B", modelId: "meta/llama-3.3-70b-instruct", contextWindow: "128k" },
      { name: "Llama 3.1 70B", modelId: "meta/llama-3.1-70b-instruct", contextWindow: "128k" },
      { name: "Mistral Large", modelId: "mistralai/mistral-large-2-instruct", contextWindow: "32k" },
      { name: "Mistral Medium 3.5", modelId: "mistralai/mistral-medium-3.5-128b", contextWindow: "128k" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    type: "built-in",
    enabled: false,
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    apiFormat: "openai",
    models: [
      { name: "Llama 3.3 70B", modelId: "llama3.3:70b", contextWindow: "128k" },
      { name: "Llama 3.1 8B", modelId: "llama3.1:8b", contextWindow: "128k" },
      { name: "CodeLlama 13B", modelId: "codellama:13b", contextWindow: "16k" },
      { name: "Mistral 7B", modelId: "mistral:7b", contextWindow: "32k" },
    ],
  },
];

type ModelProvidersState = {
  providers: ModelProvider[];
  addProvider: (provider: Omit<ModelProvider, "id">) => void;
  removeProvider: (id: string) => void;
  toggleProvider: (id: string) => void;
  updateProvider: (id: string, updates: Partial<ModelProvider>) => void;
  addModel: (providerId: string, model: { name: string; modelId: string; contextWindow: string }) => void;
  removeModel: (providerId: string, modelId: string) => void;
  getAllModels: () => { providerName: string; model: { name: string; modelId: string; contextWindow: string; connected?: boolean } }[];
};

export const useModelProviders = create<ModelProvidersState>((set, get) => ({
  providers: loadProviders(),
  addProvider(provider) {
    const id = provider.name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString(36);
    set((s) => ({
      providers: [...s.providers, { ...provider, id }],
    }));
    saveProviders(get().providers);
  },
  removeProvider(id) {
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
    }));
    saveProviders(get().providers);
    localStorage.removeItem(`dalam.provider.${id}`);
  },
  toggleProvider(id) {
    set((s) => ({
      providers: s.providers.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p),
    }));
    saveProviders(get().providers);
  },
  updateProvider(id, updates) {
    set((s) => ({
      providers: s.providers.map((p) => p.id === id ? { ...p, ...updates } : p),
    }));
    saveProviders(get().providers);
  },
  addModel(providerId, model) {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, { ...model, connected: false }] } : p
      ),
    }));
    saveProviders(get().providers);
  },
  removeModel(providerId, modelId) {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === providerId ? { ...p, models: p.models.filter((m) => m.modelId !== modelId) } : p
      ),
    }));
    saveProviders(get().providers);
  },
  getAllModels() {
    const { providers } = get();
    const result: { providerName: string; model: { name: string; modelId: string; contextWindow: string; connected?: boolean } }[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (m.enabled === false) continue;
        result.push({ providerName: p.name, model: m });
      }
    }
    return result;
  },
}));
