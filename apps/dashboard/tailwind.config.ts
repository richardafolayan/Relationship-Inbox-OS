import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        bg: "#f7f8fb",
        surface: "#ffffff",
        border: "#e2e8f0",
        accent: "#2563eb",
        accentSoft: "#eff6ff",
        successSoft: "#ecfdf3",
        warningSoft: "#fffbeb",
        dangerSoft: "#fff1f2"
      },
      borderRadius: {
        xl2: "1rem",
        xl3: "1.25rem"
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15,23,42,0.06), 0 6px 16px rgba(15,23,42,0.05)"
      },
      transitionDuration: {
        calm: "180ms"
      }
    }
  },
  plugins: []
};

export default config;
