import { z } from "zod";

const baseSchema = z.object({
  VITE_API_URL: z.url(),
  VITE_E2E_AUTH: z.enum(["0", "1"]).optional()
});

export type PublicConfig = {
  apiUrl: string;
  clerkPublishableKey: string | null;
  e2eAuth: boolean;
  runtime: "desktop" | "web";
};

export function parsePublicConfig(
  input: Record<string, string | boolean | undefined>,
  runtime: PublicConfig["runtime"]
): PublicConfig {
  const common = baseSchema.safeParse(input);
  const clerk =
    runtime === "web"
      ? z.string().min(1).safeParse(input.VITE_CLERK_PUBLISHABLE_KEY)
      : { success: true as const, data: null };
  if (!common.success || !clerk.success)
    throw new Error("Dashboard configuration is invalid.");

  return {
    apiUrl: common.data.VITE_API_URL,
    clerkPublishableKey: clerk.data,
    e2eAuth: common.data.VITE_E2E_AUTH === "1",
    runtime
  };
}
