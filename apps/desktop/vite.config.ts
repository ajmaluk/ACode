import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
      "@dalam/shared-types": path.resolve(__dirname, "../../packages/shared-types/src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "out/renderer",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // ── Vendor libraries (node_modules) ──
          if (id.includes('node_modules')) {
            if (id.includes('/react-dom/') || id.includes('/react/')) return 'vendor-react';
            if (id.includes('/@monaco-editor/')) return 'vendor-monaco';
            if (id.includes('/@xterm/')) return 'vendor-xterm';
            if (id.includes('/highlight.js/')) return 'vendor-highlight';
            if (id.includes('/react-markdown/') || id.includes('/remark-gfm/') || id.includes('/rehype-')) return 'vendor-markdown';
            if (id.includes('/lucide-react/')) return 'vendor-icons';
            if (id.includes('/@tauri-apps/')) return 'vendor-tauri';
            if (id.includes('/zustand/') || id.includes('/zod/') || id.includes('/js-tiktoken/')) return 'vendor-state';
          }
          // ── App modules — store+lib are tightly coupled (circular), keep together ──
          if (id.includes('/store/') || id.includes('/lib/')) return 'app-core';
          if (id.includes('/components/chat/') || id.includes('/components/terminal/') || id.includes('/components/rightpanel/')) return 'app-panels';
        },
      },
    },
  },
});
