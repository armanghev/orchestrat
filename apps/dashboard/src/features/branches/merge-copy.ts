import type {
  Branch,
  MergeCounts,
  MergeItemReason,
  MergeItemType
} from "@orchestrat/protocol";

// Plain-language copy for previews, runs and the branches table.

const nouns: Record<MergeItemType, [string, string]> = {
  task: ["task", "tasks"],
  document: ["document", "documents"],
  chat: ["conversation", "conversations"]
};
const itemTypes = ["task", "document", "chat"] as const;

export const plural = (count: number, type: MergeItemType) =>
  `${count} ${nouns[type][count === 1 ? 0 : 1]}`;

export const itemReasons: Record<MergeItemReason, string> = {
  changed_on_both: "Changed on both branches",
  added_on_both: "Added on both branches",
  path_collision: "Another document already uses this path",
  target_claimed: "An agent is working on it",
  audience_would_widen: "More people would see this conversation",
  dependency_cycle: "It would create a dependency cycle",
  too_large: "Too large to copy"
};

/** "3 tasks added", "1 document updated"… from a preview's or run's counts. */
export function countLines(counts: MergeCounts) {
  const lines: string[] = [];
  for (const type of itemTypes) {
    const added = counts[`${type}.copy`] ?? 0;
    const updated = counts[`${type}.apply`] ?? 0;
    if (added) lines.push(`${plural(added, type)} added`);
    if (updated) lines.push(`${plural(updated, type)} updated`);
  }
  return lines;
}

export const outcomeCount = (counts: MergeCounts, outcome: string) =>
  itemTypes.reduce(
    (total, type) => total + (counts[`${type}.${outcome}`] ?? 0),
    0
  );

const providerNames = {
  github: "GitHub",
  gitlab: "GitLab",
  origin: "Cursor Origin"
} as const;

export const providerName = (provider: keyof typeof providerNames) =>
  providerNames[provider];

/** Where a branch came from, for the branches table. */
export function branchSource(branch: Branch) {
  switch (branch.created_via) {
    case "provider":
      return branch.provider ? providerName(branch.provider.provider) : "Git";
    case "cli":
      return "CLI";
    case "agent":
      return "Agent";
    case "dashboard":
      return "Dashboard";
    default:
      // The project's work from before branches existed.
      return "Original";
  }
}
