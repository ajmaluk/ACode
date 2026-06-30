/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        dalam: {
          bg: {
            primary: "rgb(var(--dalam-bg-primary) / <alpha-value>)",
            secondary: "rgb(var(--dalam-bg-secondary) / <alpha-value>)",
            tertiary: "rgb(var(--dalam-bg-tertiary) / <alpha-value>)",
            hover: "rgb(var(--dalam-bg-hover) / <alpha-value>)",
            active: "rgb(var(--dalam-bg-active) / <alpha-value>)",
          },
          border: {
            primary: "rgb(var(--dalam-border-primary) / <alpha-value>)",
            secondary: "rgb(var(--dalam-border-secondary) / <alpha-value>)",
            focus: "rgb(var(--dalam-border-focus) / <alpha-value>)",
          },
          text: {
            primary: "rgb(var(--dalam-text-primary) / <alpha-value>)",
            secondary: "rgb(var(--dalam-text-secondary) / <alpha-value>)",
            muted: "rgb(var(--dalam-text-muted) / <alpha-value>)",
            disabled: "rgb(var(--dalam-text-disabled) / <alpha-value>)",
          },
          accent: {
            primary: "rgb(var(--dalam-accent-primary) / <alpha-value>)",
            hover: "rgb(var(--dalam-accent-hover) / <alpha-value>)",
            subtle: "rgba(79, 142, 247, 0.1)",
          },
          git: {
            modified: "rgb(var(--dalam-git-modified) / <alpha-value>)",
            added: "rgb(var(--dalam-git-added) / <alpha-value>)",
            deleted: "rgb(var(--dalam-git-deleted) / <alpha-value>)",
            untracked: "rgb(var(--dalam-git-untracked) / <alpha-value>)",
          },
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-soft": "pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fade-in 150ms ease-out",
        "slide-up": "slide-up 200ms ease-out",
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
