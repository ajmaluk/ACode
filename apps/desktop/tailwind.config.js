/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        acode: {
          bg: {
            primary: "#0d0d0d",
            secondary: "#1a1a1a",
            tertiary: "#252525",
            hover: "#2a2a2a",
            active: "#333333",
          },
          border: {
            primary: "#333333",
            secondary: "#404040",
            focus: "#4f8ef7",
          },
          text: {
            primary: "#e0e0e0",
            secondary: "#a0a0a0",
            muted: "#666666",
            disabled: "#444444",
          },
          accent: {
            primary: "#4f8ef7",
            hover: "#3a7de4",
            subtle: "rgba(79, 142, 247, 0.1)",
          },
          git: {
            modified: "#e2c08d",
            added: "#73c991",
            deleted: "#f44336",
            untracked: "#73c991",
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
