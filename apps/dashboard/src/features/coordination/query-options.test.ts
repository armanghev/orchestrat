import { describe, expect, it } from "vitest";
import { coordinationKeys } from "./query-options";

describe("coordination query keys", () => {
  it("keeps infinite activity pages separate from the normal event list", () => {
    expect(coordinationKeys.eventsInfinite("project-1")).not.toEqual(
      coordinationKeys.events("project-1")
    );
    expect(coordinationKeys.eventsInfinite("project-1")).toEqual([
      "coordination",
      "events",
      "project-1",
      "infinite"
    ]);
  });
});
