import { describe, expect, it } from "vitest";
import { cleanPreferences, defaultPreferences, parsePreferences } from "./preferences";

describe("preferences", () => {
  it("falls back from corrupt values and removes inaccessible project IDs", () => {
    expect(cleanPreferences({ theme: "orange" }, new Set())).toEqual(
      defaultPreferences
    );
    expect(
      cleanPreferences(
        {
          theme: "dark",
          railMode: "projects",
          pinnedProjectIds: ["pinned", "missing", "pinned"],
          recentProjectIds: ["recent", "pinned", "missing"],
          contextSidebarCollapsed: true
        },
        new Set(["pinned", "recent"])
      )
    ).toEqual({
      theme: "dark",
      railMode: "projects",
      pinnedProjectIds: ["pinned"],
      recentProjectIds: ["recent"],
      contextSidebarCollapsed: true
    });
  });

  it("parses valid IDs before the catalog is available and cleans only after reconciliation", () => {
    const stored = {
      theme: "dark",
      railMode: "projects",
      pinnedProjectIds: ["later"],
      recentProjectIds: ["also-later"],
      contextSidebarCollapsed: false
    };
    expect(parsePreferences(stored)).toEqual(stored);
    expect(cleanPreferences(stored, new Set())).toMatchObject({
      pinnedProjectIds: [],
      recentProjectIds: []
    });
  });

  it("keeps defaults and invalid fallbacks isolated from mutation", () => {
    expect(Object.isFrozen(defaultPreferences)).toBe(true);
    expect(Object.isFrozen(defaultPreferences.pinnedProjectIds)).toBe(true);
    expect(Object.isFrozen(defaultPreferences.recentProjectIds)).toBe(true);
    expect(() => defaultPreferences.pinnedProjectIds.push("poison")).toThrow();

    const invalid = cleanPreferences(null, new Set());
    invalid.pinnedProjectIds.push("poison");
    invalid.recentProjectIds.push("also-poison");

    expect(defaultPreferences.pinnedProjectIds).toEqual([]);
    expect(defaultPreferences.recentProjectIds).toEqual([]);
    expect(cleanPreferences(null, new Set())).toEqual(defaultPreferences);
  });
});
