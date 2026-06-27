/**
 * Toast store and hook — separated from Toaster.tsx to satisfy
 * react-refresh/only-export-components.
 */

import { create } from "zustand";
import { useMemo } from "react";
import type { Toast } from "./toastTypes";

type ToastState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

// Module-scoped timer registry so dismiss can cancel a pending auto-dismiss.
const timerRegistry = new Map<string, ReturnType<typeof setTimeout>>();

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

/**
 * Convenience hook returning shorthand toast methods (info/success/warning/error).
 */
export function useToast() {
  const push = useToasts((s) => s.push);
  return useMemo(() => ({
    info: (title: string, description?: string) => push({ kind: "info", title, description }),
    success: (title: string, description?: string) => push({ kind: "success", title, description }),
    warning: (title: string, description?: string) => push({ kind: "warning", title, description }),
    error: (title: string, description?: string) => push({ kind: "error", title, description }),
  }), [push]);
}
