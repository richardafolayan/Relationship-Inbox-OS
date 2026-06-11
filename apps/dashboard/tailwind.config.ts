import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      screens: {
        // Big-screen tier: canvases widen before the zoom layer in
        // globals.css scales the whole UI (≥2200px).
        "3xl": "1700px"
      },
      colors: {
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        "paper-3": "var(--paper-3)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-3": "var(--ink-3)",
        "ink-4": "var(--ink-4)",
        hairline: "var(--hairline)",
        "hairline-strong": "var(--hairline-strong)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-ink": "var(--accent-ink)",
        "risk-overdue": "var(--risk-overdue)",
        "risk-waiting": "var(--risk-waiting)",
        "risk-fresh": "var(--risk-fresh)"
      },
      fontFamily: {
        display: "var(--font-display)",
        text: "var(--font-text)",
        mono: "var(--font-mono)"
      },
      borderRadius: {
        card: "var(--radius-card)",
        row: "var(--radius-row)",
        pill: "var(--radius-pill)"
      },
      boxShadow: {
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)"
      },
      transitionDuration: {
        calm: "180ms"
      }
    }
  },
  plugins: []
};

export default config;
