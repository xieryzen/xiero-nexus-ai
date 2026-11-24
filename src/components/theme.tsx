"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { cn } from "@/components/ui";

/**
 * Light, dark, or as the device is. What the reader chose is kept in this
 * browser (the script in layout.tsx reads it before the first paint); "as
 * the device" keeps nothing and follows the device when it changes.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "nexus-theme";
const CANVAS: Record<"light" | "dark", string> = { light: "#faf9f5", dark: "#262624" };

function devicePrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readTheme(): Theme {
  try {
    const kept = window.localStorage.getItem(KEY);
    return kept === "light" || kept === "dark" ? kept : "system";
  } catch {
    return "system";
  }
}

function show(theme: Theme): void {
  const shown = theme === "system" ? (devicePrefersDark() ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", shown);
  // The bar a phone's browser draws around the page takes the page's colour.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", CANVAS[shown]);
}

export function applyTheme(theme: Theme): void {
  try {
    if (theme === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // A browser that keeps nothing: the theme holds until the page is left.
  }
  show(theme);
  window.dispatchEvent(new Event("nexus:theme"));
}

/** The theme as it is chosen now, following a change made anywhere on the page or by the device. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    sync();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onDevice = () => {
      if (readTheme() === "system") show("system");
    };
    window.addEventListener("nexus:theme", sync);
    window.addEventListener("storage", sync);
    media.addEventListener("change", onDevice);
    return () => {
      window.removeEventListener("nexus:theme", sync);
      window.removeEventListener("storage", sync);
      media.removeEventListener("change", onDevice);
    };
  }, []);
  return theme;
}

const CHOICES: { value: Theme; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "device" },
];

/** What a page looks like in a theme, drawn small: a card with two lines and the clay dot. */
function Preview({ value }: { value: Theme }) {
  const light = { card: "#ffffff", page: "#f0eee6", line: "#8a8880" };
  const dark = { card: "#2a2a28", page: "#151515", line: "#8f8d86" };
  const face = (c: typeof light, clip?: string) => (
    <span className="absolute inset-0 flex items-center justify-center" style={{ background: c.page, clipPath: clip }}>
      <span className="relative block h-[64%] w-[78%] rounded-lg" style={{ background: c.card }}>
        <span className="absolute left-[12%] top-[22%] block h-[5px] w-[42%] rounded-full" style={{ background: c.line }} />
        <span className="absolute left-[12%] top-[44%] block h-[5px] w-[28%] rounded-full opacity-70" style={{ background: c.line }} />
        <span className="absolute bottom-[14%] right-[10%] block h-2.5 w-2.5 rounded-full" style={{ background: "#d97757" }} />
      </span>
    </span>
  );
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-xl" aria-hidden="true">
      {value === "light" && face(light)}
      {value === "dark" && face(dark)}
      {value === "system" && (
        <>
          {face(light)}
          {face(dark, "polygon(100% 0, 100% 100%, 0 100%)")}
        </>
      )}
    </span>
  );
}

/**
 * Light, dark, or as the device is set. On the Settings page: three small
 * pictures of a page, the chosen one framed. `compact`: three icons in a row,
 * for a menu.
 */
export function ThemeChoice({ compact = false, className }: { compact?: boolean; className?: string }) {
  const theme = useTheme();
  if (!compact) {
    return (
      <div role="radiogroup" aria-label="Theme" className={cn("grid grid-cols-3 gap-3", className)} data-testid="theme-choice">
        {CHOICES.map((choice) => {
          const on = theme === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={on}
              title={choice.value === "system" ? "As the device is set" : choice.label}
              onClick={() => applyTheme(choice.value)}
              className="group flex flex-col items-center gap-2 text-center"
            >
              <span className={cn("block w-full rounded-[14px] border-2 p-0.5 transition", on ? "border-accent" : "border-transparent group-hover:border-line-strong")}>
                <Preview value={choice.value} />
              </span>
              <span className={cn("text-sm", on ? "font-medium text-accent-ink" : "text-ink-2")}>{choice.label}</span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex rounded-full bg-ink/[0.07] p-0.5", className)} data-testid="theme-choice">
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={theme === choice.value}
          aria-label={choice.label}
          title={choice.value === "system" ? "As the device is set" : choice.label}
          onClick={() => applyTheme(choice.value)}
          className={cn("inline-flex h-8 w-10 items-center justify-center rounded-full transition", theme === choice.value ? "bg-surface text-ink shadow-panel" : "text-ink-3 hover:text-ink")}
        >
          <Icon name={choice.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
