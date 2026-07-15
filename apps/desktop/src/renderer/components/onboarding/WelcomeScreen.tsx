import { useState, useEffect } from "react";
import { useWorkspace, useSettings, useSkillsMcp } from "@/store/useAppStore";
import { useToasts } from "@/components/ui/toastStore";
import {
  Sparkles,
  FolderOpen,
  Zap,
  Code2,
  Brain,
  ArrowRight,
  X,
} from "lucide-react";
import { modKey } from "@/lib/platform";

function getSteps() {
  const mod = modKey();
  return [
    {
      icon: Sparkles,
      title: "Welcome to Dalam",
      body: "An AI-native IDE that reads, writes, and runs code alongside you. Built on the same foundation as Cursor and Windsurf.",
      cta: "Get started",
    },
    {
      icon: Brain,
      title: "Powered by your favorite models",
      body: "Add a model provider in Settings → Models to start chatting. Supports any OpenAI-compatible API.",
      cta: "Configure later",
    },
    {
      icon: Code2,
      title: "A keyboard-first experience",
      body: `Press ${mod}K to open the command palette. Use ${mod}P to quick-open files. Press ? anywhere for the full cheatsheet.`,
      cta: "Got it",
    },
    {
      icon: Zap,
      title: "The agent works for you",
      body: "Ask the agent to refactor, test, or document code. Every edit goes through a diff viewer for your explicit approval before touching disk.",
      cta: "Show me",
    },
  ];
}

const STORAGE_KEY = "dalam.onboarding.done.v1";

export function WelcomeScreen() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const { loadWorkspace } = useWorkspace();
  const { settings } = useSettings();
  const { skills, mcpServers } = useSkillsMcp();
  const toast = useToasts((s) => s.push);
  const steps = getSteps();

  useEffect(() => {
    const done = window.localStorage.getItem(STORAGE_KEY);
    if (!done) {
      const t = setTimeout(() => setVisible(true), 600);
      return () => clearTimeout(t);
    }
  }, []);

  const close = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch (err) {
      console.warn("[WelcomeScreen] Failed to persist dismissal:", err);
    }
    setVisible(false);
  };

  const next = async () => {
    if (step < steps.length - 1) {
      setStep((s) => s + 1);
    } else {
      await loadWorkspace();
      toast({
        kind: "success",
        title: "Workspace ready",
        description: "Workspace loaded — explore away.",
      });
      close();
    }
  };

  if (!visible) return null;
  const current = steps[step];
  const Icon = current.icon;
  const isLast = step === steps.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
    >
      <div className="w-[640px] max-w-[96vw] surface shadow-2xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-dalam-accent-primary via-dalam-accent-hover to-dalam-accent-primary" />
        <div className="p-8">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-dalam-accent-subtle flex items-center justify-center">
                <Icon className="w-6 h-6 text-dalam-accent-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-dalam-text-primary">
                  {current.title}
                </h2>
                <p className="text-sm text-dalam-text-muted mt-1 text-balance">
                  {current.body}
                </p>
              </div>
            </div>
            <button className="btn-icon" onClick={close} title="Skip" aria-label="Close welcome screen">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="bg-dalam-bg-primary border border-dalam-border-primary rounded-lg p-3 my-6">
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat
                label="Skills enabled"
                value={skills.filter((s) => s.enabled).length}
              />
              <Stat
                label="MCP servers"
                value={mcpServers.filter((m) => m.enabled).length}
              />
              <Stat
                label="Default model"
                value={
                  settings.selectedModel
                    ? settings.selectedModel.split("-")[0]
                    : "None"
                }
                small
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {steps.map((_, i) => (
                <div
                  key={i}
                  className={`h-1 rounded-full transition-all ${
                    i === step
                      ? "w-6 bg-dalam-accent-primary"
                      : "w-1.5 bg-dalam-bg-tertiary"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-xs text-dalam-text-muted hover:text-dalam-text-primary"
                onClick={close}
                aria-label="Skip onboarding"
              >
                Skip
              </button>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 bg-dalam-accent-primary hover:bg-dalam-accent-hover text-white text-xs rounded-md transition-colors"
                onClick={next}
                aria-label={isLast ? "Open workspace" : current.cta}
              >
                {isLast ? (
                  <>
                    <FolderOpen className="w-3.5 h-3.5" />
                    Open workspace
                  </>
                ) : (
                  <>
                    {current.cta}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  small,
}: {
  label: string;
  value: string | number;
  small?: boolean;
}) {
  return (
    <div>
      <div
        className={`font-semibold text-dalam-text-primary ${small ? "text-xs" : "text-lg"}`}
      >
        {value}
      </div>
      <div className="text-[10px] text-dalam-text-muted uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}
