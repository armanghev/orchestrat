import { z } from "zod";

export const apiConfigSchema = z.object({
  ORCHESTRAT_API_HOST: z.string().default("0.0.0.0"),
  ORCHESTRAT_API_PORT: z.coerce.number().int().min(1).max(65535).default(8801),
  ORCHESTRAT_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  ORCHESTRAT_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:8813")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
  ORCHESTRAT_DATABASE_URL: z.string().min(1),
  // Who may create an account once the first (admin) account exists:
  // invite = only with a project invite link, open = anyone who can reach
  // the server, closed = admins create accounts with orchestrat-admin.
  ORCHESTRAT_SIGNUP: z.enum(["invite", "open", "closed"]).default("invite"),
  // Creating the first account needs this token. Unset, the server makes a
  // fresh one at startup and prints it while the instance has no accounts.
  ORCHESTRAT_SETUP_TOKEN: z.string().trim().min(16).max(512).optional()
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export const loadApiConfig = (
  env: NodeJS.ProcessEnv = process.env
): ApiConfig =>
  apiConfigSchema.parse({
    ...env,
    ORCHESTRAT_API_HOST: env.ORCHESTRAT_API_HOST ?? env.HOST,
    ORCHESTRAT_API_PORT: env.ORCHESTRAT_API_PORT ?? env.PORT
  });

export * from "./repository.js";
