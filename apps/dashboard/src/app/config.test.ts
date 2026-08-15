import { describe, expect, it } from "vitest";
import { parsePublicConfig } from "./config";

const legacyAnonKey = [
  btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replaceAll("=", ""),
  btoa(JSON.stringify({ role: "anon", iss: "supabase" })).replaceAll("=", ""),
  "valid-signature-segment"
].join(".");

const legacyNoneKey = [
  btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replaceAll("=", ""),
  btoa(JSON.stringify({ role: "anon" })).replaceAll("=", ""),
  "invalid-signature-segment"
].join(".");

const webConfig = {
  VITE_API_URL: "http://localhost:3001",
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
  VITE_WEB_AUTH_CALLBACK_URL: "https://dashboard.example.com/auth/callback"
};

describe("parsePublicConfig", () => {
  it("requires and returns public Supabase web settings", () => {
    expect(parsePublicConfig(webConfig, "web")).toEqual({
      apiUrl: "http://localhost:3001",
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "sb_publishable_abcdefghijklmnopqrstuvwxyz123456",
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
    "http://api.example.com",
    "https://user:password@api.example.com",
    "https://@api.example.com",
    "https:\\api.example.com",
    "https://api.example.com/v1",
    "https://api.example.com?debug=1",
    "https://api.example.com#fragment",
    "ftp://api.example.com/",
    "javascript:alert(1)"
  ])("rejects an unsafe API URL for bearer transport: %s", (apiUrl) => {
    expect(() => parsePublicConfig({ ...webConfig, VITE_API_URL: apiUrl }, "web"))
      .toThrow("Dashboard configuration is invalid");
  });

  it.each(["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001", "https://api.example.com/"])(
    "allows secure or loopback root API URLs: %s",
    (apiUrl) => expect(parsePublicConfig({ ...webConfig, VITE_API_URL: apiUrl }, "web").apiUrl).toBe(apiUrl)
  );

  it.each([
    "http://project.supabase.co",
    "https://user:password@project.supabase.co",
    "https://@project.supabase.co",
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
    "https://@dashboard.example.com/auth/callback",
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

  it.each(["service_role", "sb_publishable_service_role_abcdefghijklmnopqrstuvwxyz", "sb_secret_example", "sk_test_secret", "supabase-service-role-key", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"])(
    "rejects an obvious secret key form: %s",
    (key) => {
      expect(() => parsePublicConfig({ ...webConfig, VITE_SUPABASE_PUBLISHABLE_KEY: key }, "web"))
        .toThrow("Dashboard configuration is invalid");
    }
  );


  it("accepts a structurally valid legacy anon JWT as a build-time guardrail", () => {
    expect(parsePublicConfig({ ...webConfig, VITE_SUPABASE_PUBLISHABLE_KEY: legacyAnonKey }, "web").supabasePublishableKey)
      .toBe(legacyAnonKey);
  });

  it.each([
    "arbitrary-public-looking-string",
    "anon",
    "sb_publishable_short",
    "sb_publishable_contains spaces and is invalid",
    "eyJhbGciOiJIUzI1NiJ9.not-base64.signature",
    "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoidXNlciJ9.signature",
    "one.two",
    ".eyJyb2xlIjoiYW5vbiJ9.signature",
    legacyNoneKey
  ])("rejects unsupported or malformed public key formats: %s", (key) => {
    expect(() => parsePublicConfig({ ...webConfig, VITE_SUPABASE_PUBLISHABLE_KEY: key }, "web"))
      .toThrow("Dashboard configuration is invalid");
  });

  it("rejects invalid common config", () => {
    expect(() => parsePublicConfig({ VITE_API_URL: "not-a-url" }, "desktop"))
      .toThrow("Dashboard configuration is invalid");
  });
});
