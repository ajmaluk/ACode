import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["warn", { disallowTypeAnnotations: false }],
      "prefer-const": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-undef": "off",
    },
  }
);
