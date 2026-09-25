export const PROJECT_INVITATION_TOKEN_KEY =
  "orchestrat.project-invitation.token";

export const projectInvitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function invitationTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token && projectInvitationTokenPattern.test(token) ? token : null;
}

export function storedInvitationToken(): string | null {
  try {
    return invitationTokenFromHash(
      `#token=${window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY) ?? ""}`
    );
  } catch {
    return null;
  }
}

export function storeInvitationToken(token: string) {
  if (!projectInvitationTokenPattern.test(token)) return;
  try {
    window.sessionStorage.setItem(PROJECT_INVITATION_TOKEN_KEY, token);
  } catch {
    // The link remains usable while this page stays open when storage is unavailable.
  }
}

export function clearStoredInvitationToken() {
  try {
    window.sessionStorage.removeItem(PROJECT_INVITATION_TOKEN_KEY);
  } catch {
    // Clearing best-effort continuation state must not block a successful join.
  }
}
