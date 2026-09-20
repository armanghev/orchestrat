import { normalizeAuthEmail } from "./email";

export type DesktopAuthRequest = { flowId: string; challenge: string };

const flowPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const challengePattern = /^[A-Za-z0-9_-]{43}$/u;
const identifierPattern = /^[A-Za-z0-9_.-]{1,128}$/u;

export function parseDesktopAuthRequest(
  search: string
): DesktopAuthRequest | null {
  const params = new URLSearchParams(search);
  if (
    [...params].length !== 3 ||
    params.getAll("sb_flow_id").length !== 1 ||
    params.getAll("code_challenge").length !== 1 ||
    params.getAll("code_challenge_method").length !== 1
  )
    return null;
  const flowId = params.get("sb_flow_id") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  return flowPattern.test(flowId) &&
    challengePattern.test(challenge) &&
    params.get("code_challenge_method") === "s256"
    ? { flowId, challenge }
    : null;
}

export function desktopWebCallback(origin: string, flowId: string): string {
  const callback = new URL("/auth/desktop/callback", origin);
  callback.searchParams.set("sb_flow_id", flowId);
  return callback.toString();
}

export function githubDesktopAuthUrl(
  supabaseUrl: string,
  request: DesktopAuthRequest,
  callback: string
): string {
  const url = new URL("/auth/v1/authorize", supabaseUrl);
  url.searchParams.set("provider", "github");
  url.searchParams.set("redirect_to", callback);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

export async function sendDesktopMagicLink(
  supabaseUrl: string,
  publishableKey: string,
  request: DesktopAuthRequest,
  callback: string,
  value: string
): Promise<string> {
  const email = normalizeAuthEmail(value);
  if (!email) throw new Error("invalid_email");
  const url = new URL("/auth/v1/otp", supabaseUrl);
  url.searchParams.set("redirect_to", callback);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      data: {},
      gotrue_meta_security: {},
      create_user: true,
      code_challenge: request.challenge,
      code_challenge_method: "s256"
    })
  });
  if (!response.ok) throw new Error("provider_error");
  return email;
}

export function desktopAppCallback(
  search: string,
  development = false
): string | null {
  const source = new URLSearchParams(search);
  const allowed = new Set([
    "sb_flow_id",
    "code",
    "error",
    "error_code",
    "error_description"
  ]);
  if ([...source].some(([key]) => !allowed.has(key))) return null;
  for (const key of allowed) if (source.getAll(key).length > 1) return null;
  const flowId = source.get("sb_flow_id") ?? "";
  const code = source.get("code");
  const error = source.get("error");
  const errorCode = source.get("error_code");
  const description = source.get("error_description");
  const validError =
    error !== null &&
    code === null &&
    identifierPattern.test(error) &&
    (errorCode === null || identifierPattern.test(errorCode)) &&
    (description === null ||
      (description.length <= 512 && !/\p{Cc}/u.test(description)));
  const validCode =
    code !== null &&
    code.length > 0 &&
    code.length <= 2048 &&
    !/\p{Cc}/u.test(code) &&
    error === null &&
    errorCode === null &&
    description === null;
  if (!flowPattern.test(flowId) || (!validCode && !validError)) return null;
  const callback = new URL(
    development
      ? "dev.orchestrat.app.local://auth/callback"
      : "dev.orchestrat.app://auth/callback"
  );
  for (const key of allowed) {
    const value = source.get(key);
    if (value !== null) callback.searchParams.set(key, value);
  }
  return callback.toString();
}
