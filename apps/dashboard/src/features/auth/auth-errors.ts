import { AuthRequestError } from "./auth-client";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
export const FULL_NAME_MAX_LENGTH = 120;

export function newPasswordProblem(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (value.length > PASSWORD_MAX_LENGTH)
    return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  return null;
}

export function fullNameProblem(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return "Enter your name.";
  if (name.length > FULL_NAME_MAX_LENGTH)
    return `Use ${FULL_NAME_MAX_LENGTH} characters or fewer.`;
  return null;
}

export function errorCode(error: unknown): string {
  return error instanceof AuthRequestError ? error.code : "UNKNOWN";
}

function waitHint(error: unknown): string {
  const seconds =
    error instanceof AuthRequestError ? error.retryAfterSeconds : null;
  if (!seconds) return "Try again in a minute.";
  return `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

/** Plain-language copy for errors that aren't tied to one field. */
export function authErrorMessage(
  error: unknown,
  context: "signIn" | "signUp" | "setup" | "password" | "session"
): string {
  switch (errorCode(error)) {
    case "INVALID_CREDENTIALS":
      return "Email or password is incorrect.";
    case "RATE_LIMITED":
      return context === "signIn"
        ? `Too many sign-in attempts. ${waitHint(error)}`
        : `Too many attempts. ${waitHint(error)}`;
    case "SIGNUP_CLOSED":
      return "This server doesn't allow new accounts. Ask an admin to create your account.";
    case "INVITE_REQUIRED":
      return "Ask a teammate for an invite link.";
    case "VALIDATION_ERROR":
      return "Some details aren't valid. Check them and try again.";
    case "NETWORK_ERROR":
      return "We couldn't reach the server. Check your connection and try again.";
    case "UNAUTHENTICATED":
      return "Your session has ended. Sign in again.";
    default:
      return context === "signIn"
        ? "We couldn't sign you in. Try again."
        : "Something went wrong. Try again.";
  }
}
