import { z } from "zod";

export const apiConfigSchema = z.object({
  ORCHESTRAT_API_HOST: z.string().default("0.0.0.0"),
  ORCHESTRAT_API_PORT: z.coerce.number().int().positive().default(3001),
  ORCHESTRAT_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
  ORCHESTRAT_DATABASE_URL: z.string().min(1),
  ORCHESTRAT_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  ORCHESTRAT_CLERK_SECRET_KEY: z.string().min(1)
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export const loadApiConfig = (
  env: NodeJS.ProcessEnv = process.env
): ApiConfig => apiConfigSchema.parse(env);
