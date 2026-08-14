import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePreferences } from "@/platform/preferences-provider";
import { applyTheme, resolveTheme, type ResolvedTheme, type Theme } from "./theme";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const query = "(prefers-color-scheme: dark)";

function systemDark() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { preferences, ready, update } = usePreferences();
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(preferences.theme, systemDark()));
  const applied = useRef<string | null>(null);
  const selectedTheme = useRef(preferences.theme);
  const apply = useCallback((theme: Theme, dark: boolean) => {
    const key = `${theme}:${dark}`;
    const resolved = resolveTheme(theme, dark);
    if (applied.current !== key) {
      applyTheme(theme, dark, window.localStorage);
      applied.current = key;
    }
    setResolvedTheme(resolved);
  }, []);

  useEffect(() => {
    selectedTheme.current = preferences.theme;
  }, [preferences.theme]);

  useEffect(() => {
    if (!ready) return;
    const dark = systemDark();
    apply(preferences.theme, dark);
    if (preferences.theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => apply("system", event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [apply, preferences.theme, ready]);

  const setTheme = useCallback((theme: Theme) => {
    if (selectedTheme.current === theme) return;
    selectedTheme.current = theme;
    apply(theme, systemDark());
    void update({ theme });
  }, [apply, update]);

  return <ThemeContext.Provider value={{ theme: preferences.theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider.");
  return value;
}
