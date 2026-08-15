import { z } from "zod";

const baseSchema = z.object({
  VITE_API_URL: z.url(),
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
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  try { return new URL(value); } catch { return null; }
}

function isSupabaseProjectUrl(value: unknown): value is string {
  const url = cleanUrl(value);
  return url !== null && url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.pathname === "/" && url.search === "" && url.hash === "";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isWebCallbackUrl(value: unknown): value is string {
  const url = cleanUrl(value);
  if (!url || url.username || url.password || url.pathname !== "/auth/callback" || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function jwtRole(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as unknown;
    if (typeof payload === "object" && payload !== null && "role" in payload && typeof payload.role === "string") return payload.role;
  } catch { /* A malformed public key is handled by Supabase. */ }
  return null;
}

function isPublicSupabaseKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value !== value.trim()) return false;
  const lower = value.toLowerCase();
  return !lower.includes("service_role") && !lower.includes("service-role") &&
    !lower.startsWith("sb_secret_") && !lower.startsWith("sk_") && !lower.includes("secret-key") &&
    jwtRole(value) !== "service_role";
}

export function parsePublicConfig(
  input: Record<string, string | boolean | undefined>,
  runtime: PublicConfig["runtime"]
): PublicConfig {
  const common = baseSchema.safeParse(input);
  const validWeb = runtime === "desktop" || (
    isSupabaseProjectUrl(input.VITE_SUPABASE_URL) &&
    isPublicSupabaseKey(input.VITE_SUPABASE_PUBLISHABLE_KEY) &&
    isWebCallbackUrl(input.VITE_WEB_AUTH_CALLBACK_URL)
  );
  if (!common.success || !validWeb) throw new Error("Dashboard configuration is invalid.");

  return {
    apiUrl: common.data.VITE_API_URL,
    supabaseUrl: runtime === "web" ? input.VITE_SUPABASE_URL as string : null,
    supabasePublishableKey: runtime === "web" ? input.VITE_SUPABASE_PUBLISHABLE_KEY as string : null,
    webAuthCallbackUrl: runtime === "web" ? input.VITE_WEB_AUTH_CALLBACK_URL as string : null,
    e2eAuth: common.data.VITE_E2E_AUTH === "1",
    runtime
  };
}
