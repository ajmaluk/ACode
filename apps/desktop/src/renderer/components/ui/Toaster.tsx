import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";
import type { ToastKind } from "./toastTypes";
import { useToasts } from "./toastStore";

const KIND_STYLES: Record<ToastKind, { ring: string; text: string; icon: React.ReactNode; bar: string }> = {
  success: {
    ring: "border-l-dalam-git-added",
    text: "text-dalam-git-added",
    bar: "bg-dalam-git-added",
    icon: <CheckCircle2 className="w-4 h-4" />,
  },
  error: {
    ring: "border-l-dalam-git-deleted",
    text: "text-dalam-git-deleted",
    bar: "bg-dalam-git-deleted",
    icon: <XCircle className="w-4 h-4" />,
  },
  warning: {
    ring: "border-l-dalam-git-modified",
    text: "text-dalam-git-modified",
    bar: "bg-dalam-git-modified",
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  info: {
    ring: "border-l-dalam-accent-primary",
    text: "text-dalam-accent-primary",
    bar: "bg-dalam-accent-primary",
    icon: <Info className="w-4 h-4" />,
  },
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 pointer-events-none" aria-live="polite">
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
                <div className="text-sm font-medium text-dalam-text-primary">
                  {t.title}
                </div>
                {t.description && (
                  <div className="text-xs text-dalam-text-muted mt-0.5">
                    {t.description}
                  </div>
                )}
                {t.actions && t.actions.length > 0 && (
                  <div className="flex gap-1.5 mt-2.5">
                    {t.actions.map((act) => (
                      <button
                        key={act.label}
                        className={`px-2 py-0.5 rounded text-xs font-semibold select-none cursor-pointer transition-colors ${
                          act.variant === "primary"
                            ? "bg-dalam-accent-primary text-white hover:bg-opacity-90"
                            : act.variant === "danger"
                            ? "bg-dalam-git-deleted text-white hover:bg-opacity-90"
                            : "bg-dalam-bg-hover text-dalam-text-primary hover:bg-opacity-80"
                        }`}
                        onClick={() => {
                          try { act.onClick(); } catch { /* swallow */ }
                          dismiss(t.id);
                        }}
                      >
                        {act.label}
                      </button>
                    ))}
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

