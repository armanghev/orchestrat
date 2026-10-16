import type {
  MergeChoice,
  MergeItemType,
  MergePreview,
  MergePreviewItem
} from "@orchestrat/protocol";

// Import selection rules. The person picks items by lineage key; tasks bring
// the tasks they depend on.

export type ImportSelection = Record<MergeItemType, ReadonlySet<string>>;

export const emptySelection = (): ImportSelection => ({
  task: new Set(),
  document: new Set(),
  chat: new Set()
});

/** Items an import can still change. Identical items, items kept as the
 * target has them and blocked items (a wider audience, a cycle, too large)
 * can't be chosen. */
export const isSelectable = (item: MergePreviewItem) =>
  item.outcome === "copy" ||
  item.outcome === "apply" ||
  item.outcome === "conflict";

export function selectAll(items: MergePreviewItem[]): ImportSelection {
  const selection = emptySelection();
  for (const item of items)
    if (isSelectable(item))
      (selection[item.item_type] as Set<string>).add(item.lineage_key);
  return selection;
}

/**
 * The tasks an import will bring: the chosen ones plus every task they
 * require, transitively. `required_by` comes from a preview of everything,
 * so it lists every dependent.
 */
export function withRequiredTasks(
  items: MergePreviewItem[],
  chosen: ReadonlySet<string>
) {
  const tasks = items.filter((item) => item.item_type === "task");
  const included = new Set(chosen);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of tasks)
      if (
        !included.has(task.lineage_key) &&
        task.required_by.some((dependent) => included.has(dependent))
      ) {
        included.add(task.lineage_key);
        changed = true;
      }
  }
  return included;
}

/** The included tasks that require this one; while any is chosen it stays
 * locked in. */
export function requiredBy(
  task: MergePreviewItem,
  included: ReadonlySet<string>
) {
  return task.required_by.filter((dependent) => included.has(dependent));
}

/** The request's selection: only what the person chose, since the API adds
 * required tasks itself. Lists are sorted so equal selections compare equal. */
export function selectionRequest(selection: ImportSelection) {
  return {
    tasks: [...selection.task].sort(),
    documents: [...selection.document].sort(),
    chats: [...selection.chat].sort()
  };
}

export const selectionSize = (selection: ImportSelection) =>
  selection.task.size + selection.document.size + selection.chat.size;

/** Drops chosen items that the source no longer has. */
export function pruneSelection(
  selection: ImportSelection,
  items: MergePreviewItem[]
): ImportSelection {
  const present = new Set(
    items
      .filter(isSelectable)
      .map((item) => `${item.item_type}:${item.lineage_key}`)
  );
  const kept = emptySelection();
  for (const type of ["task", "document", "chat"] as const)
    for (const key of selection[type])
      if (present.has(`${type}:${key}`)) (kept[type] as Set<string>).add(key);
  return kept;
}

const conflictSignature = (item: MergePreviewItem) =>
  JSON.stringify([
    item.reason,
    item.fields,
    item.source_values,
    item.target_values
  ]);

/**
 * Carries choices from the preview the person last saw to a newer one. A
 * conflict that is still the same keeps its choice. One whose values changed
 * loses it and is reported in `changed`, to be highlighted. One that wasn't a
 * conflict before, say because an item was added to the selection, is reported
 * in `added`: it simply has no choice yet.
 */
export function carryChoices(
  before: MergePreview | undefined,
  after: MergePreview,
  choices: Readonly<Record<string, MergeChoice>>
) {
  const previous = new Map(
    (before?.items ?? [])
      .filter((item) => item.outcome === "conflict")
      .map((item) => [item.lineage_key, conflictSignature(item)])
  );
  const kept: Record<string, MergeChoice> = {};
  const changed = new Set<string>();
  const added = new Set<string>();
  for (const item of after.items) {
    if (item.outcome !== "conflict") continue;
    const signature = previous.get(item.lineage_key);
    const choice = choices[item.lineage_key];
    if (signature === undefined) added.add(item.lineage_key);
    else if (signature !== conflictSignature(item))
      changed.add(item.lineage_key);
    else if (choice) kept[item.lineage_key] = choice;
  }
  return { choices: kept, changed, added };
}
