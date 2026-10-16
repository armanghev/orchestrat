import type { Branch, RepositoryProvider } from "@orchestrat/protocol";

// Plain-language copy for the repository settings.

export const providerLabels: Record<RepositoryProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab.com",
  origin: "Cursor Origin"
};

/** The pending GitHub attempt, for the Setup URL route. */
export const REPOSITORY_ATTEMPT_KEY = "orchestrat.repository.attempt";
export const authorizationPattern = /^ra_[A-Za-z0-9_-]{20,}$/;

/** Why a provider callback came back without an authorization. */
export function callbackErrorMessage(code: string) {
  switch (code) {
    case "invalid_state":
      return "That connection link was invalid or already used. Start again.";
    case "expired":
      return "Connecting took too long and the link expired. Start again.";
    case "authorization_failed":
      return "The provider didn’t finish authorizing Orchestrat. Start again.";
    default:
      return "Connecting the repository didn’t finish. Start again.";
  }
}

/**
 * How connecting links the Orchestrat default branch to the provider's
 * default `D`:
 * - link: the default is already named D;
 * - rename: no active branch is named D, so the default is renamed to D;
 * - choose: another active branch is named D; keep the default's work as D
 *   (archiving the other) or make that branch the default.
 */
export type MappingCase =
  | { kind: "link"; name: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "choose"; from: string; to: string; existing: Branch };

export function mappingCase(
  branches: Branch[],
  providerDefault: string | null
): MappingCase {
  const current = branches.find((branch) => branch.is_default);
  const from = current?.name ?? "main";
  if (!providerDefault || providerDefault === from)
    return { kind: "link", name: from };
  const existing = branches.find(
    (branch) =>
      !branch.archived_at &&
      !branch.is_default &&
      branch.name === providerDefault
  );
  return existing
    ? { kind: "choose", from, to: providerDefault, existing }
    : { kind: "rename", from, to: providerDefault };
}
