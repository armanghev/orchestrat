import { z } from "zod";
import { themeSchema } from "@/features/theme/theme";

export const railModeSchema = z.enum(["projects", "organizations", "product"]);
export const preferencesSchema = z.object({
  theme: themeSchema,
  railMode: railModeSchema,
  pinnedProjectIds: z.array(z.string()).max(24),
  recentProjectIds: z.array(z.string()).max(24),
  contextSidebarCollapsed: z.boolean()
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultPreferences: Preferences = Object.freeze({
  theme: "system",
  railMode: "projects",
  pinnedProjectIds: Object.freeze([]) as unknown as string[],
  recentProjectIds: Object.freeze([]) as unknown as string[],
  contextSidebarCollapsed: false
}) as Preferences;

function freshDefaultPreferences(): Preferences {
  return {
    ...defaultPreferences,
    pinnedProjectIds: [],
    recentProjectIds: []
  };
}

const unique = (values: string[]) => [...new Set(values)];

export function cleanPreferences(
  input: unknown,
  accessibleProjectIds: ReadonlySet<string>
): Preferences {
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) return freshDefaultPreferences();
  const pinnedProjectIds = unique(parsed.data.pinnedProjectIds).filter((id) =>
    accessibleProjectIds.has(id)
  );
  const pinned = new Set(pinnedProjectIds);
  const recentProjectIds = unique(parsed.data.recentProjectIds).filter(
    (id) => accessibleProjectIds.has(id) && !pinned.has(id)
  );
  return { ...parsed.data, pinnedProjectIds, recentProjectIds };
}
