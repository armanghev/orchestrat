import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_INVITATION_TOKEN_KEY,
  clearStoredInvitationToken,
  invitationTokenFromHash,
  storeInvitationToken,
  storedInvitationToken
} from "./project-invitation-token";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("project invitation token storage", () => {
  it("accepts only an opaque token carried in the fragment", () => {
    const token = "a".repeat(43);
    expect(invitationTokenFromHash(`#token=${token}`)).toBe(token);
    expect(invitationTokenFromHash("#token=short")).toBeNull();
    expect(invitationTokenFromHash(`#token=${token}&extra=value`)).toBe(token);
  });

  it("retains a valid token through sign-in and clears it after joining", () => {
    const token = "b".repeat(43);
    storeInvitationToken(token);
    expect(window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)).toBe(
      token
    );
    expect(storedInvitationToken()).toBe(token);
    clearStoredInvitationToken();
    expect(storedInvitationToken()).toBeNull();
  });
});
