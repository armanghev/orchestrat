import { z } from "zod";
import { themeSchema } from "@/features/theme/theme";

export const railModeSchema = z.enum(["projects", "organizations", "product"]);
export const organizationProjectsSortSchema = z.enum(["recent", "name"]);
export const organizationProjectsFilterSchema = z.enum(["active", "archived"]);
export type OrganizationProjectsSort = z.infer<
  typeof organizationProjectsSortSchema
>;
export type OrganizationProjectsFilter = z.infer<
  typeof organizationProjectsFilterSchema
>;
export const organizationProjectsViewSchema = z.object({
  sort: organizationProjectsSortSchema,
  filter: organizationProjectsFilterSchema
});
export type OrganizationProjectsView = z.infer<
  typeof organizationProjectsViewSchema
>;

export const preferencesSchema = z.object({
  theme: themeSchema,
  railMode: railModeSchema,
  pinnedProjectIds: z.array(z.string()).max(24),
  recentProjectIds: z.array(z.string()).max(24),
  contextSidebarCollapsed: z.boolean(),
  // Per-organization project grid view (ORC-51). Missing/corrupt → {}.
  organizationProjectsViews: z
    .record(z.string(), organizationProjectsViewSchema)
    .default({})
    .catch({})
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultOrganizationProjectsView: OrganizationProjectsView =
  Object.freeze({
    sort: "recent",
    filter: "active"
  });

export const defaultPreferences: Preferences = Object.freeze({
  theme: "system",
  railMode: "projects",
  pinnedProjectIds: Object.freeze([]) as unknown as string[],
  recentProjectIds: Object.freeze([]) as unknown as string[],
  contextSidebarCollapsed: false,
  organizationProjectsViews: Object.freeze(
    {}
  ) as Preferences["organizationProjectsViews"]
}) as Preferences;

function freshDefaultPreferences(): Preferences {
  return {
    ...defaultPreferences,
    pinnedProjectIds: [],
    recentProjectIds: [],
    organizationProjectsViews: {}
  };
}

const unique = (values: string[]) => [...new Set(values)];

export function parsePreferences(input: unknown): Preferences {
  const parsed = preferencesSchema.safeParse(input);
  return parsed.success ? parsed.data : freshDefaultPreferences();
}

export function cleanPreferences(
  input: unknown,
  accessibleProjectIds: ReadonlySet<string>
): Preferences {
  const parsed = parsePreferences(input);
  const pinnedProjectIds = unique(parsed.pinnedProjectIds).filter((id) =>
    accessibleProjectIds.has(id)
  );
  const pinned = new Set(pinnedProjectIds);
  return {
    ...parsed,
    pinnedProjectIds,
    recentProjectIds: unique(parsed.recentProjectIds).filter(
      (id) => accessibleProjectIds.has(id) && !pinned.has(id)
    ),
    organizationProjectsViews: { ...parsed.organizationProjectsViews }
  };
}

export function organizationProjectsView(
  preferences: Preferences,
  organizationId: string
): OrganizationProjectsView {
  return (
    preferences.organizationProjectsViews[organizationId] ??
    defaultOrganizationProjectsView
  );
}
