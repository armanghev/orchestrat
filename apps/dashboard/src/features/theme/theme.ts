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
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.dataset.theme = resolved;
  storage.setItem(themeMirrorKey, theme);
  return resolved;
}
