import { describe, expect, it } from "vitest";
import { parsePublicConfig } from "./config";

describe("parsePublicConfig", () => {
  it("requires only the values used by the selected runtime", () => {
    expect(
      parsePublicConfig(
        {
          VITE_API_URL: "http://localhost:3001",
          VITE_CLERK_PUBLISHABLE_KEY: "pk_test_example"
        },
        "web"
      )
    ).toEqual({
      apiUrl: "http://localhost:3001",
      clerkPublishableKey: "pk_test_example",
      e2eAuth: false,
      runtime: "web"
    });

    expect(() =>
      parsePublicConfig({ VITE_API_URL: "not-a-url" }, "desktop")
    ).toThrow("Dashboard configuration is invalid");
  });
});
