import { z } from "zod";

// Repository connection contracts (docs/project-branches.md §8). Imports only
// zod; see branches.ts for why.
const idSchema = z.string().uuid();
const dateSchema = z.string().datetime();

export const repositoryProviderSchema = z.enum(["github", "gitlab", "origin"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

export const repositoryConnectionStatusSchema = z.enum([
  "active",
  "needs_reauthorization",
  "suspended",
  "error",
  "disconnected"
]);
export type RepositoryConnectionStatus = z.infer<
  typeof repositoryConnectionStatusSchema
>;

export const repositoryConnectionSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  provider: repositoryProviderSchema,
  provider_repository_id: z.string().min(1).max(128),
  full_name: z.string(),
  url: z.string().nullable(),
  provider_default_branch: z.string(),
  status: repositoryConnectionStatusSchema,
  status_reason: z.string().nullable(),
  last_event_at: dateSchema.nullable(),
  last_reconciled_at: dateSchema.nullable(),
  connected_by_user_id: idSchema.nullable(),
  hook_health: z
    .object({
      alert_status: z.string().nullable(),
      disabled_until: dateSchema.nullable()
    })
    .nullable(),
  failed_delivery_count: z.number().int().nonnegative(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type RepositoryConnection = z.infer<typeof repositoryConnectionSchema>;

export const repositoryProviderAvailabilitySchema = z.object({
  provider: repositoryProviderSchema,
  configured: z.boolean(),
  unavailable_reason: z.string().nullable()
});
export type RepositoryProviderAvailability = z.infer<
  typeof repositoryProviderAvailabilitySchema
>;

export const repositoryResponseSchema = z.object({
  repository: repositoryConnectionSchema.nullable(),
  providers: z.array(repositoryProviderAvailabilitySchema)
});
export type RepositoryResponse = z.infer<typeof repositoryResponseSchema>;

/** Only same-origin dashboard paths are accepted as a post-callback target. */
const returnPathSchema = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9/_\-?=&.%]*$/)
  .refine((value) => !value.startsWith("//"), {
    message: "Return paths must stay on the dashboard origin."
  });

export const createRepositoryAuthorizationRequestSchema = z.object({
  provider: repositoryProviderSchema,
  return_path: returnPathSchema.optional()
});
export type CreateRepositoryAuthorizationRequest = z.infer<
  typeof createRepositoryAuthorizationRequestSchema
>;
export const repositoryAuthorizationResponseSchema = z.object({
  authorization_id: z.string().regex(/^ra_[A-Za-z0-9_-]{20,}$/),
  authorize_url: z.string().url(),
  expires_at: dateSchema
});
export type RepositoryAuthorizationResponse = z.infer<
  typeof repositoryAuthorizationResponseSchema
>;

export const repositoryAuthorizationParamsSchema = z.object({
  projectId: idSchema,
  authorizationId: z.string().regex(/^ra_[A-Za-z0-9_-]{20,}$/)
});

/** The GitHub Setup URL's installation_id is untrusted (spec §8.3). */
export const githubInstallationRequestSchema = z.object({
  installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/)
});
export type GithubInstallationRequest = z.infer<
  typeof githubInstallationRequestSchema
>;
export const githubInstallationResponseSchema = z.discriminatedUnion("next", [
  z.object({ next: z.literal("pick_repository") }),
  z.object({ next: z.literal("authorize"), authorize_url: z.string().url() })
]);
export type GithubInstallationResponse = z.infer<
  typeof githubInstallationResponseSchema
>;

export const repositoryCandidateSchema = z.object({
  provider_repository_id: z.string().min(1).max(128),
  full_name: z.string(),
  default_branch: z.string().nullable(),
  eligible: z.boolean(),
  ineligible_reason: z.string().nullable()
});
export type RepositoryCandidate = z.infer<typeof repositoryCandidateSchema>;
export const repositoryCandidatesResponseSchema = z.object({
  repositories: z.array(repositoryCandidateSchema)
});
export type RepositoryCandidatesResponse = z.infer<
  typeof repositoryCandidatesResponseSchema
>;

export const defaultBranchMappingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("rename_default") }),
  z.object({ mode: z.literal("use_existing"), branch_id: idSchema })
]);
export type DefaultBranchMapping = z.infer<typeof defaultBranchMappingSchema>;

export const connectRepositoryRequestSchema = z.object({
  authorization_id: z.string().regex(/^ra_[A-Za-z0-9_-]{20,}$/),
  provider_repository_id: z.string().min(1).max(128),
  default_branch_mapping: defaultBranchMappingSchema.default({
    mode: "rename_default"
  }),
  create_existing_branches: z.boolean().default(false)
});
export type ConnectRepositoryRequest = z.infer<
  typeof connectRepositoryRequestSchema
>;
export const repositoryConnectionResponseSchema = z.object({
  repository: repositoryConnectionSchema
});
export type RepositoryConnectionResponse = z.infer<
  typeof repositoryConnectionResponseSchema
>;

export const repositoryDeliveryStatusSchema = z.enum([
  "pending",
  "processing",
  "applied",
  "ignored",
  "failed"
]);
export type RepositoryDeliveryStatus = z.infer<
  typeof repositoryDeliveryStatusSchema
>;
export const repositoryDeliverySchema = z.object({
  id: idSchema,
  provider: repositoryProviderSchema,
  event_type: z.string(),
  status: repositoryDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  received_at: dateSchema,
  processed_at: dateSchema.nullable()
});
export type RepositoryDelivery = z.infer<typeof repositoryDeliverySchema>;
export const repositoryDeliveriesQuerySchema = z.object({
  status: repositoryDeliveryStatusSchema.optional()
});
export const repositoryDeliveriesResponseSchema = z.object({
  deliveries: z.array(repositoryDeliverySchema)
});
export type RepositoryDeliveriesResponse = z.infer<
  typeof repositoryDeliveriesResponseSchema
>;
export const repositoryDeliveryResponseSchema = z.object({
  delivery: repositoryDeliverySchema
});
export const repositoryDeliveryParamsSchema = z.object({
  projectId: idSchema,
  deliveryId: idSchema
});
export const repositorySyncResponseSchema = z.object({
  queued: z.literal(true)
});
