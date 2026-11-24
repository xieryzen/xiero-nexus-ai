import type { Config } from "tailwindcss";

/**
 * Xiero Nexus AI: design tokens (v2.0).
 * A calm page to read and write on: warm paper in the light, near-black in
 * the dark. What is pressed is the page's own black or white, what is on or
 * chosen is blue, and the mark and the field in use are clay. A serif for
 * what is read (titles, answers), a sans for the controls, monospace for
 * machine text (ids, model names).
 * The colours are CSS variables (globals.css), so a theme changes them all.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar) / <alpha-value>)",
        bubble: "rgb(var(--bubble) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--surface-3) / <alpha-value>)",
        field: "rgb(var(--field) / <alpha-value>)",
        code: "rgb(var(--code) / <alpha-value>)",
        primary: "rgb(var(--primary) / <alpha-value>)",
        "primary-ink": "rgb(var(--primary-ink) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-ink": "rgb(var(--accent-ink) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        "ink-2": "rgb(var(--ink-2) / <alpha-value>)",
        "ink-3": "rgb(var(--ink-3) / <alpha-value>)",
        signal: "rgb(var(--signal) / <alpha-value>)",
        "signal-ink": "rgb(var(--signal-ink) / <alpha-value>)",
        ok: "rgb(var(--ok) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        DEFAULT: "6px",
        lg: "10px",
        xl: "14px",
        "2xl": "20px",
        "3xl": "28px",
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgb(var(--shadow) / 0.04)",
        pop: "0 4px 6px -2px rgb(var(--shadow) / 0.06), 0 16px 40px -12px rgb(var(--shadow) / 0.28)",
        composer: "0 1px 2px 0 rgb(var(--shadow) / 0.04), 0 8px 28px -14px rgb(var(--shadow) / 0.22)",
      },
      maxWidth: {
        content: "1200px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "sheet-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "drawer-in": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "fade": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "sheet-up": "sheet-up 0.26s cubic-bezier(0.32, 0.72, 0, 1)",
        "drawer-in": "drawer-in 0.24s cubic-bezier(0.32, 0.72, 0, 1)",
        fade: "fade 0.2s ease-out",
        "pulse-soft": "pulse-soft 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
