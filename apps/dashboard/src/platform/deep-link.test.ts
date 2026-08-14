import { describe, expect, it } from "vitest";
import { normalizeAuthCallback } from "./tauri";

describe("normalizeAuthCallback", () => {
  it("accepts only the registered auth callback shape", () => {
    expect(
      normalizeAuthCallback(
        "dev.orchestrat.app://auth/callback?code=abc&state=xyz"
      ).toString()
    ).toBe("dev.orchestrat.app://auth/callback?code=abc&state=xyz");
    expect(() => normalizeAuthCallback("https://evil.test/auth/callback")).toThrow(
      "Unexpected authentication callback"
    );
    expect(() => normalizeAuthCallback("dev.orchestrat.app://settings")).toThrow(
      "Unexpected authentication callback"
    );
  });

  it.each([
    "dev.orchestrat.app://auth:444/callback",
    "dev.orchestrat.app://user@auth/callback",
    "dev.orchestrat.app://user:password@auth/callback",
    "dev.orchestrat.app://auth/callback#fragment"
  ])("rejects unsafe callback URL components: %s", (input) => {
    expect(() => normalizeAuthCallback(input)).toThrow(
      "Unexpected authentication callback"
    );
  });
});
