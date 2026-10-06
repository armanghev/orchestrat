import { z } from "zod";

export const themeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof themeSchema>;
export type ResolvedTheme = Exclude<Theme, "system">;
export const themeMirrorKey = "orchestrat.theme";

export function readTheme(storage: Pick<Storage, "getItem">): Theme {
  const parsed = themeSchema.safeParse(storage.getItem(themeMirrorKey));
  return parsed.success ? parsed.data : "system";
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/**
 * Switches colours at once. Without this every `transition-colors` element
 * fades between themes, which flickers and lets a contrast check catch
 * colours from neither theme.
 */
function withoutTransitions(change: () => void) {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  change();
  // Flush styles so the new colours land before transitions come back.
  void window.getComputedStyle(document.body).color;
  setTimeout(() => style.remove(), 0);
}

export function applyTheme(
  theme: Theme,
  systemDark: boolean,
  storage: Pick<Storage, "setItem">
): ResolvedTheme {
  const resolved = resolveTheme(theme, systemDark);
  const root = document.documentElement;
  if (root.dataset.theme !== resolved)
    withoutTransitions(() => {
      root.classList.toggle("dark", resolved === "dark");
      root.dataset.theme = resolved;
    });
  storage.setItem(themeMirrorKey, theme);
  return resolved;
}
