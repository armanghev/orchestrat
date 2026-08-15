import { z } from "zod";

const baseSchema = z.object({
  VITE_API_URL: z.string(),
  VITE_E2E_AUTH: z.enum(["0", "1"]).optional()
});

export type PublicConfig = {
  apiUrl: string;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  webAuthCallbackUrl: string | null;
  e2eAuth: boolean;
  runtime: "desktop" | "web";
};

function cleanUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}

function hasAuthorityCredentials(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const authorityStart = value.indexOf("://") + 3;
  const authority = value.slice(authorityStart).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

function isSupabaseProjectUrl(value: unknown): value is string {
  const url = cleanUrl(value);
  return url !== null && !hasAuthorityCredentials(value) && url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.pathname === "/" && url.search === "" && url.hash === "";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isApiRootUrl(value: unknown): value is string {
  const url = cleanUrl(value);
  if (!url || hasAuthorityCredentials(value) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function isWebCallbackUrl(value: unknown): value is string {
  const url = cleanUrl(value);
  if (!url || hasAuthorityCredentials(value) || url.username || url.password || url.pathname !== "/auth/callback" || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function parseJwtObject(part: string): Record<string, unknown> | null {
  if (part.length === 0 || part.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isLegacyAnonKey(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{8,4096}$/.test(parts[2] ?? "")) return false;
  const header = parseJwtObject(parts[0] ?? "");
  const payload = parseJwtObject(parts[1] ?? "");
  return header?.alg === "HS256" && payload?.role === "anon";
}

function isPublicSupabaseKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || value !== value.trim()) return false;
  // This is a build-time guardrail against secret formats, not proof that a key is safe or correctly scoped.
  const lower = value.toLowerCase();
  if (lower.includes("service_role") || lower.includes("service-role") || lower.includes("secret-key")) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{20,256}$/.test(value)) return true;
  return !lower.startsWith("sb_secret_") && isLegacyAnonKey(value);
}

export function parsePublicConfig(
  input: Record<string, string | boolean | undefined>,
  runtime: PublicConfig["runtime"]
): PublicConfig {
  const common = baseSchema.safeParse(input);
  const validCommon = common.success && isApiRootUrl(input.VITE_API_URL);
  const validWeb = runtime === "desktop" || (
    isSupabaseProjectUrl(input.VITE_SUPABASE_URL) &&
    isPublicSupabaseKey(input.VITE_SUPABASE_PUBLISHABLE_KEY) &&
    isWebCallbackUrl(input.VITE_WEB_AUTH_CALLBACK_URL)
  );
  if (!validCommon || !validWeb) throw new Error("Dashboard configuration is invalid.");

  return {
    apiUrl: common.data.VITE_API_URL,
    supabaseUrl: runtime === "web" ? input.VITE_SUPABASE_URL as string : null,
    supabasePublishableKey: runtime === "web" ? input.VITE_SUPABASE_PUBLISHABLE_KEY as string : null,
    webAuthCallbackUrl: runtime === "web" ? input.VITE_WEB_AUTH_CALLBACK_URL as string : null,
    e2eAuth: common.data.VITE_E2E_AUTH === "1",
    runtime
  };
}
