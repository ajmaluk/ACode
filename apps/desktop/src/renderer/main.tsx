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
    const theme = s.theme || "system";
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

// Enable debug logging in development only — type __DALAM_DEBUG=true in console
// for verbose logs, or set it here before starting a session to capture all
// API/tool activity. Never force this on in production builds: it leaves a
// window.__DALAM_DEBUG flag flipped on for every user and keeps _debugLog /
// _log call sites in dalamAPI.ts and useAppStore.ts emitting verbose output.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__DALAM_DEBUG = true;
  console.log("[Inspect] Debug logging enabled. Set __DALAM_DEBUG=false to disable.");
}

// Register hook listeners for tool usage logging, session auto-save, etc.
registerHookListeners();

// Global unhandled promise rejection handler — log in DEV, let production handle naturally
window.addEventListener("unhandledrejection", (event) => {
  if (import.meta.env.DEV) {
    console.error("[UnhandledRejection]", event.reason);
  }
  // Do NOT call event.preventDefault() — it suppresses error reporting in Tauri
});

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
