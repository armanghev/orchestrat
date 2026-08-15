import { describe, expect, it } from "vitest";
import { normalizeAuthCallback } from "./tauri";

describe("normalizeAuthCallback", () => {
  it("accepts only the registered auth callback shape", () => {
    expect(
      normalizeAuthCallback(
        "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=xyz"
      ).toString()
    ).toBe("dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=xyz");
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

  it("accepts only correlated bounded Supabase callback query shapes", () => {
    expect(normalizeAuthCallback("dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_123").toString())
      .toBe("dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=flow_123");
    expect(normalizeAuthCallback("dev.orchestrat.app://auth/callback?error=access_denied&error_code=provider_denied&error_description=Nope&sb_flow_id=flow_123").toString())
      .toContain("error=access_denied");
    for (const input of [
      "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=legacy&sb_flow_id=f",
      "dev.orchestrat.app://auth/callback?code=a&code=b&sb_flow_id=f",
      "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=f&sb_flow_id=g",
      "dev.orchestrat.app://auth/callback?code=a&error=no&sb_flow_id=f",
      "dev.orchestrat.app://auth/callback?error=no&sb_flow_id=f&unknown=x",
      `dev.orchestrat.app://auth/callback?code=${"a".repeat(2049)}&sb_flow_id=f`,
      "dev.orchestrat.app://auth/callback?code=a%00b&sb_flow_id=f"
    ]) expect(() => normalizeAuthCallback(input)).toThrow("Unexpected authentication callback");
  });
});
