import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
      "@dalam/shared-types": path.resolve(__dirname, "../../packages/shared-types/src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/renderer/lib/**/*.ts",
        "src/renderer/store/**/*.ts",
      ],
      exclude: [
        "src/renderer/lib/**/*.test.ts",
        "src/renderer/lib/**/*.test.tsx",
        "src/renderer/lib/__tests__/**",
        "src/renderer/store/**/*.test.ts",
        "src/test-setup.ts",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
