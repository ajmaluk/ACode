import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { createDalamAPI } from "./lib/dalamAPI";
import { registerHookListeners } from "./lib/hookListeners";
import "./index.css";

// Apply theme immediately to prevent flash of wrong colors
try {
  const stored = localStorage.getItem("dalam.settings.v1");
  if (stored) {
    const s = JSON.parse(stored);
    const theme = s.theme || "dark";
    let effective: "light" | "dark" = theme as "light" | "dark";
    if (theme === "system") {
      effective = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const html = document.documentElement;
    html.setAttribute("data-theme", effective);
    if (effective === "dark") html.classList.add("dark");
    else html.classList.remove("dark");
    html.style.colorScheme = effective;
  }
} catch { /* ignore */ }

try {
  createDalamAPI();
} catch (err) {
  if (import.meta.env.DEV) console.error("Failed to initialize Dalam API:", err);
}

// Register hook listeners for tool usage logging, session auto-save, etc.
registerHookListeners();

const rootEl = document.getElementById("root");
if (!rootEl) {
  if (import.meta.env.DEV) console.error("Root element not found — app cannot mount");
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}
