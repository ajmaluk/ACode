import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ensureDalamAPI } from "./lib/dalamAPI";
import { registerHookListeners } from "./lib/hookListeners";
import "./index.css";

// Initialize the API bridge (real in Electron, mock in browser)
try {
  ensureDalamAPI();
} catch (err) {
  console.error("Failed to initialize Dalam API:", err);
}

// Register hook listeners for tool usage logging, session auto-save, etc.
registerHookListeners();

const rootEl = document.getElementById("root");
if (!rootEl) {
  console.error("Root element not found — app cannot mount");
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}
