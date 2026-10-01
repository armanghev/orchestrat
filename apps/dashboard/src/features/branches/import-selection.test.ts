import { describe, expect, it } from "vitest";
import type { MergePreview, MergePreviewItem } from "@orchestrat/protocol";
import {
  carryChoices,
  emptySelection,
  pruneSelection,
  requiredBy,
  selectAll,
  selectionRequest,
  withRequiredTasks
} from "./import-selection";

const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(
  n: number,
  overrides: Partial<MergePreviewItem> = {}
): MergePreviewItem {
  return {
    item_type: "task",
    lineage_key: key(n),
    source_id: key(n),
    target_id: null,
    outcome: "copy",
    reason: null,
    fields: [],
    required_by: [],
    label: `Task ${n}`,
    task_key: `DASH-${n}`,
    audience: null,
    source_values: null,
    target_values: null,
    ...overrides
  };
}

const preview = (items: MergePreviewItem[]): MergePreview => ({
  fingerprint: "a".repeat(64),
  kind: "import",
  source_branch_id: key(90),
  target_branch_id: key(91),
  items,
  counts: {}
});

describe("import selection", () => {
  // 3 depends on 2, which depends on 1; 4 stands alone.
  const tasks = [
    item(1, { required_by: [key(2)] }),
    item(2, { required_by: [key(3)] }),
    item(3),
    item(4)
  ];

  it("brings every required task along, transitively", () => {
    const included = withRequiredTasks(tasks, new Set([key(3)]));
    expect([...included].sort()).toEqual([key(1), key(2), key(3)]);
    expect(requiredBy(tasks[0]!, included)).toEqual([key(2)]);
    expect(withRequiredTasks(tasks, new Set([key(4)]))).toEqual(
      new Set([key(4)])
    );
  });

  it("only offers items an import can change", () => {
    const selection = selectAll([
      item(1),
      item(2, { outcome: "unchanged" }),
      item(3, { outcome: "keep_target" }),
      item(4, {
        item_type: "chat",
        outcome: "skipped",
        reason: "audience_would_widen"
      }),
      item(5, { item_type: "document", outcome: "conflict" })
    ]);
    expect(selectionRequest(selection)).toEqual({
      tasks: [key(1)],
      documents: [key(5)],
      chats: []
    });
  });

  it("drops chosen items the source no longer has", () => {
    const selection = emptySelection();
    (selection.task as Set<string>).add(key(1)).add(key(2));
    expect(
      selectionRequest(pruneSelection(selection, [item(2), item(3)]))
    ).toEqual({ tasks: [key(2)], documents: [], chats: [] });
  });

  it("keeps choices for unchanged conflicts and clears changed ones", () => {
    const conflict = (n: number, target: string) =>
      item(n, {
        item_type: "document",
        outcome: "conflict",
        reason: "changed_on_both",
        fields: ["body"],
        source_values: { body: "source" },
        target_values: { body: target }
      });
    const before = preview([conflict(1, "a"), conflict(2, "b")]);
    const after = preview([
      conflict(1, "a"),
      conflict(2, "c"),
      conflict(3, "d")
    ]);
    const { choices, changed } = carryChoices(before, after, {
      [key(1)]: "use_source",
      [key(2)]: "use_target"
    });
    expect(choices).toEqual({ [key(1)]: "use_source" });
    // Changed and new conflicts both need a fresh look.
    expect(changed).toEqual(new Set([key(2), key(3)]));
  });
});
