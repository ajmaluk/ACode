import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ensureAcodeAPI } from "./lib/acodeAPI";
import "./index.css";

// Initialize the API bridge (real in Electron, mock in browser)
try {
  ensureAcodeAPI();
} catch (err) {
  console.error("Failed to initialize ACode API:", err);
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  console.error("Root element not found — app cannot mount");
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
