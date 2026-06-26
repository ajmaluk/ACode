import { useState, useEffect } from "react";
import {
  useSettingsView, useSettings, useSkillsMcp, useModelProviders, useAgents, useWorkspace,
  type SettingsTab, type ModelProvider, type PrimaryAgentName, type AgentInfo, type PermissionRule, type PermissionAction,
} from "@/store/useAppStore";
import { useToasts } from "@/components/ui/Toaster";
import { createDalamAPI } from "@/lib/dalamAPI";
import { joinPath } from "@/lib/pathUtils";
import { modKey, platform } from "@/lib/platform";
import { MemoryGraph } from "./MemoryGraph";
import {
  X, Settings as SettingsIcon, Code2, Cpu, Sparkles, Plug, ChevronLeft,
  Puzzle, Terminal, Database, Rocket, Plus, ChevronDown, Trash2,
  Bot, Zap, ClipboardList, FolderOpen, Shield, CheckCircle2, Network,
} from "lucide-react";

const TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "code-preview", label: "Code preview", icon: Code2 },
  { id: "models", label: "Model settings", icon: Cpu },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "instructions", label: "Instructions", icon: ClipboardList },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP Servers", icon: Plug },
  { id: "memory-graph", label: "Memory Graph", icon: Network },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "commands", label: "Commands", icon: Terminal },
  { id: "indexing", label: "Indexing", icon: Database },
  { id: "onboard", label: "Onboard", icon: Rocket },
];

