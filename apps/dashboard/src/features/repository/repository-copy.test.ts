import { describe, expect, it } from "vitest";
import { branch } from "@/test/factories";
import { mappingCase } from "./repository-copy";

describe("default-branch mapping on connect", () => {
  const main = branch();
  const trunk = branch({
    id: "00000000-0000-4000-8000-000000000051",
    name: "trunk",
    is_default: false
  });

  it("links when the default already has the provider's name", () => {
    expect(mappingCase([main, trunk], "main")).toEqual({
      kind: "link",
      name: "main"
    });
    // An empty repository has no default yet: nothing is renamed.
    expect(mappingCase([main], null)).toEqual({ kind: "link", name: "main" });
  });

  it("renames the default when no active branch has the provider's name", () => {
    expect(mappingCase([main], "trunk")).toEqual({
      kind: "rename",
      from: "main",
      to: "trunk"
    });
    // An archived namesake doesn't count.
    expect(
      mappingCase(
        [main, { ...trunk, archived_at: "2026-09-01T00:00:00.000Z" }],
        "trunk"
      ).kind
    ).toBe("rename");
  });

  it("asks which branch wins when an active namesake exists", () => {
    expect(mappingCase([main, trunk], "trunk")).toEqual({
      kind: "choose",
      from: "main",
      to: "trunk",
      existing: trunk
    });
  });
});
