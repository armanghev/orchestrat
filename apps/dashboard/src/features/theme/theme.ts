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

export function applyTheme(
  theme: Theme,
  systemDark: boolean,
  storage: Pick<Storage, "setItem">
): ResolvedTheme {
  const resolved = resolveTheme(theme, systemDark);
  // Switch every color at once. Otherwise each element with a color
  // transition fades on its own schedule and the page briefly mixes themes.
  const pause = document.createElement("style");
  pause.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(pause);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.dataset.theme = resolved;
  window.getComputedStyle(document.body).getPropertyValue("color");
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()));
  storage.setItem(themeMirrorKey, theme);
  return resolved;
}
