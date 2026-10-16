import { describe, expect, it } from "vitest";
import { parsePublicConfig } from "./config";

const webConfig = { VITE_API_URL: "http://localhost:8801" };

describe("parsePublicConfig", () => {
  it("needs only the API URL for the web dashboard", () => {
    expect(parsePublicConfig(webConfig, "web")).toEqual({
      apiUrl: "http://localhost:8801",
      e2eAuth: false,
      runtime: "web"
    });
  });

  it("uses the same settings for desktop", () => {
    expect(
      parsePublicConfig({ VITE_API_URL: "https://api.example.com" }, "desktop")
    ).toEqual({
      apiUrl: "https://api.example.com",
      e2eAuth: false,
      runtime: "desktop"
    });
  });

  it("ignores leftover Supabase settings", () => {
    expect(
      parsePublicConfig(
        {
          ...webConfig,
          VITE_SUPABASE_URL: "https://project.supabase.co",
          VITE_SUPABASE_PUBLISHABLE_KEY:
            "sb_publishable_abcdefghijklmnopqrstuvwxyz",
          VITE_WEB_AUTH_CALLBACK_URL: "http://localhost:8813/auth/callback"
        },
        "web"
      )
    ).toEqual({
      apiUrl: "http://localhost:8801",
      e2eAuth: false,
      runtime: "web"
    });
  });

  it("reads the e2e auth flag", () => {
    expect(
      parsePublicConfig({ ...webConfig, VITE_E2E_AUTH: "1" }, "web").e2eAuth
    ).toBe(true);
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
    expect(() =>
      parsePublicConfig({ ...webConfig, VITE_API_URL: apiUrl }, "web")
    ).toThrow("Dashboard configuration is invalid");
  });

  it.each([
    "http://localhost:8801",
    "http://127.0.0.1:8801",
    "http://[::1]:8801",
    "https://api.example.com/"
  ])("allows secure or loopback root API URLs: %s", (apiUrl) =>
    expect(
      parsePublicConfig({ ...webConfig, VITE_API_URL: apiUrl }, "web").apiUrl
    ).toBe(apiUrl)
  );

  it("defaults the web dashboard to the origin it was served from", () => {
    expect(
      parsePublicConfig({}, "web", "http://192.168.1.20:8801").apiUrl
    ).toBe("http://192.168.1.20:8801");
    expect(
      parsePublicConfig({ VITE_API_URL: "" }, "web", "https://orch.example")
        .apiUrl
    ).toBe("https://orch.example");
  });

  it("allows plain http on a LAN only for the dashboard's own origin", () => {
    expect(
      parsePublicConfig(
        { VITE_API_URL: "http://192.168.1.20:8801" },
        "web",
        "http://192.168.1.20:8801"
      ).apiUrl
    ).toBe("http://192.168.1.20:8801");
    expect(() =>
      parsePublicConfig(
        { VITE_API_URL: "http://192.168.1.21:8801" },
        "web",
        "http://192.168.1.20:8801"
      )
    ).toThrow("Dashboard configuration is invalid");
  });

  it("still needs an explicit API URL on desktop", () => {
    expect(() => parsePublicConfig({}, "desktop", "tauri://localhost")).toThrow(
      "Dashboard configuration is invalid"
    );
  });

  it("rejects invalid common config", () => {
    expect(() =>
      parsePublicConfig({ VITE_API_URL: "not-a-url" }, "desktop")
    ).toThrow("Dashboard configuration is invalid");
  });
});
