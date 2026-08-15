import { describe, expect, it } from "vitest";
import { parsePublicConfig } from "./config";

const webConfig = {
  VITE_API_URL: "http://localhost:3001",
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-placeholder",
  VITE_WEB_AUTH_CALLBACK_URL: "https://dashboard.example.com/auth/callback"
};

describe("parsePublicConfig", () => {
  it("requires and returns public Supabase web settings", () => {
    expect(parsePublicConfig(webConfig, "web")).toEqual({
      apiUrl: "http://localhost:3001",
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "sb_publishable_test-placeholder",
      webAuthCallbackUrl: "https://dashboard.example.com/auth/callback",
      e2eAuth: false,
      runtime: "web"
    });
  });

  it("does not require browser auth settings for desktop", () => {
    expect(parsePublicConfig({ VITE_API_URL: "https://api.example.com" }, "desktop")).toEqual({
      apiUrl: "https://api.example.com",
      supabaseUrl: null,
      supabasePublishableKey: null,
      webAuthCallbackUrl: null,
      e2eAuth: false,
      runtime: "desktop"
    });
  });

  it.each([
    "http://project.supabase.co",
    "https://user:password@project.supabase.co",
    "https://project.supabase.co/rest/v1",
    "https://project.supabase.co?debug=1",
    "https://project.supabase.co#fragment"
  ])("rejects an unsafe Supabase project URL: %s", (supabaseUrl) => {
    expect(() => parsePublicConfig({ ...webConfig, VITE_SUPABASE_URL: supabaseUrl }, "web"))
      .toThrow("Dashboard configuration is invalid");
  });

  it.each([
    "http://dashboard.example.com/auth/callback",
    "https://user@dashboard.example.com/auth/callback",
    "https://dashboard.example.com/auth/callback/extra",
    "https://dashboard.example.com/auth/callback?code=x",
    "https://dashboard.example.com/auth/callback#fragment"
  ])("rejects an unsafe web callback URL: %s", (callbackUrl) => {
    expect(() => parsePublicConfig({ ...webConfig, VITE_WEB_AUTH_CALLBACK_URL: callbackUrl }, "web"))
      .toThrow("Dashboard configuration is invalid");
  });

  it.each([
    "http://localhost:5173/auth/callback",
    "http://127.0.0.1:5173/auth/callback",
    "http://[::1]:5173/auth/callback"
  ])("allows loopback HTTP callbacks: %s", (callbackUrl) => {
    expect(parsePublicConfig({ ...webConfig, VITE_WEB_AUTH_CALLBACK_URL: callbackUrl }, "web").webAuthCallbackUrl)
      .toBe(callbackUrl);
  });

  it.each(["service_role", "sb_secret_example", "sk_test_secret", "supabase-service-role-key", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"])(
    "rejects an obvious secret key form: %s",
    (key) => {
      expect(() => parsePublicConfig({ ...webConfig, VITE_SUPABASE_PUBLISHABLE_KEY: key }, "web"))
        .toThrow("Dashboard configuration is invalid");
    }
  );

  it("rejects invalid common config", () => {
    expect(() => parsePublicConfig({ VITE_API_URL: "not-a-url" }, "desktop"))
      .toThrow("Dashboard configuration is invalid");
  });
});
