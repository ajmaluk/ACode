/**
 * Toast type definitions — separated from Toaster.tsx to satisfy
 * react-refresh/only-export-components.
 */

export type ToastKind = "info" | "success" | "warning" | "error";

export type ToastAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
};

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number;
  actions?: ToastAction[];
};
