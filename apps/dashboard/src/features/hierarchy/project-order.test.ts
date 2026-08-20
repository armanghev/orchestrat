import { describe, expect, it } from "vitest";
import { orderProjects } from "./project-order";

const ids = ["a", "b", "c", "d"];

describe("orderProjects", () => {
  it("orders pinned, recent, and remaining while pruning stale duplicates", () => {
    const result = orderProjects(ids, {
      pinnedProjectIds: ["c", "missing", "c"],
      recentProjectIds: ["b", "c", "missing", "b"]
    });
    expect(result).toEqual({
      visible: ["c", "b"],
      remaining: ["a", "d"],
      pinnedProjectIds: ["c"],
      recentProjectIds: ["b"]
    });
  });

  it("caps persisted pins and recents to accessible unique IDs", () => {
    const accessible = Array.from(
      { length: 25 },
      (_, index) => `project-${index}`
    );
    const result = orderProjects(accessible, {
      pinnedProjectIds: [
        "project-0",
        "project-1",
        "project-2",
        "project-3",
        "project-4",
        "project-5",
        "project-6",
        "project-7",
        "project-8"
      ],
      recentProjectIds: ["project-0", ...accessible.slice(8), "missing"]
    });

    expect(result.pinnedProjectIds).toEqual(accessible.slice(0, 8));
    expect(result.recentProjectIds).toEqual(accessible.slice(8, 20));
    expect(result.visible).toEqual(accessible.slice(0, 10));
    expect(result.remaining).toEqual(accessible.slice(20));
  });

  it("promotes a selected project to the front of recents without moving pins", () => {
    const result = orderProjects(ids, {
      pinnedProjectIds: ["a"],
      recentProjectIds: ["b", "c"],
      selectedProjectId: "d"
    });
    expect(result.recentProjectIds).toEqual(["d", "b", "c"]);
    expect(result.visible).toEqual(["a", "d", "b", "c"]);
  });
});
