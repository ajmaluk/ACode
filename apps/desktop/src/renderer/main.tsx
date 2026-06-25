import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ensureAcodeAPI } from "./lib/acodeAPI";
import { registerHookListeners } from "./lib/hookListeners";
import "./index.css";

// Initialize the API bridge (real in Electron, mock in browser)
try {
  ensureAcodeAPI();
} catch (err) {
  console.error("Failed to initialize ACode API:", err);
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
