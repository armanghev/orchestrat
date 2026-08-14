export type ProjectOrderInput = {
  pinnedProjectIds: string[];
  recentProjectIds: string[];
  selectedProjectId?: string;
};

export type ProjectOrder = {
  visible: string[];
  remaining: string[];
  pinnedProjectIds: string[];
  recentProjectIds: string[];
};

function cleanIds(ids: string[], accessible: Set<string>, excluded = new Set<string>()) {
  const seen = new Set<string>();
  return ids.filter(
    (id) =>
      accessible.has(id) && !excluded.has(id) && !seen.has(id) && (seen.add(id), true)
  );
}

export function orderProjects(
  accessibleProjectIds: string[],
  input: ProjectOrderInput
): ProjectOrder {
  const accessibleIds = [...new Set(accessibleProjectIds)];
  const accessible = new Set(accessibleIds);
  const pinnedProjectIds = cleanIds(input.pinnedProjectIds, accessible).slice(0, 8);
  const pinned = new Set(pinnedProjectIds);
  let recentProjectIds = cleanIds(input.recentProjectIds, accessible, pinned).slice(0, 12);

  if (input.selectedProjectId && accessible.has(input.selectedProjectId) && !pinned.has(input.selectedProjectId)) {
    recentProjectIds = [
      input.selectedProjectId,
      ...recentProjectIds.filter((id) => id !== input.selectedProjectId)
    ].slice(0, 12);
  }

  const promoted = new Set([...pinnedProjectIds, ...recentProjectIds]);
  return {
    visible: [...pinnedProjectIds, ...recentProjectIds].slice(0, 10),
    remaining: accessibleIds.filter((id) => !promoted.has(id)),
    pinnedProjectIds,
    recentProjectIds
  };
}
