import { describe, expect, it } from "vitest";
import { routeTree } from "@/routeTree.gen";

describe("desktop auth route hierarchy", () => {
  it("mounts the callback beside the portal so the portal cannot intercept it", () => {
    const callback = Object.values(routeTree.children ?? {}).find(
      (route) => route.options.id === "/auth/desktop_/callback"
    );
    expect(callback?.options.path).toBe("/auth/desktop/callback");
    expect(callback?.options.getParentRoute?.()).toBe(routeTree);
  });
});
