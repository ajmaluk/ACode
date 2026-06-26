import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { createDalamAPI } from "./lib/dalamAPI";
import { registerHookListeners } from "./lib/hookListeners";
import "./index.css";

try {
  createDalamAPI();
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
