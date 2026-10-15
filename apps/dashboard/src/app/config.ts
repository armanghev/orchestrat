import { z } from "zod";

const baseSchema = z.object({
  VITE_API_URL: z.string().optional(),
  VITE_E2E_AUTH: z.enum(["0", "1"]).optional()
});

export type PublicConfig = {
  apiUrl: string;
  e2eAuth: boolean;
  runtime: "desktop" | "web";
};

function cleanUrl(value: unknown): URL | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  )
    return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasAuthorityCredentials(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const authorityStart = value.indexOf("://") + 3;
  const authority = value.slice(authorityStart).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function httpOrigin(value: string | undefined) {
  const url = cleanUrl(value);
  return url && /^https?:$/.test(url.protocol) ? url.origin : null;
}

// pageOrigin is where this dashboard was loaded from: plain http is fine
// for the API when it is that same origin (a self-hosted server on a LAN).
function isApiRootUrl(value: unknown, pageOrigin?: string): value is string {
  const url = cleanUrl(value);
  if (
    !url ||
    hasAuthorityCredentials(value) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return false;
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (isLoopback(url.hostname) ||
        (pageOrigin !== undefined && url.origin === httpOrigin(pageOrigin))))
  );
}

// Without VITE_API_URL the web dashboard talks to the origin it was served
// from, which is how the self-hosted server ships it.
export function parsePublicConfig(
  input: Record<string, string | boolean | undefined>,
  runtime: PublicConfig["runtime"],
  pageOrigin?: string
): PublicConfig {
  const common = baseSchema.safeParse(input);
  const configured = common.success ? common.data.VITE_API_URL : undefined;
  const apiUrl =
    configured ||
    (runtime === "web" ? (httpOrigin(pageOrigin) ?? undefined) : undefined);
  if (!common.success || !apiUrl || !isApiRootUrl(apiUrl, pageOrigin))
    throw new Error("Dashboard configuration is invalid.");

  return {
    apiUrl,
    e2eAuth: common.data.VITE_E2E_AUTH === "1",
    runtime
  };
}