export function SettingsModal() {
  const { openState, close, activeTab, setActiveTab } = useSettingsView();

  useEffect(() => {
    if (!openState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openState, close]);

  if (!openState) return null;

  return (
    <div className="fixed inset-0 z-50 bg-dalam-bg-primary flex flex-col animate-fade-in">
      <div className="flex flex-1 min-h-0">
        <nav className="w-56 flex-shrink-0 border-r border-dalam-border-primary bg-dalam-bg-secondary py-4 flex flex-col">
          <button className="mx-4 mb-4 flex items-center gap-2 text-sm text-dalam-text-secondary hover:text-dalam-text-primary transition-colors" onClick={close}>
            <ChevronLeft className="w-4 h-4" />
            Back to workspace
          </button>
          <div className="flex-1 min-h-0 overflow-y-auto px-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = t.id === activeTab;
              return (
                <button key={t.id} onClick={() => setActiveTab(t.id)}
                  className={`w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors mb-0.5 ${active ? "bg-dalam-accent-subtle text-dalam-text-primary" : "text-dalam-text-secondary hover:bg-dalam-bg-hover hover:text-dalam-text-primary"}`}>
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto py-8 px-10 w-full">
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "code-preview" && <CodePreviewTab />}
            {activeTab === "models" && <ModelsTab />}
            {activeTab === "agents" && <AgentsTab />}
            {activeTab === "permissions" && <PermissionsTab />}
            {activeTab === "instructions" && <InstructionsTab />}
            {activeTab === "skills" && <SkillsTab />}
            {activeTab === "mcp" && <McpTab />}
            {activeTab === "memory-graph" && <MemoryGraphTab />}
            {activeTab === "plugins" && <PluginsTab />}
            {activeTab === "commands" && <CommandsTab />}
            {activeTab === "indexing" && <IndexingTab />}
            {activeTab === "onboard" && <OnboardTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl p-6 mb-4">
      <div className="mb-4"><h3 className="text-sm font-medium text-dalam-text-primary">{title}</h3>{description && <p className="text-xs text-dalam-text-muted mt-1">{description}</p>}</div>
      {children}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-xs uppercase tracking-wider text-dalam-text-muted mb-1">{title}</h3>
      {hint && <p className="text-xs text-dalam-text-muted mb-3">{hint}</p>}
      {children}
    </section>
  );
}

function GeneralTab() {
  const { settings, update } = useSettings();
  const [terminalFont, setTerminalFont] = useState(settings.terminalFont);
  const [httpProxy, setHttpProxy] = useState(settings.httpProxy);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTerminalFont(settings.terminalFont);
  }, [settings.terminalFont]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHttpProxy(settings.httpProxy);
  }, [settings.httpProxy]);

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-8">General</h1>
      <div className="flex gap-2 mb-6">
        {(["Dark", "Light", "System default"] as const).map((label) => {
          const val = label === "Dark" ? "dark" : label === "Light" ? "light" : "system";
          const isActive = settings.theme === val;
          return (
            <button key={label} onClick={() => update("theme", val)}
              className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${isActive ? "bg-dalam-bg-active text-dalam-text-primary border-dalam-border-primary" : "bg-dalam-bg-secondary text-dalam-text-secondary border-dalam-border-primary hover:bg-dalam-bg-hover"}`}>
              {label}
            </button>
          );
        })}
      </div>
      <Card title="Language" description="Choose the display language used by the application UI.">
        <div className="flex justify-end">
          <div className="relative">
            <select className="input-base w-48 appearance-none pr-8" value={settings.language} onChange={(e) => update("language", e.target.value)}>
              <option value="en">English</option><option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="ja">日本語</option><option value="zh">中文</option><option value="ko">한국어</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" />
          </div>
        </div>
      </Card>
      <Card title="Interface zoom" description="Adjust the overall size of text and controls in the current window.">
        <div className="flex justify-end">
          <div className="flex rounded-lg border border-dalam-border-primary overflow-hidden">
            {(["Smaller", "Default", "Larger"] as const).map((label) => {
              const isActive = (label === "Smaller" && settings.uiZoom < 0.95) || (label === "Default" && settings.uiZoom >= 0.95 && settings.uiZoom <= 1.05) || (label === "Larger" && settings.uiZoom > 1.05);
              return (
                <button key={label} className={`px-4 py-1.5 text-sm transition-colors ${isActive ? "bg-dalam-bg-active text-dalam-text-primary" : "bg-dalam-bg-secondary text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                  onClick={() => update("uiZoom", label === "Smaller" ? 0.9 : label === "Default" ? 1.0 : 1.15)}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </Card>
      <div className="my-6 border-t border-dalam-border-primary" />
      <Card title="Inherit system terminal profile" description="When launching the built-in terminal, inherit login shell environment, proxy, Kubernetes variables, and local terminal font when possible.">
        <div className="flex justify-end"><Toggle checked={settings.inheritSystemTerminal} onChange={() => update("inheritSystemTerminal", !settings.inheritSystemTerminal)} label="Inherit system terminal profile" /></div>
      </Card>
      <Card title="Terminal font" description="Leave blank to auto-detect system terminal settings; set a value to override the Dalam terminal font.">
        <div className="flex items-center gap-3">
          <input className="input-base flex-1" value={terminalFont} placeholder="Leave blank to inherit, e.g. MesloLGS NF, monospace" onChange={(e) => setTerminalFont(e.target.value)} />
          <button className="px-4 py-1.5 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors" onClick={() => update("terminalFont", terminalFont)}>Save</button>
        </div>
      </Card>
      <div className="my-6 border-t border-dalam-border-primary" />
      <Card title="HTTP Proxy" description="Route model, MCP, command-tool, and app renderer egress traffic through this proxy. Leave blank for direct connections. Restart the app to take effect.">
        <div className="flex items-center gap-3">
          <input className="input-base flex-1" value={httpProxy} placeholder="Leave blank for direct, e.g. http://127.0.0.1:7890" onChange={(e) => setHttpProxy(e.target.value)} />
          <button className="px-4 py-1.5 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors" onClick={() => update("httpProxy", httpProxy)}>Save</button>
        </div>
      </Card>
    </>
  );
}

function CodePreviewTab() {
  const { settings, update } = useSettings();
  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-8">Code preview</h1>
      <Card title="Light code theme" description="Theme used for code blocks while the interface is in light mode.">
        <div className="flex justify-end"><div className="relative"><select className="input-base w-56 appearance-none pr-8" value={settings.codeThemeLight} onChange={(e) => update("codeThemeLight", e.target.value)}><option value="github-light">GitHub Light</option><option value="solarized-light">Solarized Light</option></select><ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" /></div></div>
      </Card>
      <Card title="Dark code theme" description="Theme used for code blocks while the interface is in dark mode.">
        <div className="flex justify-end"><div className="relative"><select className="input-base w-56 appearance-none pr-8" value={settings.codeThemeDark} onChange={(e) => update("codeThemeDark", e.target.value)}><option value="dalam-dark">Dalam Dark</option><option value="github-dark">GitHub Dark</option><option value="one-dark">One Dark</option><option value="dracula">Dracula</option></select><ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" /></div></div>
      </Card>
      <Card title="Show line numbers" description="Display line numbers in code previews.">
        <div className="flex justify-end"><Toggle checked={settings.showLineNumbers} onChange={() => update("showLineNumbers", !settings.showLineNumbers)} label="Show line numbers in code previews" /></div>
      </Card>
      <Card title="Wrap long lines" description="Wrap long content inside the preview area automatically.">
        <div className="flex justify-end"><Toggle checked={settings.wordWrap} onChange={() => update("wordWrap", !settings.wordWrap)} label="Wrap long lines inside preview area" /></div>
      </Card>
      <Card title="Code font size" description="Adjust the default font size used by code previews.">
        <div className="flex items-center gap-4">
          <input type="range" min={10} max={22} value={settings.codeFontSize} onChange={(e) => update("codeFontSize", Number(e.target.value))} className="flex-1 accent-dalam-accent-primary" />
          <span className="text-sm text-dalam-text-primary w-8 text-right">{settings.codeFontSize}</span>
        </div>
      </Card>
      <div className="mt-8">
        <h3 className="text-sm font-medium text-dalam-text-primary mb-2">Live preview</h3>
        <p className="text-xs text-dalam-text-muted mb-4">The code viewer on the right automatically switches to the matching theme for the current app mode.</p>
        <div className="grid grid-cols-2 gap-4">
          {(["Light", "Dark"] as const).map((mode) => (
            <div key={mode} className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-medium text-dalam-text-primary">{mode} preview</div>
                  <div className="text-xs text-dalam-text-muted">{mode === "Light" ? settings.codeThemeLight : settings.codeThemeDark}</div>
                </div>
                <span className={`px-2 py-0.5 text-[10px] rounded ${mode === "Dark" ? "bg-dalam-accent-primary text-white" : "bg-dalam-bg-tertiary text-dalam-text-secondary border border-dalam-border-primary"}`}>{mode === "Dark" ? "Active" : mode}</span>
              </div>
              <pre className="text-mono text-xs leading-relaxed text-dalam-text-primary bg-dalam-bg-primary rounded-lg p-3 overflow-x-auto"><code>{`const themePreview: ThemeConfig = {\n  surface: "sidebar",\n  accent: "#339CFF",\n  contrast: 45,\n};`}</code></pre>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ModelsTab() {
  const { providers } = useModelProviders();
  const { selectedProviderId, setSelectedProvider } = useSettingsView();
  const [showAdd, setShowAdd] = useState(false);
  const selected = providers.find((p) => p.id === selectedProviderId);

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Model settings</h1>
      <p className="text-sm text-dalam-text-muted mb-8">Manage custom model providers. Once configured, they can be selected during chat.</p>
      <div className="flex gap-0 border border-dalam-border-primary rounded-xl overflow-hidden bg-dalam-bg-secondary">
        <div className="w-56 flex-shrink-0 border-r border-dalam-border-primary">
          <div className="px-4 py-3 text-xs text-dalam-text-muted uppercase tracking-wider border-b border-dalam-border-primary">Providers</div>
          <div className="p-2">
            {providers.filter(p => p.type === "built-in").map((p) => (
              <button key={p.id} className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${selectedProviderId === p.id ? "bg-dalam-accent-subtle text-dalam-text-primary" : "text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                onClick={() => { setSelectedProvider(p.id); setShowAdd(false); }}>
                <span className="w-5 h-5 rounded bg-dalam-bg-active flex items-center justify-center text-[10px] font-bold text-dalam-text-primary">A</span>
                <span className="flex-1 truncate">{p.name}</span>
                <span className={`w-2 h-2 rounded-full ${p.apiKey ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
              </button>
            ))}
          </div>
          <div className="px-4 py-2 text-xs text-dalam-text-muted uppercase tracking-wider border-t border-b border-dalam-border-primary">Custom providers</div>
          <div className="p-2">
            {providers.filter(p => p.type === "custom").map((p) => (
              <button key={p.id} className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${selectedProviderId === p.id ? "bg-dalam-accent-subtle text-dalam-text-primary" : "text-dalam-text-secondary hover:bg-dalam-bg-hover"}`}
                onClick={() => { setSelectedProvider(p.id); setShowAdd(false); }}>
                <span className="w-5 h-5 rounded bg-dalam-bg-active flex items-center justify-center text-[10px] font-bold text-dalam-text-primary">{p.name[0]}</span>
                <span className="flex-1 truncate">{p.name}</span>
                <span className={`w-2 h-2 rounded-full ${p.apiKey ? "bg-dalam-git-added" : "bg-dalam-text-muted"}`} />
              </button>
            ))}
            <button className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors mt-1" onClick={() => { setShowAdd(true); setSelectedProvider(null); }}>
              <Plus className="w-4 h-4" />Add provider
            </button>
          </div>
        </div>
        <div className="flex-1 min-w-0 p-6">
          {showAdd ? <AddProviderForm onDone={() => setShowAdd(false)} /> : selected ? <ProviderDetail key={selected.id} provider={selected} /> : <div className="flex items-center justify-center h-64 text-sm text-dalam-text-muted">Select a provider to view details</div>}
        </div>
      </div>
    </>
  );
}

function ProviderDetail({ provider }: { provider: ModelProvider }) {
  const { updateProvider, toggleProvider, removeModel } = useModelProviders();
  const [apiKey, setApiKey] = useState(provider.apiKey || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testError, setTestError] = useState("");
  const [showAddModel, setShowAddModel] = useState(false);
  const [dirty, setDirty] = useState(false);

  if (provider.type === "custom") return <CustomProviderDetail key={provider.id} provider={provider} />;

  const saveProvider = () => {
    updateProvider(provider.id, { apiKey, baseUrl });
    setDirty(false);
  };

  const testConnection = async () => {
    if (!baseUrl || !apiKey) return;
    setTestStatus("testing");
    setTestError("");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 15000);
    try {
      // First try to find a connected model, then fall back to first model
      const connectedModel = provider.models.find((m) => m.connected);
      const modelId = connectedModel?.modelId || provider.models[0]?.modelId;
      if (!modelId) { setTestStatus("error"); setTestError("No models configured"); return; }
      const endpoint = baseUrl.replace(/\/+$/, "") + (provider.apiFormat === "anthropic" ? "/v1/messages" : "/chat/completions");
      // Use Tauri HTTP plugin to bypass CORS restrictions
      let resp: Response;
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const tauriResp = await tauriFetch(endpoint, {
          method: "POST",
          headers: provider.apiFormat === "anthropic"
            ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(
            provider.apiFormat === "anthropic"
              ? { model: modelId, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }
              : { model: modelId, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }
          ),
        });
        resp = {
          ok: tauriResp.ok,
          status: tauriResp.status,
          statusText: tauriResp.statusText,
          text: async () => new TextDecoder().decode(await tauriResp.arrayBuffer()),
        } as Response;
      } catch {
        // Fallback to browser fetch if Tauri HTTP plugin unavailable
        resp = await fetch(endpoint, {
          method: "POST",
          headers: provider.apiFormat === "anthropic"
            ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(
            provider.apiFormat === "anthropic"
              ? { model: modelId, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }
              : { model: modelId, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }
          ),
          signal: ac.signal,
        });
      }
      clearTimeout(timeoutId);
      if (resp.ok) {
        setTestStatus("ok");
        updateProvider(provider.id, { models: provider.models.map(m => m.modelId === modelId ? { ...m, connected: true } : m) });
      } else {
        const body = await resp.text().catch(() => "");
        setTestStatus("error");
        setTestError(`HTTP ${resp.status}: ${body.slice(0, 120)}`);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      setTestStatus("error");
      setTestError(ac.signal.aborted ? "Connection timed out (15s)" : String(err));
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-dalam-bg-active flex items-center justify-center text-sm font-bold text-dalam-text-primary">{provider.name[0]}</span>
          <span className="text-lg font-semibold text-dalam-text-primary">{provider.name}</span>
          <Toggle checked={provider.enabled} onChange={() => toggleProvider(provider.id)} label={`Enable ${provider.name}`} />
        </div>
        {dirty && (
          <button
            className="px-4 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-sm rounded-lg transition-colors"
            onClick={saveProvider}
          >
            Save
          </button>
        )}
      </div>

      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">Base URL</label>
          <input className="input-base w-full" value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); setTestStatus("idle"); }} />
        </div>
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">API key</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input className="input-base w-full pr-10" type={showApiKey ? "text" : "password"} value={apiKey}
                placeholder={`Enter ${provider.name} API key`}
                onChange={(e) => { setApiKey(e.target.value); setDirty(true); setTestStatus("idle"); }} />
              <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                onClick={() => setShowApiKey(!showApiKey)}>
                {showApiKey ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                )}
              </button>
            </div>
            <button className="px-4 py-1.5 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors"
              onClick={testConnection} disabled={!apiKey || testStatus === "testing"}>
              {testStatus === "testing" ? "Testing…" : testStatus === "ok" ? "Connected!" : testStatus === "error" ? "Failed" : "Test"}
            </button>
          </div>
          {testStatus === "error" && (
            <p className="text-xs text-dalam-git-deleted mt-1 break-all">{testError || "Connection failed. Check your API key and network."}</p>
          )}
          {testStatus === "ok" && (
            <p className="text-xs text-dalam-git-added mt-1">Connected successfully.</p>
          )}
        </div>
      </div>

      {provider.models.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-dalam-text-primary">Model list</span>
            <button onClick={() => setShowAddModel(true)} className="text-xs text-dalam-accent-primary hover:text-dalam-accent-hover transition-colors">+ Add model</button>
          </div>
          <div className="space-y-2">
            {provider.models.map((m) => (
              <div key={m.modelId} className="flex items-center justify-between px-4 py-3 bg-dalam-bg-tertiary border border-dalam-border-primary rounded-xl">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-dalam-text-primary">{m.name}</span>
                  <span className="px-2 py-0.5 text-[10px] rounded bg-dalam-bg-active text-dalam-text-secondary border border-dalam-border-primary">{m.contextWindow}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle checked={m.enabled !== false} onChange={() => {
                    const updatedModels = provider.models.map(mod => mod.modelId === m.modelId ? { ...mod, enabled: mod.enabled === false ? true : false } : mod);
                    updateProvider(provider.id, { models: updatedModels });
                  }} label={`Enable ${m.name}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {showAddModel && <AddModelModal providerId={provider.id} onClose={() => setShowAddModel(false)} />}
    </div>
  );
}

function CustomProviderDetail({ provider }: { provider: ModelProvider }) {
  const { removeProvider, updateProvider, removeModel, toggleProvider } = useModelProviders();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [apiFormat, setApiFormat] = useState<"anthropic" | "openai">(provider.apiFormat || "openai");
  const [apiKey, setApiKey] = useState(provider.apiKey || "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {editingName ? (
            <input className="input-base text-lg font-semibold w-48" value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={() => { updateProvider(provider.id, { name: nameValue }); setEditingName(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { updateProvider(provider.id, { name: nameValue }); setEditingName(false); } }}
              autoFocus />
          ) : (
            <>
              <span className="w-8 h-8 rounded-lg bg-dalam-bg-active flex items-center justify-center text-sm font-bold text-dalam-text-primary">{provider.name[0]}</span>
              <span className="text-lg font-semibold text-dalam-text-primary">{provider.name}</span>
              <button onClick={() => setEditingName(true)} className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              </button>
            </>
          )}
          <Toggle checked={provider.enabled} onChange={() => toggleProvider(provider.id)} label={`Enable ${provider.name}`} />
        </div>
        <button className="text-dalam-text-muted hover:text-dalam-git-deleted transition-colors" onClick={() => removeProvider(provider.id)} title="Delete provider">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
        </button>
      </div>

      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">Base URL</label>
          <input className="input-base w-full" value={baseUrl} placeholder="https://api.example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => updateProvider(provider.id, { baseUrl })} />
        </div>
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">API format</label>
          <div className="relative">
            <select className="input-base w-full appearance-none pr-8" value={apiFormat}
              onChange={(e) => { const v = e.target.value as "anthropic" | "openai"; setApiFormat(v); updateProvider(provider.id, { apiFormat: v }); }}>
              <option value="openai">Chat completions (/chat/completions)</option>
              <option value="anthropic">Anthropic messages (/v1/messages)</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" />
          </div>
        </div>
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">API key</label>
          <div className="relative">
            <input className="input-base w-full pr-10" type={showApiKey ? "text" : "password"} value={apiKey} placeholder="Enter API key"
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => updateProvider(provider.id, { apiKey })} />
            <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
              onClick={() => setShowApiKey(!showApiKey)}>
              {showApiKey ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <div>
        <span className="text-sm font-medium text-dalam-text-primary mb-3 block">Model list</span>
        {provider.models.length > 0 ? (
          <div className="space-y-2 mb-3">
            {provider.models.map((m) => (
              <div key={m.modelId} className="flex items-center gap-3 px-4 py-3 bg-dalam-bg-tertiary border border-dalam-border-primary rounded-xl">
                <span className="flex-1 text-sm text-dalam-text-primary font-mono">{m.name}</span>
                <span className="px-2 py-0.5 text-[10px] rounded bg-dalam-bg-active text-dalam-text-secondary border border-dalam-border-primary">{m.contextWindow}</span>
                {m.connected && <span className="px-2 py-0.5 text-[10px] rounded bg-dalam-git-added/20 text-dalam-git-added">Connected!</span>}
                <Toggle checked={m.enabled !== false} onChange={() => {
                  const updatedModels = provider.models.map(mod => mod.modelId === m.modelId ? { ...mod, enabled: mod.enabled === false ? true : false } : mod);
                  updateProvider(provider.id, { models: updatedModels });
                }} label={`Enable ${m.name}`} />
                <button className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors" title="Copy model ID"
                  onClick={() => { void navigator.clipboard.writeText(m.modelId); }}>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                </button>
                <button className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors" title="Edit">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                </button>
                <button className="text-dalam-text-muted hover:text-dalam-git-deleted transition-colors" title="Delete"
                  onClick={() => removeModel(provider.id, m.modelId)}>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-sm text-dalam-text-muted mb-3">No models configured yet.</div>
        )}
        <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-dalam-text-secondary hover:text-dalam-text-primary bg-dalam-bg-active hover:bg-dalam-bg-tertiary rounded-lg border border-dalam-border-primary transition-colors"
          onClick={() => setShowAddModel(true)}>
          <span className="text-lg leading-none">+</span>Add model
        </button>
      </div>

      {showAddModel && (
        <AddModelModal providerId={provider.id} onClose={() => setShowAddModel(false)} />
      )}
    </div>
  );
}

function AddModelModal({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const { addModel } = useModelProviders();
  const [modelId, setModelId] = useState("");
  const [contextWindow, setContextWindow] = useState("200000");

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onClose}>
      <div className="w-[400px] bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-dalam-text-primary">Add model</h2>
          <button className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-dalam-text-primary mb-1.5">Model ID</label>
            <input className="input-base w-full" value={modelId} placeholder="Model ID" onChange={(e) => setModelId(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="block text-sm text-dalam-text-primary mb-1.5">Context window</label>
            <input className="input-base w-full" type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button className="px-4 py-2 text-sm text-dalam-text-secondary hover:text-dalam-text-primary rounded-lg border border-dalam-border-primary transition-colors" onClick={onClose}>Cancel</button>
          <button className="px-4 py-2 text-sm bg-dalam-text-primary text-dalam-bg-primary rounded-lg hover:opacity-90 transition-opacity"
            onClick={() => { if (!modelId.trim()) return; addModel(providerId, { name: modelId.trim(), modelId: modelId.trim(), contextWindow: contextWindow || "200000" }); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { addProvider } = useModelProviders();
  const toast = useToasts((s) => s.push);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiFormat, setApiFormat] = useState<"anthropic" | "openai">("openai");
  const [models, setModels] = useState<{ name: string; modelId: string; contextWindow: string }[]>([]);

  return (
    <div>
      <h2 className="text-lg font-semibold text-dalam-text-primary mb-1">Add model provider</h2>
      <p className="text-sm text-dalam-text-muted mb-6">Configure a custom API endpoint and initial model.</p>
      <div className="space-y-5">
        <div><label className="block text-sm text-dalam-text-primary mb-1.5">Name</label><input className="input-base w-full" placeholder="e.g. DeepSeek" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="block text-sm text-dalam-text-primary mb-1.5">Base URL</label><input className="input-base w-full" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
        <div><label className="block text-sm text-dalam-text-primary mb-1.5">API key</label><input className="input-base w-full" type="password" placeholder="Enter API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
        <div><label className="block text-sm text-dalam-text-primary mb-1.5">API format</label>
          <div className="relative"><select className="input-base w-full appearance-none pr-8" value={apiFormat} onChange={(e) => setApiFormat(e.target.value as "anthropic" | "openai")}>
            <option value="openai">Chat completions (/chat/completions)</option><option value="anthropic">Anthropic messages (/v1/messages)</option>
          </select><ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" /></div>
        </div>
        <div>
          <label className="block text-sm text-dalam-text-primary mb-1.5">Model list</label>
          <div className="space-y-2 mb-2">
            {models.map((m, i) => (
              <div key={m.modelId || `model-${i}`} className="flex items-center gap-2">
                <input className="input-base flex-1" placeholder="Model name" value={m.name} onChange={(e) => { const n = [...models]; n[i] = { ...n[i], name: e.target.value }; setModels(n); }} />
                <input className="input-base flex-1" placeholder="Model ID" value={m.modelId} onChange={(e) => { const n = [...models]; n[i] = { ...n[i], modelId: e.target.value }; setModels(n); }} />
                <input className="input-base w-24" placeholder="Context" value={m.contextWindow} onChange={(e) => { const n = [...models]; n[i] = { ...n[i], contextWindow: e.target.value }; setModels(n); }} />
                <button className="btn-icon text-dalam-git-deleted" onClick={() => setModels(models.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-dalam-text-secondary hover:text-dalam-text-primary bg-dalam-bg-active hover:bg-dalam-bg-tertiary rounded-lg border border-dalam-border-primary transition-colors" onClick={() => setModels([...models, { name: "", modelId: "", contextWindow: "" }])}><Plus className="w-3.5 h-3.5" />Add model</button>
        </div>
        <button className="px-4 py-2 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-sm rounded-lg transition-colors" onClick={() => {
          if (!name.trim()) { toast({ kind: "error", title: "Provider name required" }); return; }
          if (!baseUrl.trim()) { toast({ kind: "error", title: "Base URL required" }); return; }
          const parsedUrl = (() => {
            try { return new URL(baseUrl.trim()); } catch { return null; }
          })();
          if (!parsedUrl) { toast({ kind: "error", title: "Invalid base URL" }); return; }
          if (!apiKey.trim()) { toast({ kind: "error", title: "API key required" }); return; }
          if (!models.length || models.some(m => !m.name.trim() || !m.modelId.trim())) {
            toast({ kind: "error", title: "At least one valid model required" }); return;
          }
          addProvider({ name: name.trim(), type: "custom", enabled: true, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), apiFormat, models }); onDone();
        }}>Add provider</button>
      </div>
    </div>
  );
}

// ============================================================================
// Agents tab — primary agents (build/plan/yolo) and subagents
// ============================================================================

const PRIMARY_DISPLAY: Record<PrimaryAgentName, { label: string; description: string; icon: React.ElementType; color: string }> = {
  build: { label: "Build", description: "Executes tools based on configured permissions. Asks before each operation.", icon: Zap, color: "text-amber-400" },
  plan: { label: "Plan", description: "Read-only analysis. Produces a plan you can review, then switches to Build to execute.", icon: ClipboardList, color: "text-emerald-400" },
  yolo: { label: "YOLO", description: "Full access — reads, writes, executes everything without asking. Use with caution.", icon: Sparkles, color: "text-rose-400" },
};

function AgentsTab() {
  const { activeAgentName, setActiveAgent, agents } = useAgents();
  const toast = useToasts((s) => s.push);
  const primaryAgents = agents.filter((a) => a.mode === "primary");
  const subagents = agents.filter((a) => a.mode === "subagent");

  return (
    <>
      <Section
        title="Primary agent"
        hint="The agent that handles your messages. Each one has a different permission ruleset and tool set."
      >
        <div className="space-y-2 mb-8">
        {primaryAgents.map((agent: AgentInfo) => {
          const meta = PRIMARY_DISPLAY[agent.name as PrimaryAgentName];
          const Icon = meta.icon;
          const active = activeAgentName === agent.name;
          return (
            <button
              key={agent.name}
              onClick={() => { setActiveAgent(agent.name as PrimaryAgentName); toast({ kind: "info", title: `Switched to ${meta.label}`, description: meta.description }); }}
              className={`w-full text-left surface p-4 transition-colors ${
                active ? "ring-1 ring-dalam-accent-primary" : "hover:border-dalam-accent-primary"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-dalam-bg-tertiary flex items-center justify-center flex-shrink-0">
                  <Icon className={`w-5 h-5 ${meta.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-dalam-text-primary">{meta.label}</span>
                    {agent.color && (
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.color }} />
                    )}
                    {active && <span className="text-[9px] uppercase tracking-wider text-dalam-accent-primary font-medium">active</span>}
                  </div>
                  <div className="text-xs text-dalam-text-muted mt-1">{meta.description}</div>
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-dalam-text-muted font-mono">
                    <span>{agent.permission.length} rules</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      </Section>

      <Section
        title="Subagents"
        hint="Specialized agents the primary agent can delegate to. Subagents run in their own context and return a summary."
      >
      <div className="border border-dalam-border-primary rounded-lg overflow-hidden mb-8">
        {subagents.map((agent: AgentInfo, idx: number) => (
          <div
            key={agent.name}
            className={`flex items-start gap-3 px-3 py-2.5 hover:bg-dalam-bg-hover transition-colors ${
              idx < subagents.length - 1 ? "border-b border-dalam-border-primary" : ""
            }`}
          >
            <div className="w-8 h-8 rounded-md bg-dalam-bg-tertiary flex items-center justify-center flex-shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-dalam-text-muted" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-dalam-text-primary font-medium">{agent.name}</span>
                {agent.color && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: agent.color }} />}
                <span className="chip">{agent.category}</span>
                {agent.native && <span className="chip text-dalam-accent-primary">built-in</span>}
              </div>
              <div className="text-xs text-dalam-text-muted mt-0.5">{agent.description}</div>
              <div className="mt-1 text-[10px] text-dalam-text-muted font-mono">
                {agent.permission.length} permission rules
              </div>
            </div>
          </div>
        ))}
      </div>
      </Section>
    </>
  );
}

const PERMISSION_TYPES = [
  { key: "bash", label: "Shell (bash)", desc: "Run shell commands", icon: Terminal },
  { key: "edit", label: "Edit files", desc: "Modify files in your workspace", icon: Code2 },
  { key: "read", label: "Read files", desc: "Read file contents", icon: Code2 },
  { key: "write", label: "Write files", desc: "Create new files", icon: Code2 },
  { key: "webfetch", label: "Web fetch", desc: "Fetch content from URLs", icon: Plug },
  { key: "websearch", label: "Web search", desc: "Search the web", icon: Plug },
  { key: "task", label: "Task delegation", desc: "Delegate to a subagent", icon: Bot },
  { key: "skill", label: "Skill invocation", desc: "Invoke a $skill", icon: Sparkles },
  { key: "question", label: "Ask question", desc: "Ask the user a clarifying question", icon: ClipboardList },
  { key: "doom_loop", label: "Doom loop", desc: "Same tool call repeated", icon: Sparkles },
  { key: "external_directory", label: "External dir", desc: "Files outside the workspace", icon: FolderOpen },
  { key: "plan_enter", label: "Enter plan", desc: "Switch into plan mode", icon: ClipboardList },
  { key: "plan_exit", label: "Exit plan", desc: "Switch out of plan mode", icon: ClipboardList },
];

const ACTION_META: Record<PermissionAction, { label: string; color: string; desc: string }> = {
  allow: { label: "Allow", color: "text-dalam-git-added", desc: "Run without asking" },
  ask: { label: "Ask", color: "text-amber-400", desc: "Prompt for confirmation" },
  deny: { label: "Deny", color: "text-dalam-git-deleted", desc: "Block the action" },
};

function PermissionsTab() {
  const { agents, activeAgentName, setActiveAgent, userRules, upsertRule, removeRule, resetRules } = useAgents();
  const [newPerm, setNewPerm] = useState<string>("bash");
  const [newPattern, setNewPattern] = useState<string>("*");
  const [newAction, setNewAction] = useState<PermissionAction>("ask");
  const toast = useToasts((s) => s.push);

  const activeAgent = agents.find((a: AgentInfo) => a.name === activeAgentName);
  const allRules: PermissionRule[] = activeAgent?.permission ?? [];

  return (
    <>
      <Section
        title="Permission policy"
        hint={`Editing the permission ruleset for the ${activeAgentName.toUpperCase()} agent. Rules are merged with the agent's defaults — your custom rules override.`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-dalam-text-muted">Active agent:</span>
          <select
            className="input-base text-xs"
            value={activeAgentName}
            onChange={(e) => setActiveAgent(e.target.value as PrimaryAgentName)}
          >
            {agents.filter((a: AgentInfo) => a.mode === "primary").map((a: AgentInfo) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
      </Section>

      <Section
        title="Add rule"
        hint="Rules are evaluated top-to-bottom. Specific patterns override wildcards. * matches anything."
      >
        <div className="surface p-3">
          <div className="grid grid-cols-[180px_1fr_120px_auto] gap-2 items-end">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-dalam-text-muted block mb-1">Permission</label>
              <select className="input-base w-full" value={newPerm} onChange={(e) => setNewPerm(e.target.value)}>
                {PERMISSION_TYPES.map((p) => (<option key={p.key} value={p.key}>{p.label}</option>))}
                <option value="*">* (any)</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-dalam-text-muted block mb-1">Pattern</label>
              <input
                className="input-base w-full font-mono text-xs"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g. git status, npm run dev, *"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-dalam-text-muted block mb-1">Action</label>
              <select className="input-base w-full" value={newAction} onChange={(e) => setNewAction(e.target.value as PermissionAction)}>
                <option value="allow">Allow</option>
                <option value="ask">Ask</option>
                <option value="deny">Deny</option>
              </select>
            </div>
            <button
              className="px-3 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-xs rounded-md transition-colors"
              onClick={() => {
                if (!newPattern.trim()) { toast({ kind: "error", title: "Pattern required" }); return; }
                upsertRule({ permission: newPerm, pattern: newPattern.trim(), action: newAction });
                toast({ kind: "success", title: "Rule added", description: `${newPerm} ${newPattern} → ${newAction}` });
                setNewPattern("*");
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </Section>

      <Section title="Agent defaults" hint="These rules ship with the agent. Add your own rules above to override them.">
        <div className="border border-dalam-border-primary rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_80px_24px] px-3 py-2 bg-dalam-bg-tertiary text-[10px] uppercase tracking-wider text-dalam-text-muted">
            <span>Permission</span>
            <span>Pattern</span>
            <span>Action</span>
            <span></span>
          </div>
          {allRules.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-dalam-text-muted">No rules.</div>
          )}
          {allRules.map((r: PermissionRule, idx: number) => {
            const meta = ACTION_META[r.action] ?? ACTION_META.ask;
            return (
              <div
                key={`${r.permission}-${r.pattern}-${idx}`}
                className="grid grid-cols-[1fr_1fr_80px_24px] px-3 py-2 items-center text-xs border-t border-dalam-border-primary hover:bg-dalam-bg-hover/40"
              >
                <span className="text-dalam-text-primary font-mono">{r.permission}</span>
                <span className="text-dalam-text-secondary font-mono truncate">{r.pattern}</span>
                <span className={`font-medium ${meta.color}`}>{meta.label}</span>
                <span></span>
              </div>
            );
          })}
        </div>
      </Section>

      {userRules.length > 0 && (
        <Section title="Your custom rules" hint="These override the agent defaults. Higher entries win over lower ones.">
          <div className="border border-dalam-border-primary rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_80px_24px] px-3 py-2 bg-dalam-bg-tertiary text-[10px] uppercase tracking-wider text-dalam-text-muted">
              <span>Permission</span>
              <span>Pattern</span>
              <span>Action</span>
              <span></span>
            </div>
            {userRules.map((r: PermissionRule, idx: number) => {
              const meta = ACTION_META[r.action] ?? ACTION_META.ask;
              return (
                <div
                  key={`user-${r.permission}-${r.pattern}-${idx}`}
                  className="grid grid-cols-[1fr_1fr_80px_24px] px-3 py-2 items-center text-xs border-t border-dalam-border-primary hover:bg-dalam-bg-hover/40"
                >
                  <span className="text-dalam-text-primary font-mono">{r.permission}</span>
                  <span className="text-dalam-text-secondary font-mono truncate">{r.pattern}</span>
                  <span className={`font-medium ${meta.color}`}>{meta.label}</span>
                  <button
                    className="btn-icon p-0.5"
                    onClick={() => { removeRule(r.permission, r.pattern); toast({ kind: "info", title: "Rule removed" }); }}
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            className="mt-2 px-3 py-1.5 text-xs text-dalam-text-secondary hover:text-dalam-text-primary bg-dalam-bg-active hover:bg-dalam-bg-tertiary rounded-md border border-dalam-border-primary transition-colors"
            onClick={() => { resetRules(); toast({ kind: "info", title: "Custom rules reset" }); }}
          >
            Reset to defaults
          </button>
        </Section>
      )}

      <Section title="How permissions are evaluated" hint="For each tool call, Dalam walks the rules top-to-bottom and uses the first match.">
        <ol className="text-xs text-dalam-text-secondary space-y-1.5 list-decimal pl-5">
          <li>Exact <code className="text-mono text-dalam-text-primary">(permission, pattern)</code> match wins.</li>
          <li>Then the wildcard pattern <code className="text-mono text-dalam-text-primary">*</code> for that permission.</li>
          <li>Then the global wildcard <code className="text-mono text-dalam-text-primary">*</code> rule.</li>
          <li>If nothing matches, the action is <strong>ask</strong>.</li>
        </ol>
        <p className="text-xs text-dalam-text-muted mt-3">
          For shell commands, the pattern is resolved by the <strong>arity table</strong> — the longest
          matching command prefix becomes the canonical pattern. e.g. <code className="text-mono">git checkout main -b feature</code> →
          <code className="text-mono ml-1">git checkout</code>.
        </p>
      </Section>
    </>
  );
}

function SkillsTab() {
  const { skills, toggleSkill, addSkill, removeSkill } = useSkillsMcp();
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newScope, setNewScope] = useState<"global" | "workspace">("workspace");
  const toast = useToasts((s) => s.push);

  const filtered = skills.filter((s) =>
    !query.trim() ||
    s.name.toLowerCase().includes(query.toLowerCase()) ||
    s.description.toLowerCase().includes(query.toLowerCase())
  );

  const onAdd = () => {
    const name = newName.trim().replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    if (!name || !newDesc.trim()) {
      toast({ kind: "warning", title: "Missing fields", description: "Name and description are required." });
      return;
    }
    if (skills.some((s) => s.name === name)) {
      toast({ kind: "warning", title: "Skill exists", description: `A skill named "${name}" already exists.` });
      return;
    }
    addSkill({ name, description: newDesc.trim(), prompt: newPrompt.trim() || `Act on the user's request for: ${newDesc.trim()}`, scope: newScope });
    toast({ kind: "success", title: "Skill added", description: `$${name} is now available in chat.` });
    setNewName(""); setNewDesc(""); setNewPrompt(""); setNewScope("workspace");
    setShowAdd(false);
  };

  return (
    <>
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-3xl font-bold text-dalam-text-primary">Skills</h1>
        <span className="text-xs text-dalam-text-muted">{skills.length}</span>
      </div>
      <p className="text-sm text-dalam-text-muted mb-6">Manage workspace and user skills. Enabled skills can be referenced in chat with <code className="px-1 py-0.5 rounded bg-dalam-bg-tertiary font-mono text-dalam-text-primary">$skill-name</code>.</p>

      {/* Search + actions */}
      <div className="flex items-center gap-2 mb-3">
        <input
          className="input-base text-sm flex-1"
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => setShowAdd((v) => !v)} className="w-8 h-8 flex items-center justify-center rounded-md bg-dalam-bg-tertiary border border-dalam-border-primary text-dalam-text-secondary hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-colors" title="Add skill">
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button className="w-8 h-8 flex items-center justify-center rounded-md bg-dalam-bg-tertiary border border-dalam-border-primary text-dalam-text-secondary hover:bg-dalam-bg-hover hover:text-dalam-text-primary transition-colors" title="Refresh">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
        </button>
      </div>

      {/* Add skill form */}
      {showAdd && (
        <div className="mb-4 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl p-4">
          <div className="text-sm font-medium text-dalam-text-primary mb-3">New skill</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-dalam-text-muted mb-1">Name</label>
              <input className="input-base text-sm w-full" placeholder="my-skill" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <div className="text-[10px] text-dalam-text-muted mt-1">Used as $my-skill in chat</div>
            </div>
            <div>
              <label className="block text-xs text-dalam-text-muted mb-1">Scope</label>
              <div className="relative">
                <select className="input-base text-sm w-full appearance-none pr-8" value={newScope} onChange={(e) => setNewScope(e.target.value as "global" | "workspace")}>
                  <option value="workspace">Workspace</option>
                  <option value="global">Global (all workspaces)</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dalam-text-muted pointer-events-none" />
              </div>
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-xs text-dalam-text-muted mb-1">Description</label>
            <input className="input-base text-sm w-full" placeholder="Short description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="block text-xs text-dalam-text-muted mb-1">Prompt (instructions for the agent)</label>
            <textarea className="input-base text-sm w-full font-mono min-h-[80px]" placeholder="When this skill is invoked, the agent should…" value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors">Cancel</button>
            <button onClick={onAdd} className="px-3 py-1.5 text-xs rounded-md bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white transition-colors">Add skill</button>
          </div>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wider text-dalam-text-muted px-2 mb-2 flex items-center gap-2">
        <span>Workspace and personal skills</span>
        <span className="text-dalam-text-muted/60">· {filtered.length} {filtered.length === 1 ? "skill" : "skills"}</span>
      </div>
      <div className="space-y-1">
        {filtered.length === 0 && (
          <div className="text-center text-sm text-dalam-text-muted py-8">No skills match "{query}".</div>
        )}
        {filtered.map((s) => (
          <div key={s.name} className="group flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dalam-bg-hover transition-colors">
            <div className="flex-shrink-0 w-8 h-8 rounded-md bg-dalam-bg-tertiary flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-dalam-accent-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-dalam-text-primary font-medium truncate">${s.name}</div>
              <div className="text-xs text-dalam-text-muted line-clamp-1">{s.description}</div>
            </div>
            <span className="chip flex-shrink-0">{s.scope === "global" ? "Global" : "Personal"}</span>
            <button
              onClick={() => { if (confirm(`Remove skill "$${s.name}"?`)) removeSkill(s.name); }}
              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-dalam-text-muted hover:text-dalam-git-deleted hover:bg-dalam-bg-active transition-all"
              title="Remove skill"
              aria-label={`Remove ${s.name}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <Toggle checked={s.enabled} onChange={() => toggleSkill(s.name)} label={`Enable ${s.name}`} />
          </div>
        ))}
      </div>
    </>
  );
}

function McpTab() {
  const { mcpServers, toggleMcp, addMcpServer, removeMcpServer } = useSkillsMcp();
  const [view, setView] = useState<"list" | "add">("list");
  const [editMode, setEditMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [envOpen, setEnvOpen] = useState(false);
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const toast = useToasts((s) => s.push);

  const validateJson = (text: string): boolean => {
    if (!text.trim()) { setJsonError(null); return false; }
    try {
      const parsed = JSON.parse(text);
      if (!parsed.name || typeof parsed.name !== "string") { setJsonError("Missing required field: \"name\""); return false; }
      if (parsed.transport === "http" && !parsed.url) { setJsonError("HTTP transport requires \"url\" field"); return false; }
      if (parsed.transport !== "http" && !parsed.command) { setJsonError("Stdio transport requires \"command\" field"); return false; }
      setJsonError(null);
      return true;
    } catch (e) {
      setJsonError(`Invalid JSON: ${(e as Error).message}`);
      return false;
    }
  };

  const JSON_PLACEHOLDER = `{
  "name": "my-server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"],
  "scope": "user"
}

// HTTP transport example:
// {
//   "name": "remote-server",
//   "transport": "http",
//   "url": "https://api.example.com/mcp",
//   "scope": "project"
// }`;

  const reset = () => {
    setName(""); setScope("user"); setTransport("stdio");
    setCommand(""); setArgsText(""); setUrl(""); setEnvOpen(false); setEnvEntries([]); setJsonText("");
  };

  const onAdd = () => {
    if (!name.trim()) { toast({ kind: "warning", title: "Name required" }); return; }
    const args = argsText.split(/\s+/).filter(Boolean);
    const env: Record<string, string> = {};
    envEntries.forEach((e) => { if (e.key.trim()) env[e.key.trim()] = e.value; });
    addMcpServer({
      name: name.trim(),
      transport,
      ...(transport === "stdio" ? { command: command.trim(), args } : { url: url.trim() }),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      scope,
    });
    toast({ kind: "success", title: "MCP server added", description: `${name} is configured.` });
    reset();
    setView("list");
  };

  const onAddFromJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      addMcpServer({
        name: parsed.name,
        transport: parsed.transport ?? "stdio",
        command: parsed.command,
        args: parsed.args,
        url: parsed.url,
        scope: parsed.scope ?? "user",
      });
      toast({ kind: "success", title: "MCP server added" });
      setJsonText("");
      setView("list");
    } catch (e) {
      toast({ kind: "error", title: "Invalid JSON", description: (e as Error).message });
    }
  };

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold text-dalam-text-primary">MCP Servers</h1>
        {view === "list" ? (
          <button onClick={() => setView("add")} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add server
          </button>
        ) : (
          <button onClick={() => { reset(); setView("list"); }} className="flex items-center gap-1 text-sm text-dalam-text-secondary hover:text-dalam-text-primary">
            <ChevronLeft className="w-3.5 h-3.5" /> Back to MCP list
          </button>
        )}
      </div>

      {view === "list" ? (
        <>
          <p className="text-sm text-dalam-text-muted mb-6">Connect MCP servers to extend the agent with new tools. Use the toggle to connect / disconnect.</p>
          <div className="space-y-1">
            {mcpServers.length === 0 && (
              <div className="text-center text-sm text-dalam-text-muted py-8">No MCP servers configured.</div>
            )}
            {mcpServers.map((m) => (
              <div key={m.name} className="group flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dalam-bg-hover transition-colors">
                <div className="flex-shrink-0 w-8 h-8 rounded-md bg-dalam-bg-tertiary flex items-center justify-center">
                  <Plug className="w-3.5 h-3.5 text-dalam-text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-dalam-text-primary font-medium">{m.name}</div>
                  <div className="text-xs text-dalam-text-muted truncate">
                    {m.transport === "http" ? (m.url ?? "—") : `${m.command ?? "—"} ${(m.args ?? []).join(" ")}`.trim()}
                    {m.tools && ` · ${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}`}
                  </div>
                </div>
                <span className={`chip flex-shrink-0 ${m.status === "connected" ? "text-dalam-git-added" : m.status === "error" ? "text-dalam-git-deleted" : "text-dalam-text-muted"}`}>
                  {m.status}
                </span>
                <button
                  onClick={() => { if (confirm(`Remove MCP server "${m.name}"?`)) removeMcpServer(m.name); }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-dalam-text-muted hover:text-dalam-git-deleted hover:bg-dalam-bg-active transition-all"
                  title="Remove server"
                  aria-label={`Remove ${m.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <Toggle checked={m.enabled} onChange={() => toggleMcp(m.name)} label={`Enable MCP server ${m.name}`} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold text-dalam-text-primary mb-1">New MCP server</h2>
          <p className="text-sm text-dalam-text-muted mb-4">Fill in the new MCP configuration, then save to return to the list.</p>

          <div className="flex items-center gap-1 bg-dalam-bg-tertiary border border-dalam-border-primary rounded-md p-0.5 w-fit mb-5">
            <button onClick={() => setEditMode("form")} className={`px-3 py-1 text-xs rounded transition-colors ${editMode === "form" ? "bg-dalam-bg-active text-dalam-text-primary font-medium" : "text-dalam-text-secondary hover:text-dalam-text-primary"}`}>Form</button>
            <button onClick={() => setEditMode("json")} className={`px-3 py-1 text-xs rounded transition-colors ${editMode === "json" ? "bg-dalam-bg-active text-dalam-text-primary font-medium" : "text-dalam-text-secondary hover:text-dalam-text-primary"}`}>JSON</button>
          </div>

          {editMode === "form" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-dalam-text-primary mb-1.5">Name</label>
                <input className="input-base text-sm w-full" placeholder="my-mcp-server" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm text-dalam-text-primary mb-1.5">Scope</label>
                <div className="relative">
                  <select className="input-base text-sm w-full appearance-none pr-8" value={scope} onChange={(e) => setScope(e.target.value as "user" | "project")}>
                    <option value="user">User</option>
                    <option value="project">Project</option>
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm text-dalam-text-primary mb-1.5">Type</label>
              <div className="relative">
                <select className="input-base text-sm w-full appearance-none pr-8" value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")}>
                  <option value="stdio">stdio (local command)</option>
                  <option value="http">http (remote endpoint)</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-dalam-text-muted pointer-events-none" />
              </div>
            </div>

            {transport === "stdio" ? (
              <>
                <div>
                  <label className="block text-sm text-dalam-text-primary mb-1.5">Command</label>
                  <input className="input-base text-sm w-full" placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm text-dalam-text-primary mb-1.5">Arguments (space separated)</label>
                  <input className="input-base text-sm w-full font-mono" placeholder="-y @modelcontextprotocol/server-memory" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm text-dalam-text-primary mb-1.5">Endpoint URL</label>
                <input className="input-base text-sm w-full" placeholder="https://api.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
            )}

            <div>
              <button onClick={() => setEnvOpen((v) => !v)} className="flex items-center gap-1.5 text-sm text-dalam-text-primary">
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${envOpen ? "" : "-rotate-90"}`} />
                Environment variables <span className="text-dalam-text-muted">(optional)</span>
              </button>
              {envOpen && (
                <div className="mt-2 space-y-1.5">
                  {envEntries.map((e, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input className="input-base text-xs flex-1 font-mono" placeholder="KEY" value={e.key} onChange={(ev) => setEnvEntries((arr) => arr.map((x, j) => j === i ? { ...x, key: ev.target.value } : x))} />
                      <input className="input-base text-xs flex-1 font-mono" placeholder="value" value={e.value} onChange={(ev) => setEnvEntries((arr) => arr.map((x, j) => j === i ? { ...x, value: ev.target.value } : x))} />
                      <button onClick={() => setEnvEntries((arr) => arr.filter((_, j) => j !== i))} className="p-1.5 rounded text-dalam-text-muted hover:text-dalam-git-deleted">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setEnvEntries((arr) => [...arr, { key: "", value: "" }])} className="text-xs text-dalam-text-secondary hover:text-dalam-text-primary">+ Add variable</button>
                </div>
              )}
            </div>
          </div>
          ) : (
            <div>
              <textarea
                className={`input-base w-full h-56 font-mono text-xs ${jsonError ? "border-dalam-git-deleted" : ""}`}
                placeholder={JSON_PLACEHOLDER}
                value={jsonText}
                spellCheck={false}
                onChange={(e) => { setJsonText(e.target.value); validateJson(e.target.value); }}
              />
              {jsonError && (
                <p className="text-xs text-dalam-git-deleted mt-1.5 flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-dalam-git-deleted flex-shrink-0" />
                  {jsonError}
                </p>
              )}
              {jsonText.trim() && !jsonError && (
                <p className="text-xs text-dalam-git-added mt-1.5 flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-dalam-git-added flex-shrink-0" />
                  Valid JSON — ready to add
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-6">
            <button onClick={() => { reset(); setView("list"); }} className="px-3 py-1.5 text-sm rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover transition-colors">Cancel</button>
            {editMode === "form" ? (
              <button onClick={onAdd} className="px-4 py-1.5 text-sm rounded-md bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity font-medium">Add</button>
            ) : (
              <button
                onClick={onAddFromJson}
                disabled={!jsonText.trim() || !!jsonError}
                className="px-4 py-1.5 text-sm rounded-md bg-dalam-text-primary text-dalam-bg-primary hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add from JSON
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---- Memory Graph ----------------------------------------------------------

function MemoryGraphTab() {
  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Memory Graph</h1>
      <p className="text-sm text-dalam-text-muted mb-6">
        Visualize the neural network of memories, agents, skills, and genes.
        Click nodes to inspect their details and connections.
      </p>
      <MemoryGraph />
    </>
  );
}

// ---- Plugins -------------------------------------------------------------

function PluginsTab() {
  const toast = useToasts((s) => s.push);
  const [installed, setInstalled] = useState<{ id: string; name: string; enabled: boolean; version: string; description: string }[]>([]);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const onUninstall = (id: string, name: string) => {
    if (!confirm(`Uninstall "${name}"? You'll need to reinstall it from the marketplace.`)) return;
    setUninstalling(id);
    setTimeout(() => {
      setInstalled((arr) => arr.filter((p) => p.id !== id));
      setUninstalling(null);
      toast({ kind: "success", title: "Plugin uninstalled", description: name });
    }, 300);
  };

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Plugins</h1>
      <p className="text-sm text-dalam-text-muted mb-8">Extend Dalam with community plugins. Plugins run in a sandboxed renderer context.</p>
      <Card title="Installed plugins" description="Toggle each plugin to enable or disable it for the current workspace.">
        <div className="divide-y divide-dalam-border-primary">
          {installed.length === 0 && (
            <div className="text-center text-sm text-dalam-text-muted py-6">No plugins installed.</div>
          )}
          {installed.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-dalam-text-primary font-medium truncate">{p.name}</span>
                  <span className="text-[10px] text-dalam-text-muted">v{p.version}</span>
                </div>
                <div className="text-xs text-dalam-text-muted line-clamp-1">{p.description}</div>
              </div>
              <button
                onClick={() => onUninstall(p.id, p.name)}
                disabled={uninstalling === p.id}
                className="p-1.5 rounded-md text-dalam-text-muted hover:text-dalam-git-deleted hover:bg-dalam-bg-active transition-colors disabled:opacity-50"
                title="Uninstall"
                aria-label={`Uninstall ${p.name}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <Toggle checked={p.enabled} onChange={() => setInstalled((arr) => arr.map((x) => x.id === p.id ? { ...x, enabled: !x.enabled } : x))} label={`Enable plugin ${p.name}`} />
            </div>
          ))}
        </div>
      </Card>
      <Card title="Install from marketplace" description="Browse and install plugins from the Dalam marketplace.">
        <div className="flex items-center gap-2">
          <button className="px-4 py-2 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-sm rounded-md transition-colors"
            onClick={() => toast({ kind: "info", title: "Marketplace coming soon" })}>
            Open marketplace
          </button>
          <button className="px-4 py-2 bg-dalam-bg-tertiary hover:bg-dalam-bg-hover text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors"
            onClick={() => toast({ kind: "info", title: "Install from URL coming soon" })}>
            Install from URL…
          </button>
        </div>
      </Card>
    </>
  );
}

// ---- Commands ------------------------------------------------------------

function CommandsTab() {
  const mod = modKey();
  const [commands, setCommands] = useState<{ id: string; name: string; shortcut: string; description: string }[]>([
    { id: "new-chat", name: "New task", shortcut: `${mod}N`, description: "Start a new chat session" },
    { id: "toggle-sidebar", name: "Toggle sidebar", shortcut: `${mod}B`, description: "Show or hide the sidebar" },
    { id: "open-settings", name: "Open settings", shortcut: `${mod},`, description: "Open the settings panel" },
    { id: "command-palette", name: "Command palette", shortcut: `${mod}K`, description: "Open the command palette" },
    { id: "toggle-panel", name: "Toggle panel", shortcut: `${mod}J`, description: "Show or hide the right panel" },
  ]);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const handler = (e: KeyboardEvent) => {
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push(modKey());
      if (e.altKey) parts.push(platform() === "mac" ? "⌥" : "Alt");
      if (e.shiftKey) parts.push(platform() === "mac" ? "⇧" : "Shift");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(key);
      setCommands((prev) => prev.map((c) => c.id === editing ? { ...c, shortcut: parts.join(platform() === "mac" ? "" : " ") } : c));
      setEditing(null);
      localStorage.setItem("dalam.commands.shortcuts", JSON.stringify(commands.map((c) => ({ id: c.id, shortcut: c.shortcut }))));
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [editing]);

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Commands</h1>
      <p className="text-sm text-dalam-text-muted mb-8">Customize keyboard shortcuts for built-in and plugin commands.</p>
      <Card title="Keyboard shortcuts" description="Click any shortcut to record a new binding.">
        <div className="divide-y divide-dalam-border-primary">
          {commands.length === 0 && (
            <div className="text-center text-sm text-dalam-text-muted py-6">Custom keybindings coming soon.</div>
          )}
          {commands.map((c) => (
            <div key={c.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="text-sm text-dalam-text-primary font-medium">{c.name}</div>
                <div className="text-xs text-dalam-text-muted">{c.description}</div>
              </div>
              <button
                onClick={() => setEditing(c.id)}
                className="px-2.5 py-1 text-xs font-mono rounded-md bg-dalam-bg-tertiary border border-dalam-border-primary hover:bg-dalam-bg-hover transition-colors"
              >
                {editing === c.id ? "Press keys…" : c.shortcut}
              </button>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Custom commands" description="Create your own reusable commands that run agent tasks or scripts.">
        <button className="px-4 py-2 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors">
          + New command
        </button>
      </Card>
    </>
  );
}

// ---- Indexing ------------------------------------------------------------

function IndexingTab() {
  const { settings, update } = useSettings();
  const [indexingEnabled, setIndexingEnabled] = useState(settings.indexingEnabled ?? true);
  const [autoIndex, setAutoIndex] = useState(settings.autoIndex ?? true);
  const [maxFileSize, setMaxFileSize] = useState(settings.maxFileSize ?? 2);
  const [excludedPatterns, setExcludedPatterns] = useState(settings.excludedPatterns ?? "node_modules\n.git\ndist\nbuild\n*.min.js\n.DS_Store");

  const saveIndexing = () => {
    void update("indexingEnabled", indexingEnabled);
    void update("autoIndex", autoIndex);
    void update("maxFileSize", maxFileSize);
    void update("excludedPatterns", excludedPatterns);
  };

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Indexing</h1>
      <p className="text-sm text-dalam-text-muted mb-8">Configure how Dalam indexes your workspace for fast search and code understanding.</p>
      <Card title="Code indexing" description="Build a searchable index of your workspace so the agent can find files and symbols quickly.">
        <div className="flex items-center justify-between">
          <span className="text-sm text-dalam-text-secondary">Enable indexing</span>
          <Toggle checked={indexingEnabled} onChange={() => { const next = !indexingEnabled; setIndexingEnabled(next); void update("indexingEnabled", next); }} label="Enable indexing" />
        </div>
      </Card>
      <Card title="Auto reindex" description="Automatically reindex files when they change.">
        <div className="flex items-center justify-between">
          <span className="text-sm text-dalam-text-secondary">Watch for file changes</span>
          <Toggle checked={autoIndex} onChange={() => { const next = !autoIndex; setAutoIndex(next); void update("autoIndex", next); }} label="Watch for file changes and auto reindex" />
        </div>
      </Card>
      <Card title="Max file size" description="Skip files larger than this size when indexing (in MB).">
        <div className="flex items-center gap-4">
          <input type="range" min={1} max={50} value={maxFileSize} onChange={(e) => setMaxFileSize(Number(e.target.value))} className="flex-1 accent-dalam-accent-primary" />
          <span className="text-sm text-dalam-text-primary w-12 text-right">{maxFileSize} MB</span>
        </div>
      </Card>
      <Card title="Excluded patterns" description="Glob patterns to skip during indexing, one per line.">
        <textarea
          className="input-base w-full font-mono text-xs h-32"
          value={excludedPatterns}
          onChange={(e) => setExcludedPatterns(e.target.value)}
        />
        <button className="mt-3 px-4 py-1.5 bg-dalam-bg-active hover:bg-dalam-bg-tertiary text-sm text-dalam-text-primary rounded-md border border-dalam-border-primary transition-colors" onClick={saveIndexing}>
          Save patterns
        </button>
      </Card>
    </>
  );
}

// ---- Instructions -------------------------------------------------------

type LayerInfo = {
  key: string;
  name: string;
  label: string;
  description: string;
  path: string;
  gitTracked: boolean;
  content: string;
  exists: boolean;
  pathScopedRules: { glob: string; rules: string }[];
};

function InstructionsTab() {
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingLayer, setEditingLayer] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedLayer, setExpandedLayer] = useState<string | null>(null);
  const toast = useToasts((s) => s.push);
  const activeWorkspace = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));

  useEffect(() => {
    if (!activeWorkspace) return;
    const api = createDalamAPI();
    loadInstructions(api, activeWorkspace.path).then(setLayers).finally(() => setLoading(false));
  }, [activeWorkspace?.id]);

  if (!activeWorkspace) {
    return (
      <>
        <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Instructions</h1>
        <p className="text-sm text-dalam-text-muted">Open a workspace to view and edit its instructions.</p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Instructions</h1>
      <p className="text-sm text-dalam-text-muted mb-8">
        View and edit the DALAM.md instruction files that guide the agent.
        Higher layers override lower ones. Use <code className="px-1 py-0.5 rounded bg-dalam-bg-tertiary font-mono text-dalam-text-primary text-xs">@path: glob</code> to scope rules to specific files.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-5 h-5 border-2 border-dalam-accent-primary border-t-transparent rounded-full animate-spin" />
          <span className="ml-3 text-sm text-dalam-text-muted">Loading instructions…</span>
        </div>
      ) : layers.length === 0 ? (
        <Card title="No instruction files found" description="Create an DALAM.md file in your project root to get started.">
          <button
            className="px-4 py-2 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-sm rounded-lg transition-colors"
            onClick={async () => {
              try {
                const api = createDalamAPI();
                const dalamDir = joinPath(activeWorkspace.path, ".dalam");
                const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
                if (!(await exists(dalamDir))) await mkdir(dalamDir);
                const projectPath = joinPath(activeWorkspace.path, "DALAM.md");
                await api.fs.writeFile(projectPath, `# Project Instructions\n\nRules and conventions for this project.\n\n## Guidelines\n- Use TypeScript for all new files\n- Run typecheck before committing\n\n## Path-scoped rules\n\n@path: src/components/**/*.tsx\n- Use functional components with hooks\n- Name files PascalCase\n\n@path: **/*.test.ts\n- Always use vitest\n- Mock external dependencies\n\n@path: **/*.md\n- Use clear, concise language\n- Include code examples where helpful\n`);
                toast({ kind: "success", title: "DALAM.md created" });
                window.location.reload();
              } catch (err) {
                toast({ kind: "error", title: "Failed to create DALAM.md", description: String(err) });
              }
            }}
          >
            Create DALAM.md
          </button>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* Priority legend */}
          <div className="flex items-center gap-4 text-xs text-dalam-text-muted mb-4">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-dalam-git-added" /> Active</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-dalam-text-muted" /> Empty</span>
            <span className="text-dalam-text-muted/60">Higher layers override lower ones (Local &gt; Project &gt; Org &gt; Global)</span>
          </div>

          {layers.map((layer) => (
            <div key={layer.key} className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-dalam-bg-hover transition-colors text-left"
                onClick={() => setExpandedLayer(expandedLayer === layer.key ? null : layer.key)}
              >
                <div className="flex items-center gap-3">
                  {layer.exists ? (
                    <CheckCircle2 className="w-4 h-4 text-dalam-git-added flex-shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border-2 border-dalam-border-secondary flex-shrink-0" />
                  )}
                  <div>
                    <div className="text-sm font-medium text-dalam-text-primary">{layer.label}</div>
                    <div className="text-xs text-dalam-text-muted">{layer.description}</div>
                  </div>
                  {!layer.gitTracked && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded bg-dalam-bg-tertiary text-dalam-text-muted border border-dalam-border-secondary">not tracked</span>
                  )}
                  {layer.pathScopedRules.length > 0 && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded bg-dalam-accent-subtle text-dalam-accent-primary">{layer.pathScopedRules.length} path rules</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-dalam-text-muted font-mono truncate max-w-[280px]">{layer.path}</span>
                  <ChevronDown className={`w-4 h-4 text-dalam-text-muted transition-transform ${expandedLayer === layer.key ? "rotate-180" : ""}`} />
                </div>
              </button>

              {expandedLayer === layer.key && (
                <div className="border-t border-dalam-border-primary">
                  {/* Path-scoped rules summary */}
                  {layer.pathScopedRules.length > 0 && (
                    <div className="px-5 py-3 bg-dalam-bg-tertiary/50">
                      <div className="text-[10px] uppercase tracking-wider text-dalam-text-muted mb-2">Path-scoped rules</div>
                      <div className="flex flex-wrap gap-2">
                        {layer.pathScopedRules.map((rule) => (
                          <span
                            key={rule.glob}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-dalam-bg-secondary border border-dalam-border-primary text-xs"
                          >
                            <span className="font-mono text-dalam-accent-primary">@path:</span>
                            <span className="font-mono text-dalam-text-primary">{rule.glob}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Content / editor */}
                  <div className="p-5">
                    {editingLayer === layer.key ? (
                      <>
                        <textarea
                          className="input-base w-full font-mono text-xs leading-relaxed min-h-[240px] bg-dalam-bg-primary border-dalam-border-primary"
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          spellCheck={false}
                        />
                        <div className="flex items-center justify-between mt-3">
                          <span className="text-[10px] text-dalam-text-muted">
                            {editContent.split("\n").length} lines · {layer.gitTracked ? "Tracked in git" : "Not tracked"}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setEditingLayer(null)}
                              className="px-3 py-1.5 text-xs text-dalam-text-secondary hover:bg-dalam-bg-hover rounded-md transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={async () => {
                                setSaving(true);
                                try {
                                  const api = createDalamAPI();
                                  await api.fs.writeFile(layer.path, editContent);
                                  toast({ kind: "success", title: `${layer.label} saved` });
                                  setEditingLayer(null);
                                  const updated = await loadInstructions(api, activeWorkspace.path);
                                  setLayers(updated);
                                } catch (err) {
                                  toast({ kind: "error", title: "Save failed", description: String(err) });
                                } finally {
                                  setSaving(false);
                                }
                              }}
                              disabled={saving}
                              className="px-3 py-1.5 text-xs bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white rounded-md transition-colors disabled:opacity-50"
                            >
                              {saving ? "Saving…" : "Save"}
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {layer.exists ? (
                          <>
                            <pre className="text-xs font-mono leading-relaxed text-dalam-text-secondary whitespace-pre-wrap max-h-[200px] overflow-y-auto bg-dalam-bg-primary rounded-lg p-4 border border-dalam-border-primary">
                              {layer.content || "(empty)"}
                            </pre>
                            <button
                              onClick={() => { setEditingLayer(layer.key); setEditContent(layer.content); }}
                              className="mt-3 px-3 py-1.5 text-xs text-dalam-accent-primary hover:bg-dalam-accent-subtle rounded-md transition-colors"
                            >
                              Edit
                            </button>
                          </>
                        ) : (
                          <div className="text-center py-6">
                            <p className="text-sm text-dalam-text-muted mb-3">No instruction file at this layer.</p>
                            <button
                              onClick={async () => {
                                try {
                                  const api = createDalamAPI();
                                  const dir = layer.path.substring(0, layer.path.lastIndexOf("/"));
                                  const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
                                  if (!(await exists(dir))) await mkdir(dir);
                                  await api.fs.writeFile(layer.path, `# ${layer.label} Instructions\n\nRules for this layer.\n`);
                                  toast({ kind: "success", title: `${layer.label} DALAM.md created` });
                                  const updated = await loadInstructions(api, activeWorkspace.path);
                                  setLayers(updated);
                                } catch (err) {
                                  toast({ kind: "error", title: "Failed to create file", description: String(err) });
                                }
                              }}
                              className="px-3 py-1.5 text-xs bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white rounded-md transition-colors"
                            >
                              Create {layer.label} DALAM.md
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Quick reference card */}
          <Card title="Syntax reference" description="How to structure your DALAM.md files.">
            <pre className="text-xs font-mono text-dalam-text-secondary whitespace-pre-wrap leading-relaxed">{`# Global rules (apply to all files)
- Use TypeScript for all new files
- Follow the Airbnb style guide

@path: src/components/**/*.tsx
- Use functional components with hooks
- Always destructure props

@path: **/*.test.ts
- Use vitest for testing
- Mock all external API calls

@path: **/*.md
- Use clear, concise language
- Include code examples`}</pre>
          </Card>
        </div>
      )}
    </>
  );
}

async function loadInstructions(api: ReturnType<typeof createDalamAPI>, workspacePath: string): Promise<LayerInfo[]> {
  const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
  const { homeDir: getHomeDir } = await import("@tauri-apps/api/path");
  const homeDir = await getHomeDir().catch(() => "");

  const layerDefs = [
    { key: "global", label: "Global", description: "Applies to all projects", gitTracked: false, pathFn: () => joinPath(homeDir, ".dalam", "DALAM.md") },
    { key: "org", label: "Organization", description: "Shared across team workspaces", gitTracked: true, pathFn: () => joinPath(workspacePath, ".dalam", "org", "DALAM.md") },
    { key: "project", label: "Project", description: "Project root, checked into git", gitTracked: true, pathFn: () => joinPath(workspacePath, "DALAM.md") },
    { key: "local", label: "Local", description: "Personal overrides, gitignored", gitTracked: false, pathFn: () => joinPath(workspacePath, ".dalam", "local", "DALAM.md") },
  ];

  const results: LayerInfo[] = [];
  for (const def of layerDefs) {
    const path = def.pathFn();
    let content = "";
    let fileExists = false;
    try {
      fileExists = await exists(path);
      if (fileExists) content = await readTextFile(path);
    } catch { /* file doesn't exist */ }

    const pathScopedRules: { glob: string; rules: string }[] = [];
    if (content) {
      const lines = content.split(/\r?\n/);
      let currentGlob: string | null = null;
      let currentBlock: string[] = [];
      const flush = () => {
        if (currentGlob && currentBlock.length > 0) {
          pathScopedRules.push({ glob: currentGlob, rules: currentBlock.join("\n").trim() });
        }
        currentBlock = [];
      };
      for (const line of lines) {
        const match = line.match(/^@path:\s+(.+?)\s*$/);
        if (match) {
          flush();
          currentGlob = match[1];
          continue;
        }
        if (currentGlob) currentBlock.push(line);
      }
      flush();
    }

    results.push({
      key: def.key,
      name: def.key,
      label: def.label,
      description: def.description,
      path,
      gitTracked: def.gitTracked,
      content,
      exists: fileExists,
      pathScopedRules,
    });
  }
  return results;
}

// ---- Onboard -------------------------------------------------------------

function OnboardTab() {
  const [step, setStep] = useState(0);
  const mod = modKey();
  const steps = [
    { title: "Welcome to Dalam", body: "An AI-native IDE that reads, writes, and runs code alongside you. Built on the same foundation as Cursor and Windsurf." },
    { title: "Powered by your favorite models", body: "Switch between Claude, Gemini, or any model provider. Configure in Settings → Models." },
    { title: "Keyboard-first", body: `Press ${mod}K to open the command palette. ${mod}P to quick-open files. ? anywhere for the full cheatsheet.` },
    { title: "The agent works for you", body: "Ask the agent to refactor, test, or document code. Every edit goes through a diff viewer for your explicit approval." },
  ];
  const current = steps[step];

  return (
    <>
      <h1 className="text-3xl font-bold text-dalam-text-primary mb-2">Onboard</h1>
      <p className="text-sm text-dalam-text-muted mb-8">Replay the onboarding tour or jump to any step.</p>
      <Card title={`Step ${step + 1} of ${steps.length}: ${current.title}`} description={current.body}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {steps.map((_, i) => (
              <div key={i} className={`h-1 rounded-full transition-all ${i === step ? "w-6 bg-dalam-accent-primary" : "w-1.5 bg-dalam-bg-tertiary"}`} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} className="px-3 py-1.5 text-sm rounded-md text-dalam-text-secondary hover:bg-dalam-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              Back
            </button>
            <button onClick={() => setStep(Math.min(steps.length - 1, step + 1))} disabled={step === steps.length - 1} className="px-3 py-1.5 text-sm rounded-md bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              Next
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label || "Toggle setting"}
      className={`relative inline-flex h-6 w-11 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-dalam-accent-primary" : "bg-dalam-bg-active"}`}
      onClick={onChange}
    >
      <span className={`absolute top-0.5 inline-block h-5 w-5 rounded-full bg-white transition-transform shadow ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}
