import { create } from "zustand";
import { useEffect } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "warning" | "error";

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number;
};

type ToastState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = "t-" + Math.random().toString(36).slice(2, 9);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    const duration = t.durationMs ?? 3500;
    if (duration > 0) {
      // Track the timer so dismiss() can cancel it — otherwise a toast
      // that the user closes early still fires its setTimeout, which is
      // a small leak in long-lived sessions.
      const timer = setTimeout(() => get().dismiss(id), duration);
      timerRegistry.set(id, timer);
    }
    return id;
  },
  dismiss(id) {
    const timer = timerRegistry.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRegistry.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Module-scoped timer registry so dismiss can cancel a pending auto-dismiss.
const timerRegistry = new Map<string, ReturnType<typeof setTimeout>>();

const KIND_STYLES: Record<ToastKind, { ring: string; text: string; icon: React.ReactNode; bar: string }> = {
  success: {
    ring: "border-l-acode-git-added",
    text: "text-acode-git-added",
    bar: "bg-acode-git-added",
    icon: <CheckCircle2 className="w-4 h-4" />,
  },
  error: {
    ring: "border-l-acode-git-deleted",
    text: "text-acode-git-deleted",
    bar: "bg-acode-git-deleted",
    icon: <XCircle className="w-4 h-4" />,
  },
  warning: {
    ring: "border-l-acode-git-modified",
    text: "text-acode-git-modified",
    bar: "bg-acode-git-modified",
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  info: {
    ring: "border-l-acode-accent-primary",
    text: "text-acode-accent-primary",
    bar: "bg-acode-accent-primary",
    icon: <Info className="w-4 h-4" />,
  },
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const style = KIND_STYLES[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto w-80 surface border-l-4 ${style.ring} shadow-2xl animate-slide-up`}
          >
            <div className="flex items-start gap-2 p-3">
              <span className={style.text}>{style.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-acode-text-primary">
                  {t.title}
                </div>
                {t.description && (
                  <div className="text-xs text-acode-text-muted mt-0.5">
                    {t.description}
                  </div>
                )}
              </div>
              <button className="btn-icon" onClick={() => dismiss(t.id)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className={`h-0.5 ${style.bar} animate-progress`} style={{ animationDuration: `${t.durationMs ?? 3500}ms` }} />
          </div>
        );
      })}
    </div>
  );
}

export function useToast() {
  const push = useToasts((s) => s.push);
  return {
    info: (title: string, description?: string) => push({ kind: "info", title, description }),
    success: (title: string, description?: string) => push({ kind: "success", title, description }),
    warning: (title: string, description?: string) => push({ kind: "warning", title, description }),
    error: (title: string, description?: string) => push({ kind: "error", title, description }),
  };
}

// Add to globals via a small util — keeps the keyframes in sync
export function useProgressKeyframes() {
  useEffect(() => {
    const id = "acode-progress-keyframes";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      @keyframes acode-progress {
        from { transform: scaleX(1); }
        to { transform: scaleX(0); }
      }
      .animate-progress {
        transform-origin: left;
        animation-name: acode-progress;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
    `;
    document.head.appendChild(style);
  }, []);
}
