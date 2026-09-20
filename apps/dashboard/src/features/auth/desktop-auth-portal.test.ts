import { describe, expect, it } from "vitest";
import {
  desktopAppCallback,
  desktopWebCallback,
  githubDesktopAuthUrl,
  parseDesktopAuthRequest
} from "./desktop-auth-portal";

const flowId = "desktop_flow_123456789";
const challenge = "a".repeat(43);

describe("desktop browser authentication handoff", () => {
  it("carries only the PKCE challenge to Supabase and only the one-time code to the app", () => {
    const request = parseDesktopAuthRequest(
      `?sb_flow_id=${flowId}&code_challenge=${challenge}&code_challenge_method=s256`
    );
    expect(request).toEqual({ flowId, challenge });
    const callback = desktopWebCallback("http://localhost:8813", flowId);
    const authorize = new URL(
      githubDesktopAuthUrl("https://project.supabase.co", request!, callback)
    );
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      provider: "github",
      redirect_to: callback,
      code_challenge: challenge,
      code_challenge_method: "s256"
    });
    expect(desktopAppCallback(`?sb_flow_id=${flowId}&code=single-use`)).toBe(
      `dev.orchestrat.app://auth/callback?sb_flow_id=${flowId}&code=single-use`
    );
  });

  it("returns dev sign-ins to the dev receiver instead of the installed app", () => {
    expect(
      desktopAppCallback("?sb_flow_id=" + flowId + "&code=single-use", true)
    ).toBe(
      "dev.orchestrat.app.local://auth/callback?sb_flow_id=" +
        flowId +
        "&code=single-use"
    );
    expect(
      desktopAppCallback(
        "?sb_flow_id=" + flowId + "&code=x&access_token=secret",
        true
      )
    ).toBeNull();
  });

  it("rejects duplicate, extra, mismatched, and token-bearing inputs", () => {
    expect(parseDesktopAuthRequest(`?sb_flow_id=${flowId}`)).toBeNull();
    expect(
      parseDesktopAuthRequest(
        `?sb_flow_id=${flowId}&code_challenge=${challenge}&code_challenge_method=s256&extra=x`
      )
    ).toBeNull();
    expect(
      desktopAppCallback(`?sb_flow_id=${flowId}&code=x&access_token=secret`)
    ).toBeNull();
    expect(
      desktopAppCallback(`?sb_flow_id=${flowId}&code=x&error=denied`)
    ).toBeNull();
  });
});
