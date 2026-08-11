import { z } from "zod";

export const apiConfigSchema = z.object({
  ORCHESTRAT_API_HOST: z.string().default("0.0.0.0"),
  ORCHESTRAT_API_PORT: z.coerce.number().int().positive().default(3001)
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export const loadApiConfig = (
  env: NodeJS.ProcessEnv = process.env
): ApiConfig => apiConfigSchema.parse(env);
